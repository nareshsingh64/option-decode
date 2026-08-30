#!/bin/bash
#
# Point-in-time restore of the LOCAL option_decode database from binlogs.
#
# Why this exists
# ---------------
# On 2026-08-30 a `prisma migrate dev` run against this database detected drift
# (the deferred OptionContractTick index drop, applied out-of-band by design)
# and, with no TTY to prompt, reset the database - dropping and recreating all
# 38 tables. The local DB is NOT disposable: sync-prod-db.sh appends and never
# deletes precisely because production prunes at SNAPSHOT_RETENTION_DAYS=30, so
# for anything older than ~30 days local is the only copy in existence.
#
# NEVER run `prisma migrate dev` against this database. Use
# `prisma migrate diff` to generate the SQL and apply it directly - that is what
# the accompanying Live Order migration did, safely, minutes later.
#
# What it does
# ------------
# Replays every binlog from the start of retained history up to the instant
# BEFORE the reset, restoring the database to its 2026-08-30 19:55:00 state.
#
#   --database=option_decode   drops the prisma shadow-database DDL on the floor
#   no --force                 a restore that silently skips failing statements
#                              is worse than one that stops and says so
#
# Binlogs are ROW format with a 30-day retention (binlog_expire_logs_seconds),
# so this window closes around 2026-09-02. After that the only recovery is
# sync-prod-db.sh, which cannot reach further back than production's own 30 days.
#
# Usage:  scripts/restore-local-from-binlog.sh [stop-datetime]
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"
BINLOG_DIR="${BINLOG_DIR:-/opt/homebrew/var/mysql}"
STOP_AT="${1:-2026-08-30 19:55:00}"
LOG="${RESTORE_LOG:-$REPO_ROOT/.restore-binlog.log}"

# .env.local cannot be sourced - the same trap .env.production has, where an
# unquoted value containing a shell metacharacter aborts the source and leaves
# everything after it silently unset. Grep the one value out instead.
DB_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
if [ -z "$DB_URL" ]; then
  echo "No DATABASE_URL in $ENV_FILE" >&2
  exit 1
fi
DB_USER="$(printf '%s' "$DB_URL" | sed 's|.*://||; s|:.*||')"
DB_PASS="$(printf '%s' "$DB_URL" | sed 's|.*://[^:]*:||; s|@.*||')"
DB_NAME="$(printf '%s' "$DB_URL" | sed 's|.*/||; s|?.*||')"

# Keep the password out of the process list and off the command line.
MYCNF="$(mktemp)"
trap 'rm -f "$MYCNF"' EXIT
printf '[client]\nuser=%s\npassword=%s\nhost=127.0.0.1\n' "$DB_USER" "$DB_PASS" > "$MYCNF"
chmod 600 "$MYCNF"

log () { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "restore starting -> $DB_NAME, stopping before $STOP_AT"

for n in $(seq -f "%06g" 1 24); do
  f="$BINLOG_DIR/binlog.$n"
  [ -f "$f" ] || continue
  started=$(date +%s)
  if ! mysqlbinlog --database="$DB_NAME" "$f" 2>>"$LOG" \
       | mysql --defaults-extra-file="$MYCNF" "$DB_NAME" 2>>"$LOG"; then
    log "FAILED on binlog.$n - stopping"
    exit 1
  fi
  log "done binlog.$n ($(( $(date +%s) - started ))s)"
done

# The final file straddles the reset, so it is the only one that needs a stop.
log "final file: binlog.000025, stopping before the reset"
if ! mysqlbinlog --database="$DB_NAME" --stop-datetime="$STOP_AT" "$BINLOG_DIR/binlog.000025" 2>>"$LOG" \
     | mysql --defaults-extra-file="$MYCNF" "$DB_NAME" 2>>"$LOG"; then
  log "FAILED on binlog.000025 - stopping"
  exit 1
fi

log "REPLAY COMPLETE"

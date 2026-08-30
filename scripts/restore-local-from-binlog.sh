#!/bin/bash
#
# Recover option-chain history that is OLDER than production's retention, by
# replaying MySQL binlogs into a scratch database and copying across only the
# rows the live database is missing.
#
# Why this exists
# ---------------
# On 2026-08-30 a `prisma migrate dev` run against the local database detected
# drift (the deferred OptionContractTick index drop, applied outside Prisma by
# design) and, with no TTY to prompt on, reset it - all 38 tables dropped and
# recreated empty.
#
# NEVER run `prisma migrate dev` against this database. Generate the SQL with
# `prisma migrate diff` and apply it directly.
#
# sync-prod-db.sh recovered everything production still holds, which on
# 2026-08-30 reached back to 2026-07-23. It cannot go further, because
# production prunes at SNAPSHOT_RETENTION_DAYS=30 and local is the only archive
# beyond that. The binlogs, however, still contain inserts back to ~2026-06-22 -
# roughly a month of history that exists nowhere else.
#
# Why a scratch database rather than a direct replay
# --------------------------------------------------
# The live database is no longer empty: the sync restored 2026-07-23 onwards.
# Replaying binlog INSERTs straight back in would collide on primary keys and
# abort partway, and `mysqlbinlog --idempotent` would "fix" that by REPLACING
# freshly-synced rows with older copies of themselves - trading one corruption
# for a quieter one. So the replay lands in a scratch database and only rows
# strictly older than what the live database already has are copied over, with
# INSERT IGNORE, parents before children.
#
# Requires MySQL SUPER or REPLICATION_APPLIER: mysqlbinlog's output sets session
# GTID variables. The application user deliberately has neither, so this runs as
# an administrator and is not something the app can do to itself.
#
# The window closes with binlog retention (binlog_expire_logs_seconds, 30 days
# here) - around 2026-09-02 for the oldest data.
#
# Usage:
#   scripts/restore-local-from-binlog.sh --dry-run
#   scripts/restore-local-from-binlog.sh
#   scripts/restore-local-from-binlog.sh --keep-scratch    # leave it for inspection
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINLOG_DIR="${BINLOG_DIR:-/opt/homebrew/var/mysql}"
DB_NAME="${DB_NAME:-option_decode}"
SCRATCH="${SCRATCH_DB:-option_decode_binlog_restore}"
ADMIN_USER="${MYSQL_ADMIN_USER:-root}"
# Everything at or after the reset is the reset itself, so the replay stops here.
STOP_AT="${STOP_AT:-2026-08-30 19:55:00}"
LOG="${RESTORE_LOG:-$REPO_ROOT/.restore-binlog.log}"

DRY_RUN=0
KEEP_SCRATCH=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --keep-scratch) KEEP_SCRATCH=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log () { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
adm () { mysql -u "$ADMIN_USER" "$@"; }
# Scratch replay only. Writing ~32GB of binlog to reconstruct a throwaway
# database is pure waste, and it would push the retention window - the very
# thing this script is racing - along faster. The final copy into the LIVE
# database deliberately keeps binlogging ON, so the recovered rows are
# themselves recoverable.
adm_nobinlog () { mysql -u "$ADMIN_USER" --init-command="SET sql_log_bin=0" "$@"; }

adm -e "SELECT 1" >/dev/null 2>&1 || {
  echo "Cannot connect as '$ADMIN_USER'. This script needs SUPER or REPLICATION_APPLIER:" >&2
  echo "mysqlbinlog's stream sets session GTID variables, which the app user cannot do." >&2
  exit 1
}

# What is the live database actually missing? Everything strictly older than its
# own oldest snapshot. Computing this rather than hardcoding a date means the
# script stays correct as sync-prod-db.sh moves the boundary.
CUTOFF="$(adm -N -e "SELECT DATE_FORMAT(MIN(tradingDate),'%Y-%m-%d') FROM \`$DB_NAME\`.OptionChainSnapshot;" 2>/dev/null)"
if [ -z "$CUTOFF" ] || [ "$CUTOFF" = "NULL" ]; then
  log "the live database has no snapshots at all - run sync-prod-db.sh first"
  exit 1
fi
log "live database currently starts at $CUTOFF; recovering rows strictly older than that"

if [ "$DRY_RUN" = "1" ]; then
  log "dry run: would replay $(ls "$BINLOG_DIR"/binlog.0* 2>/dev/null | grep -c .) binlog files into $SCRATCH"
  log "dry run: would then copy rows with tradingDate < $CUTOFF into $DB_NAME"
  exit 0
fi

# --- 1. Scratch database with the live schema, no data ---------------------
log "creating scratch database $SCRATCH"
adm -e "DROP DATABASE IF EXISTS \`$SCRATCH\`; CREATE DATABASE \`$SCRATCH\`;" || exit 1
mysqldump -u "$ADMIN_USER" --no-data --routines=FALSE --triggers=FALSE "$DB_NAME" \
  | adm_nobinlog "$SCRATCH" || { log "schema clone failed"; exit 1; }
log "schema cloned"

# --- 2. Replay every binlog into the scratch database ----------------------
# --rewrite-db keeps the real database untouched no matter what the stream
# contains. --force so a row event for a table whose shape has since changed
# skips rather than aborting the whole restore.
for f in "$BINLOG_DIR"/binlog.0*; do
  case "$f" in *.index) continue ;; esac
  [ -f "$f" ] || continue
  started=$(date +%s)
  # --database MUST name the POST-rewrite database. mysqlbinlog applies
  # --rewrite-db first and then filters, so filtering on the original name
  # silently discards every event and the restore "succeeds" having done
  # nothing at all - which is exactly what happened on the first run here.
  mysqlbinlog --rewrite-db="$DB_NAME->$SCRATCH" \
              --database="$SCRATCH" \
              --stop-datetime="$STOP_AT" \
              "$f" 2>>"$LOG" \
    | adm_nobinlog --force "$SCRATCH" 2>>"$LOG"
  log "replayed $(basename "$f") ($(( $(date +%s) - started ))s)"
done

RECOVERED="$(adm -N -e "SELECT COUNT(*) FROM \`$SCRATCH\`.OptionChainSnapshot WHERE tradingDate < '$CUTOFF';" 2>/dev/null || echo 0)"
log "scratch holds $RECOVERED snapshot rows older than $CUTOFF"
if [ "${RECOVERED:-0}" -eq 0 ]; then
  log "nothing older than the live database was recovered - leaving it untouched"
  [ "$KEEP_SCRATCH" = "1" ] || adm -e "DROP DATABASE \`$SCRATCH\`;"
  exit 0
fi

# --- 3. Copy across, parents before children -------------------------------
# INSERT IGNORE throughout: anything already present wins, so a freshly synced
# row is never overwritten by an older copy of itself from the binlog.
log "copying rows older than $CUTOFF into $DB_NAME"
adm "$DB_NAME" <<SQL 2>>"$LOG"
INSERT IGNORE INTO \`$DB_NAME\`.Underlying  SELECT * FROM \`$SCRATCH\`.Underlying;
INSERT IGNORE INTO \`$DB_NAME\`.Expiry      SELECT * FROM \`$SCRATCH\`.Expiry;
INSERT IGNORE INTO \`$DB_NAME\`.OptionContract SELECT * FROM \`$SCRATCH\`.OptionContract;

INSERT IGNORE INTO \`$DB_NAME\`.OptionChainSnapshot
  SELECT * FROM \`$SCRATCH\`.OptionChainSnapshot WHERE tradingDate < '$CUTOFF';

-- Restricted to the OLD snapshots specifically. Joining on the live snapshot
-- table alone would match every tick whose parent now exists - including the
-- Jul 23+ rows the sync already restored - so INSERT IGNORE would grind through
-- tens of millions of rows to discard nearly all of them.
INSERT IGNORE INTO \`$DB_NAME\`.OptionContractTick
  SELECT t.* FROM \`$SCRATCH\`.OptionContractTick t
  JOIN \`$DB_NAME\`.OptionChainSnapshot s
    ON s.id = t.snapshotId AND s.tradingDate < '$CUTOFF';

INSERT IGNORE INTO \`$DB_NAME\`.PressureScore
  SELECT p.* FROM \`$SCRATCH\`.PressureScore p
  JOIN \`$DB_NAME\`.OptionChainSnapshot s
    ON s.id = p.snapshotId AND s.tradingDate < '$CUTOFF';
SQL

adm -e "
SELECT COUNT(*) AS snapshots, MIN(tradingDate) AS oldest, MAX(tradingDate) AS newest
FROM \`$DB_NAME\`.OptionChainSnapshot;
SELECT COUNT(*) AS ticks FROM \`$DB_NAME\`.OptionContractTick;
SELECT COUNT(*) AS orphaned_ticks FROM \`$DB_NAME\`.OptionContractTick t
  LEFT JOIN \`$DB_NAME\`.OptionChainSnapshot s ON s.id = t.snapshotId WHERE s.id IS NULL;" | tee -a "$LOG"

if [ "$KEEP_SCRATCH" = "1" ]; then
  log "leaving $SCRATCH in place (--keep-scratch)"
else
  adm -e "DROP DATABASE \`$SCRATCH\`;"
  log "scratch database dropped"
fi

log "RESTORE COMPLETE"

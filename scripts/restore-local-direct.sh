#!/bin/bash
#
# Rebuild an EMPTY local option_decode from the binlogs, in one pass.
#
# The sibling script, restore-local-from-binlog.sh, replays into a scratch
# database and copies across only rows the live database is missing. That is the
# right shape when the live database still holds data and a straight replay would
# collide on primary keys. This one is for the other case: the database is empty,
# so there is nothing to collide with and nothing to protect, and the scratch
# round-trip would only double the work and the disk.
#
# WHY THE DATABASE IS EMPTY, since it should not be:
# `prisma migrate diff --shadow-database-url "$DATABASE_URL"` was run against the
# real database. Prisma RESETS the shadow database in order to replay migrations
# into it, so pointing that flag at a live database drops every table. It
# happened twice - 2026-08-31 11:01 and 2026-09-01 14:00 - and the first left
# _prisma_migrations empty, a symptom that was worked around rather than
# investigated.
#
# NEVER point --shadow-database-url at a live database. This machine already has
# a grant for `prisma_migrate_shadow_db_%`.* precisely so Prisma can create its
# own throwaway one, and a pure schema diff needs no shadow database at all.
#
# The replay runs in binlog order and therefore replays the earlier resets too -
# their DROPs, then the restores that followed them. That is correct: order is
# preserved, so the stream ends in whatever state existed at --stop-datetime.
#
# Requires SUPER or REPLICATION_APPLIER, because mysqlbinlog's output sets
# session GTID variables. The application user deliberately has neither.
#
# Usage: scripts/restore-local-direct.sh '2026-08-31 11:01:00'
#
set -uo pipefail

STOP_AT="${1:?a --stop-datetime is required, e.g. '2026-08-31 11:01:00'}"
BINLOG_DIR="${BINLOG_DIR:-/opt/homebrew/var/mysql}"
DB_NAME="${DB_NAME:-option_decode}"
ADMIN_USER="${MYSQL_ADMIN_USER:-root}"
LOG="${RESTORE_LOG:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.restore-direct.log}"

log () { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

mysql -u "$ADMIN_USER" -e "SELECT 1" >/dev/null 2>&1 || {
  echo "Cannot connect as '$ADMIN_USER'. This needs SUPER or REPLICATION_APPLIER." >&2
  exit 1
}

ROWS=$(mysql -u "$ADMIN_USER" -N -e "SELECT COUNT(*) FROM \`$DB_NAME\`.OptionContractTick;" 2>/dev/null || echo 0)
if [ "${ROWS:-0}" -gt 0 ]; then
  echo "Refusing to run: $DB_NAME already holds $ROWS ticks." >&2
  echo "This script is only for an empty database. Use restore-local-from-binlog.sh," >&2
  echo "which replays into a scratch database and cannot collide with existing rows." >&2
  exit 1
fi

log "replaying into $DB_NAME, stopping before $STOP_AT"

for f in "$BINLOG_DIR"/binlog.0*; do
  case "$f" in *.index) continue ;; esac
  [ -f "$f" ] || continue
  started=$(date +%s)
  # --force so a row event for a table whose shape has since changed skips
  # rather than aborting the whole restore. Binlogging stays ON for the writes
  # this produces: the recovered rows must themselves be recoverable, which is
  # the only reason this restore is possible at all.
  mysqlbinlog --database="$DB_NAME" --stop-datetime="$STOP_AT" "$f" 2>>"$LOG" \
    | mysql -u "$ADMIN_USER" --force "$DB_NAME" 2>>"$LOG"
  log "replayed $(basename "$f") ($(( $(date +%s) - started ))s)"
done

log "REPLAY COMPLETE"
mysql -u "$ADMIN_USER" -e "
SELECT COUNT(*) AS snapshots, MIN(tradingDate) AS oldest, MAX(tradingDate) AS newest
FROM \`$DB_NAME\`.OptionChainSnapshot;
SELECT COUNT(*) AS ticks FROM \`$DB_NAME\`.OptionContractTick;
SELECT COUNT(*) AS daily_bars FROM \`$DB_NAME\`.DailyBar;
SELECT COUNT(*) AS users FROM \`$DB_NAME\`.User;" 2>/dev/null | tee -a "$LOG"

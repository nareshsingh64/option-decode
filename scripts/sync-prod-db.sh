#!/usr/bin/env bash
set -euo pipefail

# Pull production data into the local MySQL so features can be built and
# backtested against real option chains. See docs/local-database.md for the
# measured costs, the safe window, and why this is pull-initiated.
#
# Two facts drive the whole design:
#
#   1. Production retains only SNAPSHOT_RETENTION_DAYS (30) of history and
#      prunes nightly. Anything older is gone there permanently, so LOCAL IS
#      THE ONLY ARCHIVE. This script therefore never deletes local rows - it
#      appends. A "mirror prod exactly" mode would silently destroy history
#      that cannot be re-fetched from anywhere.
#
#   2. The origin is a 2-vCPU t4g.medium with ~2GB free and a worker that
#      already has a documented memory problem. A full dump is ~30 minutes of
#      sustained I/O holding one --single-transaction read view open, which is
#      harmless when ingest is idle and undo-tablespace growth when it is not.
#      Hence the market-hours guard below.
#
# Usage:
#   scripts/sync-prod-db.sh                 # sync whatever local is missing
#   scripts/sync-prod-db.sh --dry-run       # show the plan, touch nothing
#   scripts/sync-prod-db.sh --from 2026-07-14
#   scripts/sync-prod-db.sh --force         # override the market-hours guard

SSH_HOST="${SSH_HOST:-dhan-ec2}"
REMOTE_DB="${REMOTE_DB:-option_decode}"
LOCAL_DB="${LOCAL_DB:-option_decode}"
LOCAL_MYSQL_USER="${LOCAL_MYSQL_USER:-root}"

# Import-time server tuning. The buffer pool is deliberately left at the stock
# 128M in /opt/homebrew/etc/my.cnf to keep parity with production (see the
# parity table in docs/local-database.md) - raising it permanently would make
# local query timings meaningless as a signal about prod. All three of these
# are dynamic on MySQL 8.4, so we raise them for the import and put them back
# in the EXIT trap.
IMPORT_BUFFER_POOL="${IMPORT_BUFFER_POOL:-4294967296}"   # 4G
IMPORT_REDO_CAPACITY="${IMPORT_REDO_CAPACITY:-2147483648}" # 2G

DRY_RUN=0
FORCE=0
FROM_DATE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --from)    FROM_DATE="${2:?--from needs a YYYY-MM-DD date}"; shift ;;
    -h|--help) sed -n '3,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# Single-instance lock. Matters because there are now two ways in: the weekly
# launchd agent (ops/launchd/com.option-decode.dbsync.plist) and whatever you
# type by hand. Two concurrent runs would fight over the same rows and make the
# per-day count comparison read a moving target.
#
# mkdir rather than a PID file or flock: it is atomic on every filesystem, and
# macOS has no /usr/bin/flock.
LOCK_DIR="${TMPDIR:-/tmp}/option-decode-sync.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail "another sync is already running (lock: $LOCK_DIR).
If you are certain nothing is running - e.g. a previous run was killed with
SIGKILL and skipped its cleanup - remove the directory and try again."
fi
# One EXIT trap for the whole script, because bash REPLACES an EXIT trap rather
# than stacking it - a second `trap ... EXIT` later on would silently discard
# the lock release. Everything that must happen on the way out goes here, and
# each step is guarded so an early exit (before the settings are saved) is fine.
cleanup() {
  restore_settings
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
restore_settings() { :; }   # replaced once the originals have been captured
trap cleanup EXIT

local_sql()  { mysql -u "$LOCAL_MYSQL_USER" "$LOCAL_DB" -N -B -e "$1"; }
remote_sql() { ssh "$SSH_HOST" "sudo mysql $REMOTE_DB -N -B -e \"$1\""; }

# --replace for tables production mutates in place (a Subscription going
# active, User.lastLoginAt, FnoStock.lastSyncedAt): prod is authoritative and
# should overwrite. Safe despite the FK graph because every constraint is
# ON DELETE RESTRICT with no cascades, and REPLACE preserves the primary key,
# so children keep pointing at a row that still exists.
MUTABLE_TABLES="User Plan Subscription UserTabAccess AlertThreshold PushSubscription Watchlist FnoStock FnoLotSize SimAccount SimTrade SimLeg PaperOrder PaperPosition PaperTrade ReplaySession BacktestRun"

# --insert-ignore for append-only tables: an existing local row is never
# clobbered, which is what preserves history prod has already pruned.
APPEND_TABLES="Underlying Expiry OptionContract PressureScore WavePricePoint WaveScreenerAlert DhanApiRequestLog SimMtmSnapshot SimExitEvent EmailVerificationToken PasswordResetToken"

# _prisma_migrations is deliberately in NEITHER list. It is Prisma's own state,
# local owns it, and overwriting it would desynchronise `prisma migrate dev`
# from the schema it has actually applied. The preflight compares the two
# instead.

DUMP_COMMON="--single-transaction --no-tablespaces --no-create-info --skip-set-charset"

# ---------------------------------------------------------------- preflight

log "preflight"

ssh -o ConnectTimeout=15 -o BatchMode=yes "$SSH_HOST" true 2>/dev/null \
  || fail "cannot reach $SSH_HOST over ssh. The EC2 instance is on an EventBridge start/stop schedule (8:55 AM / 11:55 PM IST) - it may simply be stopped."

local_sql "SELECT 1" >/dev/null 2>&1 \
  || fail "cannot reach local MySQL as $LOCAL_MYSQL_USER. Is 'brew services' running mysql@8.4?"

REMOTE_HEAD=$(remote_sql "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;")
LOCAL_HEAD=$(local_sql  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;")
if [ "$REMOTE_HEAD" != "$LOCAL_HEAD" ]; then
  fail "migration heads differ - prod is at '$REMOTE_HEAD', local is at '$LOCAL_HEAD'.
Importing across a schema difference corrupts silently (mysqldump's preamble turns
foreign key checks off, so nothing will complain). Run 'pnpm db:migrate' locally,
or deploy the pending migration to prod, then re-run this."
fi
log "  migration head matches on both sides: $LOCAL_HEAD"

# Market-hours guard. IST is UTC+5:30 and has no DST, so the offset is fixed.
IST_NOW=$(TZ=Asia/Kolkata date +%H%M)
IST_DOW=$(TZ=Asia/Kolkata date +%u)
if [ "$IST_DOW" -le 5 ] && [ "$IST_NOW" -ge 0900 ] && [ "$IST_NOW" -le 1545 ]; then
  [ "$FORCE" -eq 1 ] || fail "it is $(TZ=Asia/Kolkata date '+%a %H:%M') IST - inside market hours.
A long --single-transaction dump competes with live ingest on a 2-vCPU box and
grows the undo tablespace. Run after 16:00 IST (and before the 23:55 IST instance
stop), or pass --force if you know the market is closed today."
  log "  WARNING: running inside market hours because --force was given"
fi
if [ "$IST_DOW" -le 5 ] && [ "$IST_NOW" -ge 2330 ]; then
  log "  WARNING: $(TZ=Asia/Kolkata date '+%H:%M') IST - the instance stops at 23:55 IST, this run may be cut off"
fi

AVAIL_GB=$(df -g /opt/homebrew/var/mysql | awk 'NR==2 {print $4}')
log "  local disk available: ${AVAIL_GB}G"
[ "$AVAIL_GB" -ge 40 ] || fail "only ${AVAIL_GB}G free - a full baseline needs roughly 30G once indexes are built."

# ------------------------------------------------------------ plan the days

# Driven off OptionChainSnapshot rather than OptionContractTick: it is the
# parent of the ticks, it carries the same tradingDate, and at ~200k rows a
# GROUP BY over it is cheap, where the same query over 46M ticks is not.
log "comparing trading dates"

REMOTE_DAYS=$(remote_sql "SELECT tradingDate, COUNT(*) FROM OptionChainSnapshot GROUP BY 1 ORDER BY 1;")
LOCAL_DAYS=$(local_sql   "SELECT tradingDate, COUNT(*) FROM OptionChainSnapshot GROUP BY 1 ORDER BY 1;")

DAYS_TO_SYNC=""
while IFS=$'\t' read -r day remote_count; do
  [ -n "$day" ] || continue
  if [ -n "$FROM_DATE" ] && [ "$day" \< "$FROM_DATE" ]; then continue; fi
  local_count=$(printf '%s\n' "$LOCAL_DAYS" | awk -F'\t' -v d="$day" '$1==d {print $2}')
  local_count=${local_count:-0}
  # Re-pull any day whose counts disagree. That covers both "never synced" and
  # "synced while the market was still writing to it" - --insert-ignore makes
  # re-pulling a partially-present day cheap and non-destructive.
  if [ "$local_count" != "$remote_count" ]; then
    DAYS_TO_SYNC="$DAYS_TO_SYNC $day"
    printf '  %s  prod=%-7s local=%-7s  SYNC\n' "$day" "$remote_count" "$local_count"
  else
    printf '  %s  prod=%-7s local=%-7s  ok\n' "$day" "$remote_count" "$local_count"
  fi
done <<< "$REMOTE_DAYS"

DAYS_TO_SYNC=$(echo "$DAYS_TO_SYNC" | xargs || true)

if [ -z "$DAYS_TO_SYNC" ]; then
  log "every trading date prod retains is already complete locally; only reference tables will refresh"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run - stopping here."
  log "would sync days: ${DAYS_TO_SYNC:-<none>}"
  exit 0
fi

# ------------------------------------------------------ tune, with restore

ORIG_POOL=$(mysql -u "$LOCAL_MYSQL_USER" -N -B -e "SELECT @@innodb_buffer_pool_size;")
ORIG_REDO=$(mysql -u "$LOCAL_MYSQL_USER" -N -B -e "SELECT @@innodb_redo_log_capacity;")
ORIG_FLUSH=$(mysql -u "$LOCAL_MYSQL_USER" -N -B -e "SELECT @@innodb_flush_log_at_trx_commit;")

# Redefines the no-op stub declared next to the EXIT trap above, now that there
# are real values to restore. Do not add a second `trap ... EXIT` here.
restore_settings() {
  log "restoring MySQL settings (pool=$ORIG_POOL redo=$ORIG_REDO flush=$ORIG_FLUSH)"
  mysql -u "$LOCAL_MYSQL_USER" -e "
    SET GLOBAL innodb_buffer_pool_size=$ORIG_POOL;
    SET GLOBAL innodb_redo_log_capacity=$ORIG_REDO;
    SET GLOBAL innodb_flush_log_at_trx_commit=$ORIG_FLUSH;" 2>/dev/null || true
}

log "raising local buffer pool to $((IMPORT_BUFFER_POOL / 1073741824))G for the import"
mysql -u "$LOCAL_MYSQL_USER" -e "
  SET GLOBAL innodb_buffer_pool_size=$IMPORT_BUFFER_POOL;
  SET GLOBAL innodb_redo_log_capacity=$IMPORT_REDO_CAPACITY;
  SET GLOBAL innodb_flush_log_at_trx_commit=2;"

# ------------------------------------------------------------- reference data

# zstd on both ends: the link is 18MB/s and a day of ticks is ~200MB
# compressed, so the wire is never the bottleneck - but compressing still
# halves the time the origin spends streaming.
pull() {
  local mode=$1; shift
  local tables="$*"
  ssh "$SSH_HOST" "sudo mysqldump $DUMP_COMMON $mode $REMOTE_DB $tables | zstd -3 -q" \
    | zstd -dc | mysql -u "$LOCAL_MYSQL_USER" "$LOCAL_DB"
}

# The date literal is quoted with ESCAPED DOUBLE quotes on purpose. Writing
# --where='tradingDate=$day' looks right and is silently catastrophic: the
# outer single quotes close against the ones in the value, mysqldump receives
# --where=tradingDate=2026-07-14, and MySQL evaluates the bare token as
# arithmetic (2026-7-14 = 2005) rather than a date - matching nothing and
# exiting 0. Double quotes survive both shell hops and MySQL reads them as a
# string literal (no ANSI_QUOTES in sql_mode on either side).
pull_day() {
  local table=$1 day=$2
  ssh "$SSH_HOST" "sudo mysqldump $DUMP_COMMON --insert-ignore $REMOTE_DB $table --where='tradingDate=\"$day\"' | zstd -3 -q" \
    | zstd -dc | mysql -u "$LOCAL_MYSQL_USER" "$LOCAL_DB"
}

log "reference + account tables (--replace)"
pull --replace $MUTABLE_TABLES

log "append-only tables (--insert-ignore)"
pull --insert-ignore $APPEND_TABLES

# --------------------------------------------------------------- the days

for day in $DAYS_TO_SYNC; do
  started=$(date +%s)
  # Parent before child, always: a tick whose snapshot is missing becomes a
  # silent orphan, because mysqldump's preamble has foreign key checks off.
  pull_day OptionChainSnapshot "$day"
  pull_day OptionContractTick  "$day"
  log "  $day done in $(( $(date +%s) - started ))s"
done

# ---------------------------------------------------------------- verify

# CLAUDE.md's standard: the script exiting 0 is not evidence. The row counts
# matching on both sides is.
log "verifying"
FAILURES=0
for day in $DAYS_TO_SYNC; do
  r=$(remote_sql "SELECT COUNT(*) FROM OptionContractTick WHERE tradingDate='$day';")
  l=$(local_sql  "SELECT COUNT(*) FROM OptionContractTick WHERE tradingDate='$day';")
  if [ "$r" = "$l" ]; then
    printf '  %s  ticks prod=%-9s local=%-9s  ok\n' "$day" "$r" "$l"
  else
    printf '  %s  ticks prod=%-9s local=%-9s  MISMATCH\n' "$day" "$r" "$l"
    FAILURES=$((FAILURES + 1))
  fi
done

ORPHANS=$(local_sql "SELECT COUNT(*) FROM OptionContractTick t LEFT JOIN OptionChainSnapshot s ON s.id = t.snapshotId WHERE s.id IS NULL;")
log "orphaned ticks (no parent snapshot): $ORPHANS"
[ "$ORPHANS" = "0" ] || FAILURES=$((FAILURES + 1))

TOTAL=$(local_sql "SELECT COUNT(*) FROM OptionContractTick;")
SPAN=$(local_sql "SELECT CONCAT(MIN(tradingDate),' .. ',MAX(tradingDate),'  (',COUNT(DISTINCT tradingDate),' days)') FROM OptionChainSnapshot;")
log "local now holds $TOTAL ticks across $SPAN"

[ "$FAILURES" -eq 0 ] || fail "$FAILURES verification check(s) failed - re-run to repair (the sync is idempotent)."
log "sync complete"

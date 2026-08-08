#!/usr/bin/env bash
set -euo pipefail

# One-off cleanup: remove the rows this database ingested ITSELF for four
# trading dates, leaving only production's evenly-sampled capture of the same
# days. See the "Local-origin rows" section of docs/local-database.md.
#
# Why they have to go rather than just being tolerated: the local worker ran
# intermittently, so its extra snapshots are concentrated in narrow windows
# instead of spread across the session. On 2026-07-27 it added 2,068 snapshots
# inside a single 71-minute window against production's ~17/minute across the
# whole day, making that one hour roughly 2.7x denser than every other hour.
# Anything that builds hourly bars, averages across a day, or derives
# per-interval deltas silently overweights those windows - it does not error,
# it just returns a different number, which is the worst failure mode for a
# backtest. Reading only the latest snapshot is unaffected.
#
# The data itself is genuine - spot prices agree closely with production over
# the same day - so this is about sampling bias, not corruption.
#
# Deletes children first because every foreign key is ON DELETE RESTRICT:
# PressureScore -> OptionContractTick -> OptionChainSnapshot.
#
# Usage:
#   scripts/prune-local-origin-rows.sh            # dry run, counts only
#   scripts/prune-local-origin-rows.sh --apply

SSH_HOST="${SSH_HOST:-dhan-ec2}"
REMOTE_DB="${REMOTE_DB:-option_decode}"
LOCAL_DB="${LOCAL_DB:-option_decode}"
LOCAL_MYSQL_USER="${LOCAL_MYSQL_USER:-root}"
DAYS="2026-07-22 2026-07-27 2026-08-03 2026-08-04"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

Q()  { mysql -u "$LOCAL_MYSQL_USER" "$LOCAL_DB" "$@"; }
QN() { mysql -u "$LOCAL_MYSQL_USER" "$LOCAL_DB" -N -B -e "$1"; }
log() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }

DAY_LIST=$(printf "'%s'," $DAYS | sed 's/,$//')

log "loading production's snapshot ids for: $DAYS"

# The scratch table defines what is production-origin. Everything else on these
# dates is local-origin and is what gets removed.
#
# COLLATE is load-bearing: the app's id columns are utf8mb4_unicode_ci while the
# server default is utf8mb4_0900_ai_ci, and the join otherwise dies with
# ERROR 1267 "Illegal mix of collations".
Q -e "DROP TABLE IF EXISTS _prod_snap;
      CREATE TABLE _prod_snap (id VARCHAR(30) COLLATE utf8mb4_unicode_ci PRIMARY KEY);"

for d in $DAYS; do
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" \
      "sudo mysql $REMOTE_DB -N -B -e 'SELECT id FROM OptionChainSnapshot WHERE tradingDate=\"$d\"'" \
    | awk 'BEGIN{ORS=""} NR==1{print "INSERT IGNORE INTO _prod_snap VALUES"} {printf "%s(\"%s\")",(NR==1?"":","),$1} END{print ";"}' \
    | Q
done

PROD_IDS=$(QN "SELECT COUNT(*) FROM _prod_snap;")
log "production snapshot ids loaded: $PROD_IDS"
[ "$PROD_IDS" -gt 0 ] || { Q -e "DROP TABLE _prod_snap;"; echo "refusing to continue: no production ids loaded - every row would look local-origin" >&2; exit 1; }

log "counting what would be removed"
Q -e "
SELECT s.tradingDate,
       COUNT(*) AS local_origin_snapshots,
       MIN(TIME(s.snapshotTime)) AS window_start,
       MAX(TIME(s.snapshotTime)) AS window_end
FROM OptionChainSnapshot s
LEFT JOIN _prod_snap p ON p.id = s.id
WHERE s.tradingDate IN ($DAY_LIST) AND p.id IS NULL
GROUP BY 1 ORDER BY 1;"

SNAPS=$(QN "SELECT COUNT(*) FROM OptionChainSnapshot s LEFT JOIN _prod_snap p ON p.id=s.id WHERE s.tradingDate IN ($DAY_LIST) AND p.id IS NULL;")
TICKS=$(QN "SELECT COUNT(*) FROM OptionContractTick t JOIN OptionChainSnapshot s ON s.id=t.snapshotId LEFT JOIN _prod_snap p ON p.id=s.id WHERE s.tradingDate IN ($DAY_LIST) AND p.id IS NULL;")
SCORES=$(QN "SELECT COUNT(*) FROM PressureScore ps JOIN OptionChainSnapshot s ON s.id=ps.snapshotId LEFT JOIN _prod_snap p ON p.id=s.id WHERE s.tradingDate IN ($DAY_LIST) AND p.id IS NULL;")

echo
log "would delete: $TICKS ticks, $SCORES pressure scores, $SNAPS snapshots"
echo
log "underlyings losing coverage entirely (present locally, absent on prod):"
Q -e "
SELECT s.underlyingSymbol,
       SUM(p.id IS NULL)     AS local_origin,
       SUM(p.id IS NOT NULL) AS prod_origin
FROM OptionChainSnapshot s
LEFT JOIN _prod_snap p ON p.id = s.id
WHERE s.tradingDate IN ($DAY_LIST)
GROUP BY 1 HAVING prod_origin = 0 ORDER BY local_origin DESC;"

if [ "$APPLY" -ne 1 ]; then
  Q -e "DROP TABLE _prod_snap;"
  echo
  log "dry run - nothing deleted. Re-run with --apply to proceed."
  exit 0
fi

echo
# Same raise-and-restore as sync-prod-db.sh, and for the same reason: my.cnf
# stays at the stock 128M to keep parity with production, but removing ~3.9M
# rows against 18GB of secondary indexes on a 128M pool thrashes badly. All
# three are dynamic on 8.4. The trap matters - a tuned pool left behind makes
# every later local timing lie about production.
ORIG_POOL=$(mysql -u "$LOCAL_MYSQL_USER" -N -B -e "SELECT @@innodb_buffer_pool_size;")
ORIG_REDO=$(mysql -u "$LOCAL_MYSQL_USER" -N -B -e "SELECT @@innodb_redo_log_capacity;")
ORIG_FLUSH=$(mysql -u "$LOCAL_MYSQL_USER" -N -B -e "SELECT @@innodb_flush_log_at_trx_commit;")
restore_settings() {
  log "restoring MySQL settings (pool=$ORIG_POOL redo=$ORIG_REDO flush=$ORIG_FLUSH)"
  mysql -u "$LOCAL_MYSQL_USER" -e "
    SET GLOBAL innodb_buffer_pool_size=$ORIG_POOL;
    SET GLOBAL innodb_redo_log_capacity=$ORIG_REDO;
    SET GLOBAL innodb_flush_log_at_trx_commit=$ORIG_FLUSH;" 2>/dev/null || true
}
# Single EXIT trap for the whole script - bash REPLACES an EXIT trap rather
# than stacking it, so a second `trap ... EXIT` further down would silently
# drop the settings restore. IDS_FILE is declared here so the trap can clean it
# up whether or not it was ever created.
IDS_FILE=""
cleanup() {
  [ -n "$IDS_FILE" ] && rm -f "$IDS_FILE"
  restore_settings
}
trap cleanup EXIT
log "raising buffer pool to 4G for the delete"
mysql -u "$LOCAL_MYSQL_USER" -e "
  SET GLOBAL innodb_buffer_pool_size=4294967296;
  SET GLOBAL innodb_redo_log_capacity=2147483648;
  SET GLOBAL innodb_flush_log_at_trx_commit=2;"

log "deleting (children first - the foreign keys are ON DELETE RESTRICT)"

# Materialise the ~8k local-origin snapshot ids up front. This is not just
# tidiness: MySQL rejects LIMIT on a MULTI-TABLE DELETE ("DELETE t FROM t JOIN
# ..."), so batching is only possible against a single-table DELETE, and that
# needs the target set to already exist as a table rather than as a join.
Q -e "DROP TABLE IF EXISTS _local_snap;
      CREATE TABLE _local_snap (id VARCHAR(30) COLLATE utf8mb4_unicode_ci PRIMARY KEY);
      INSERT INTO _local_snap (id)
      SELECT s.id FROM OptionChainSnapshot s
      LEFT JOIN _prod_snap p ON p.id = s.id
      WHERE s.tradingDate IN ($DAY_LIST) AND p.id IS NULL;"
log "local-origin snapshot ids staged: $(QN 'SELECT COUNT(*) FROM _local_snap;')"

# Delete by explicit lists of snapshot ids rather than `WHERE snapshotId IN
# (SELECT id FROM _local_snap) LIMIT n`.
#
# That subquery form looks natural and is pathologically slow here. EXPLAIN on
# it gives type=ALL, key=NULL, rows=50,826,293: MySQL full-scans
# OptionContractTick and probes the subquery once per row as a DEPENDENT
# SUBQUERY, ignoring the snapshotId index entirely. Measured at ~14,500
# rows/minute, which put the 3.9M deletion at over four hours.
#
# A literal IN list lets the optimiser use the snapshotId index directly. The
# chunk size keeps each statement to roughly 25k rows so no single transaction
# grows unbounded.
IDS_FILE=$(mktemp)
QN "SELECT id FROM _local_snap;" > "$IDS_FILE"

del_by_ids() {
  local label=$1 table=$2 col=$3 chunk=${4:-50}
  local total=0 n
  while IFS= read -r list; do
    [ -n "$list" ] || continue
    n=$(Q -N -B -e "DELETE FROM $table WHERE $col IN ($list); SELECT ROW_COUNT();" | tail -1)
    total=$((total + n))
    printf '\r    %s: %s' "$label" "$total"
  done < <(awk -v c="$chunk" 'BEGIN{n=0;s=""}
             {s = s (n?",":"") "\"" $0 "\""; n++; if(n==c){print s; s=""; n=0}}
             END{if(n)print s}' "$IDS_FILE")
  printf '\r    %s: %s (done)\n' "$label" "$total"
}

del_by_ids "pressure scores" PressureScore       snapshotId 200
del_by_ids "ticks"           OptionContractTick  snapshotId 50
del_by_ids "snapshots"       OptionChainSnapshot id         200

Q -e "DROP TABLE _local_snap;"

echo
log "verifying against production"
FAILURES=0
for d in $DAYS; do
  r=$(ssh -o BatchMode=yes "$SSH_HOST" "sudo mysql $REMOTE_DB -N -B -e 'SELECT COUNT(*) FROM OptionContractTick WHERE tradingDate=\"$d\"'")
  l=$(QN "SELECT COUNT(*) FROM OptionContractTick WHERE tradingDate='$d';")
  if [ "$r" = "$l" ]; then
    printf '  %s  ticks prod=%-9s local=%-9s  ok\n' "$d" "$r" "$l"
  else
    printf '  %s  ticks prod=%-9s local=%-9s  MISMATCH\n' "$d" "$r" "$l"
    FAILURES=$((FAILURES + 1))
  fi
done

ORPHANS=$(QN "SELECT COUNT(*) FROM OptionContractTick t LEFT JOIN OptionChainSnapshot s ON s.id=t.snapshotId WHERE s.id IS NULL;")
log "orphaned ticks: $ORPHANS"
[ "$ORPHANS" = "0" ] || FAILURES=$((FAILURES + 1))

Q -e "DROP TABLE _prod_snap;"

[ "$FAILURES" -eq 0 ] || { echo "$FAILURES check(s) failed" >&2; exit 1; }
log "done - those four dates now hold production's capture only"

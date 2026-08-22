#!/bin/bash
# Unattended driver for the monthly maintenance weekend.
#
# Runs the whole sequence with no operator in the loop, emailing after every
# step. Designed so that the WORST case is "it stops early and tells you",
# never "it leaves the database mid-transaction at shutdown".
#
# Three things here are load-bearing rather than convenience:
#
#   1. A hard deadline. The Dhan token renewal fires 17:30 IST and the box
#      powers off at 18:00. Nothing may be in flight when either happens -
#      that exact collision is what produced a 3-hour rollback on 2026-08-20.
#      Every long step checks the clock and stops cleanly.
#   2. Auto-rollback on the MySQL config change. It is the only step that can
#      leave the host with no database, so it restores the previous config and
#      restarts if MySQL does not answer within 60s.
#   3. Resumable. State is recorded per step, so Sunday continues rather than
#      redoing work.
#
# Usage:
#   maintenance-weekend.sh            # run from the first incomplete step
#   maintenance-weekend.sh --status   # print progress, change nothing
#   maintenance-weekend.sh --from N   # force a restart at step N
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/send-alert-email.sh
. "$HERE/lib/send-alert-email.sh" 2>/dev/null || true

LOG=/opt/option-decode-native/logs/maintenance-weekend.log
STATE=/opt/option-decode-native/shared/maint-state
IDX=OptionContractTick_underlyingSymbol_expiryLabel_tradingDate__idx
MIG=20260819170000_drop_unused_optioncontracttick_indexes
MYCNF=/etc/mysql/mysql.conf.d/mysqld.cnf
REL=/opt/option-decode-native/current

# Stop all long work by this time. 17:30 is the token renewal, 18:00 the
# shutdown; finishing at 17:00 leaves a real margin rather than a nominal one.
DEADLINE_HHMM=1700
# Snapshots per delete transaction. The batch unit is SNAPSHOTS and each
# carries ~400 ticks, so 100 is ~40k rows - minutes, not the ~2M-row hour-long
# transactions that the 5000 default produced.
BATCH=100
# Decision thresholds for step 5, agreed in advance so no operator is needed.
RATE_FULL=1500      # rows/sec at or above which the full catch-up runs
RATE_PARTIAL=500    # below this, stop and report rather than grind

# The batch is selected by a DERIVED SUBQUERY, never GROUP_CONCAT.
#
# The first version built an IN list with GROUP_CONCAT. group_concat_max_len is
# 1024 on this host and 100 cuids need ~2,700 chars, so the list was silently
# truncated mid-id: the IN clause matched nothing, every batch deleted 0 rows,
# and the rate came out as 0. Nothing warned - GROUP_CONCAT truncates quietly.
#
# Deleting the parent LAST keeps this stable: the first two statements see the
# same 100 snapshots because OptionChainSnapshot has not been touched yet.
OLD_SNAPS="SELECT id FROM (SELECT id FROM OptionChainSnapshot WHERE tradingDate < DATE_SUB(CURDATE(), INTERVAL 30 DAY) ORDER BY tradingDate LIMIT $BATCH) t"

mkdir -p "$(dirname "$LOG")" 2>/dev/null
exec >>"$LOG" 2>&1

say() { echo "[$(TZ=Asia/Kolkata date '+%F %H:%M:%S')] $*"; }
ist() { TZ=Asia/Kolkata date '+%H:%M IST'; }
now_hhmm() { TZ=Asia/Kolkata date +%H%M; }

mail_step() {
  local subject="$1" body="$2"
  if declare -f send_alert_email >/dev/null; then
    send_alert_email "$subject" "$body" || say "(email failed, continuing)"
  fi
}

sql()  { sudo mysql option_decode -N -e "$1" 2>/dev/null; }
sqlt() { sudo mysql option_decode -e "$1" 2>/dev/null; }

state_get() { [ -f "$STATE" ] && cat "$STATE" || echo 0; }
state_set() { echo "$1" > "$STATE"; }

past_deadline() { [ "$(now_hhmm)" -ge "$DEADLINE_HHMM" ]; }

long_txn() {
  sudo mysql -N -e "SELECT COUNT(*) FROM information_schema.innodb_trx WHERE TIMESTAMPDIFF(SECOND,trx_started,NOW()) > 30;" 2>/dev/null || echo 0
}

overdue_snaps() {
  sql "SELECT COUNT(*) FROM OptionChainSnapshot WHERE tradingDate < DATE_SUB(CURDATE(), INTERVAL 30 DAY);"
}

# ---------------------------------------------------------------- status
if [ "${1:-}" = "--status" ]; then
  exec >/dev/tty 2>&1
  echo "step completed: $(state_get) of 6"
  echo "overdue snapshots: $(overdue_snaps)"
  echo "long transactions: $(long_txn)"
  exit 0
fi

FROM=$(( $(state_get) + 1 ))
if [ "${1:-}" = "--from" ] && [ -n "${2:-}" ]; then FROM="$2"; fi

say "===== maintenance driver starting at step $FROM ($(ist)) ====="

# ---------------------------------------------------------------- step 1
if [ "$FROM" -le 1 ]; then
  say "STEP 1: preflight"
  sudo systemctl stop option-decode-worker 2>/dev/null
  # Wait out any rollback still in flight. A DDL queued behind one is exactly
  # how the API was taken down on 2026-08-20.
  for i in $(seq 1 60); do
    N=$(long_txn)
    [ "$N" = "0" ] && break
    say "  waiting for $N long transaction(s) to clear ($i/60)"
    sleep 30
  done
  if [ "$(long_txn)" != "0" ]; then
    mail_step "[MAINT 1/6] BLOCKED - transaction will not clear" \
"A transaction older than 30s is still running after 30 minutes of waiting.
Nothing was changed. The index drop cannot proceed while it holds the
metadata lock.

Check: sudo mysql -e 'SELECT * FROM information_schema.innodb_trx\\G'"
    say "ABORT: transaction did not clear"; exit 1
  fi
  OVER=$(overdue_snaps)
  state_set 1
  mail_step "[MAINT 1/6] OK - lock clear, ready to work" \
"Preflight complete at $(ist).

  worker            stopped
  long transactions none
  snapshots overdue $OVER

Next: drop the unused index (9.16 GB, zero reads across 11 boot sessions)."
  say "STEP 1 done"
fi

# ---------------------------------------------------------------- step 2
if [ "$FROM" -le 2 ]; then
  say "STEP 2: index drop"
  BEFORE=$(sql "SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema='option_decode' AND table_name='OptionContractTick';")
  PRESENT=$(sql "SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema='option_decode' AND table_name='OptionContractTick' AND index_name='$IDX';")
  if [ "$PRESENT" = "0" ]; then
    say "  already dropped, skipping"
  else
    T0=$(date +%s)
    # lock_wait_timeout so this fails fast rather than queueing behind anything
    # and dragging every later query down with it.
    if ! sudo mysql option_decode -e "SET SESSION lock_wait_timeout = 15; DROP INDEX \`$IDX\` ON \`OptionContractTick\`;" 2>&1; then
      mail_step "[MAINT 2/6] FAILED - index drop" \
"DROP INDEX failed or timed out waiting for the metadata lock at $(ist).
Nothing was changed; the remaining steps did not run."
      say "ABORT: drop failed"; exit 1
    fi
    say "  dropped in $(( $(date +%s) - T0 ))s"
  fi
  AFTER=$(sql "SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema='option_decode' AND table_name='OptionContractTick';")
  # Record it with Prisma so no future deploy re-attempts the DDL in the API's
  # ExecStartPre - which is what took the API down on 2026-08-20.
  PARKED=/opt/option-decode-native/shared/deferred-migrations/$MIG
  if [ -d "$PARKED" ] && [ ! -d "$REL/packages/db/prisma/migrations/$MIG" ]; then
    sudo cp -r "$PARKED" "$REL/packages/db/prisma/migrations/"
  fi
  ( cd "$REL" && sudo bash -c 'set -a; . ./.env.production; set +a; /usr/bin/pnpm --filter @option-decode/db exec prisma migrate resolve --applied '"$MIG"' --schema prisma/schema.prisma' ) 2>&1 | tail -2
  state_set 2
  mail_step "[MAINT 2/6] OK - index dropped" \
"Dropped $IDX at $(ist).

  distinct indexes  $BEFORE -> $AFTER
  migration         recorded as applied, so no deploy will re-attempt it

Kept deliberately: [tickTime] and [tradingDate, ...] carry 179.4M and 37.2M
reads across 11 boot sessions. Both read zero on any single day, which is how
they were nearly dropped by mistake.

Disk will not shrink - those pages return to the tablespace free list, not the
filesystem. The win is insert and delete throughput.

Next: raise the InnoDB buffer pool and restart MySQL."
  say "STEP 2 done"
fi

# ---------------------------------------------------------------- step 3
if [ "$FROM" -le 3 ]; then
  say "STEP 3: buffer pool"
  CUR=$(sudo mysql -N -e "SELECT ROUND(@@innodb_buffer_pool_size/1048576);" 2>/dev/null)
  if [ "${CUR:-0}" -ge 512 ]; then
    say "  already ${CUR}MB, skipping"
  else
    sudo cp "$MYCNF" "${MYCNF}.pre-bufferpool-$(date +%F)"
    # 768MB on a 3.8GB host shared with api/worker/web. This largely MOVES
    # memory rather than adding to it: OS page cache becomes InnoDB's own
    # cache, which is far more efficient for this workload.
    printf '\n# Raised from the 128MB default on %s - the table is 57.8GB and the\n# buffer pool hit rate was 95.5%%%% where healthy is >99%%%%.\ninnodb_buffer_pool_size = 768M\n' "$(date +%F)" | sudo tee -a "$MYCNF" >/dev/null
    sudo systemctl restart mysql
    OK=0
    for i in $(seq 1 12); do
      sleep 5
      if sudo mysql -N -e "SELECT 1;" >/dev/null 2>&1; then OK=1; break; fi
      say "  waiting for mysql ($i/12)"
    done
    if [ "$OK" != "1" ]; then
      say "  MySQL did not come back - rolling the config back"
      sudo cp "${MYCNF}.pre-bufferpool-$(date +%F)" "$MYCNF"
      sudo systemctl restart mysql
      sleep 20
      mail_step "[MAINT 3/6] ROLLED BACK - MySQL did not restart" \
"MySQL did not answer within 60s of restarting with a 768MB buffer pool, so the
previous config was restored automatically and MySQL restarted again.

MySQL now: $(systemctl is-active mysql)

The index drop in step 2 is already done and is unaffected. The retention
catch-up did NOT run. Nothing is mid-transaction."
      say "ABORT: mysql restart failed, config rolled back"; exit 1
    fi
    NEW=$(sudo mysql -N -e "SELECT ROUND(@@innodb_buffer_pool_size/1048576);" 2>/dev/null)
    say "  buffer pool now ${NEW}MB"
  fi
  MEM=$(free -m | awk '/^Mem:/{printf "%s MB available of %s MB", $7, $2}')
  state_set 3
  mail_step "[MAINT 3/6] OK - buffer pool raised" \
"MySQL restarted at $(ist) with a larger buffer pool.

  innodb_buffer_pool_size  128 MB -> $(sudo mysql -N -e 'SELECT ROUND(@@innodb_buffer_pool_size/1048576);' 2>/dev/null) MB
  host memory              $MEM
  mysql                    $(systemctl is-active mysql)

Previous config kept at ${MYCNF}.pre-bufferpool-$(date +%F).

Next: time one delete batch. Everything after this is sized from that
measurement rather than from a guess."
  say "STEP 3 done"
fi

# ---------------------------------------------------------------- step 4
if [ "$FROM" -le 4 ]; then
  say "STEP 4: measure delete rate"
  REMAIN=$(overdue_snaps)
  if [ "${REMAIN:-0}" -eq 0 ]; then
    say "  nothing overdue - retention is already current"
    state_set 5
    mail_step "[MAINT 4/6] OK - nothing to catch up" \
"No snapshots are past the 30-day retention window at $(ist). The catch-up is
not needed. Skipping to verification."
  else
    ROWS=$(sql "SELECT COUNT(*) FROM OptionContractTick WHERE snapshotId IN ($OLD_SNAPS);")
    ROWS=${ROWS:-0}
    T0=$(date +%s)
    sql "DELETE FROM PressureScore WHERE snapshotId IN ($OLD_SNAPS);"
    sql "DELETE FROM OptionContractTick WHERE snapshotId IN ($OLD_SNAPS);"
    T1=$(date +%s)
    sql "DELETE FROM OptionChainSnapshot WHERE id IN ($OLD_SNAPS);"
    SECS=$(( T1 - T0 )); [ "$SECS" -lt 1 ] && SECS=1
    RATE=$(( ROWS / SECS ))
    say "  deleted ${ROWS} ticks in ${SECS}s -> ${RATE} rows/sec"
    if [ "$ROWS" -eq 0 ]; then
      mail_step "[MAINT 4/6] FAILED - measurement returned no rows" \
"The timing batch deleted 0 rows at $(ist), which means the measurement failed
rather than the database being slow. The run stopped rather than acting on a
number it does not trust.

Steps 1-3 are complete and unaffected: the index is dropped and the buffer pool
is at 768 MB."
      say "ABORT: measurement returned 0 rows"; exit 1
    fi
    echo "$RATE" > "${STATE}.rate"
    OVER=$(overdue_snaps)
    PER_SNAP=$(( ROWS / BATCH ))
    EST_MIN=$(( OVER * PER_SNAP / RATE / 60 ))
    if [ "$RATE" -lt "$RATE_PARTIAL" ]; then
      state_set 4
      mail_step "[MAINT 4/6] STOPPING - delete rate too low" \
"Measured $RATE rows/sec, below the $RATE_PARTIAL threshold agreed in advance.

  batch          $BATCH snapshots / $ROWS ticks in ${SECS}s
  still overdue  $OVER snapshots

The buffer pool increase did not buy enough throughput, so the catch-up is NOT
being forced - grinding at this rate is what produced the three-hour rollback
on 2026-08-20. The index drop and buffer pool change are both done and kept.

Recommendation: let the corrected daily prune (batch 200, 08:35 IST) run ahead
of intake and close the gap over the coming week instead."
      say "STOP: rate $RATE below $RATE_PARTIAL"; exit 0
    fi
    MODE=full; [ "$RATE" -lt "$RATE_FULL" ] && MODE=partial
    state_set 4
    mail_step "[MAINT 4/6] OK - measured $RATE rows/sec" \
"Delete rate measured at $(ist).

  batch          $BATCH snapshots / $ROWS ticks in ${SECS}s
  rate           $RATE rows/sec
  ticks/snapshot $PER_SNAP
  still overdue  $OVER snapshots
  estimate       ~${EST_MIN} min to clear the whole backlog
  mode           $MODE

$( [ "$MODE" = full ] && echo "At or above ${RATE_FULL}/sec, so the full catch-up runs." || echo "Between ${RATE_PARTIAL} and ${RATE_FULL}/sec, so it runs to the 17:00 cutoff and the remainder carries to Sunday." )

Next: retention catch-up. It stops cleanly at 17:00 regardless of progress."
  fi
  say "STEP 4 done"
fi

# ---------------------------------------------------------------- step 5
if [ "$FROM" -le 5 ]; then
  say "STEP 5: retention catch-up"
  START_OVER=$(overdue_snaps)
  DONE=0; BATCHES=0; T_START=$(date +%s)
  while :; do
    if past_deadline; then say "  deadline reached"; break; fi
    LEFT_NOW=$(overdue_snaps)
    [ "${LEFT_NOW:-0}" -eq 0 ] && { say "  nothing left overdue"; break; }
    sql "DELETE FROM PressureScore WHERE snapshotId IN ($OLD_SNAPS);"
    sql "DELETE FROM OptionContractTick WHERE snapshotId IN ($OLD_SNAPS);"
    sql "DELETE FROM OptionChainSnapshot WHERE id IN ($OLD_SNAPS);"
    DONE=$(( DONE + BATCH )); BATCHES=$(( BATCHES + 1 ))
    if [ $(( BATCHES % 25 )) -eq 0 ]; then
      say "  $BATCHES batches, ~$DONE snapshots, $(overdue_snaps) still overdue"
    fi
  done
  ELAPSED=$(( ($(date +%s) - T_START) / 60 ))
  LEFT=$(overdue_snaps)
  state_set 5
  if [ "$LEFT" = "0" ]; then
    mail_step "[MAINT 5/6] OK - retention fully caught up" \
"The backlog is cleared as of $(ist).

  snapshots removed  $START_OVER
  batches            $BATCHES
  elapsed            ${ELAPSED} min
  still overdue      0

Retention is inside its 30-day window for the first time. The corrected daily
prune (08:35 IST, batch 200) only has to keep pace from here."
  else
    mail_step "[MAINT 5/6] PARTIAL - stopped at the 17:00 cutoff" \
"Stopped cleanly at $(ist) with work remaining. Nothing is mid-transaction.

  snapshots removed  $(( START_OVER - LEFT ))
  batches            $BATCHES
  elapsed            ${ELAPSED} min
  still overdue      $LEFT

The remainder carries to Sunday - the box starts again at 09:00 and this
driver resumes from where it stopped."
  fi
  say "STEP 5 done ($LEFT still overdue)"
fi

# ---------------------------------------------------------------- step 6
if [ "$FROM" -le 6 ]; then
  say "STEP 6: verify and restart the worker"
  sudo systemctl start option-decode-worker
  sleep 10
  SERVICES=$(systemctl is-active option-decode-api option-decode-worker option-decode-web mysql | tr '\n' ' ')
  API=$(curl -s -o /dev/null -w '%{http_code} in %{time_total}s' --max-time 30 'http://localhost:4000/api/market/overview?underlying=NIFTY')
  IDXN=$(sql "SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema='option_decode' AND table_name='OptionContractTick';")
  LEFT=$(overdue_snaps)
  BP=$(sudo mysql -N -e "SELECT ROUND(@@innodb_buffer_pool_size/1048576);" 2>/dev/null)
  MEM=$(free -m | awk '/^Mem:/{printf "%s MB available of %s MB", $7, $2}')
  DISK=$(df -h / | awk 'NR==2{printf "%s used of %s (%s)", $3, $2, $5}')
  state_set 6
  mail_step "[MAINT 6/6] DONE - maintenance complete" \
"Maintenance finished at $(ist).

  services          $SERVICES
  API               $API
  indexes on ticks  $IDXN (was 6)
  buffer pool       $BP MB (was 128)
  snapshots overdue $LEFT
  memory            $MEM
  disk              $DISK

Still to do on Sunday: the schedule config changes - retention cron to 03:05
UTC, batch size 5000 -> 200, and the morning token renewal to 08:17. Those
three must land together; moving the renewal without moving the prune makes
the collision worse rather than better.

The token renews itself at 17:30 today and again Sunday, so there is no manual
token to paste on Monday."
  say "STEP 6 done - maintenance complete"
fi

say "===== driver finished at $(ist) ====="

#!/usr/bin/env bash
set -euo pipefail

# Accumulate performance_schema index-usage counters across restarts, so an
# "is this index actually used?" question can be answered with a week of
# evidence instead of a few minutes.
#
# The whole reason this exists: performance_schema counters live in memory and
# reset to zero on every MySQL restart. This host is stopped and started daily
# by two EventBridge Scheduler rules (8:55 AM / 11:55 PM IST, see
# docs/ec2-production-deploy.md section 8), so the counters NEVER accumulate
# beyond a single day, and reading them shortly after a start shows almost
# nothing. An audit on 2026-08-08 found the server 316 seconds old - every
# index would have looked unused.
#
# So: snapshot the counters periodically into a durable table, tag each row
# with the boot session it came from, and sum the per-session peaks to get a
# true multi-day total.
#
# Deliberately writes to its own database, NOT option_decode. A stray table in
# the Prisma-managed schema shows up as drift in `prisma migrate` and would
# eventually be "helpfully" dropped.
#
# Usage:
#   ops/scripts/capture-index-usage.sh            # take one capture
#   ops/scripts/capture-index-usage.sh --report   # accumulated totals
#   ops/scripts/capture-index-usage.sh --report --table OptionContractTick

OPS_DB="${OPS_DB:-option_decode_ops}"
TARGET_SCHEMA="${TARGET_SCHEMA:-option_decode}"
MYSQL=(sudo mysql)

MODE=capture
ONLY_TABLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) MODE=report ;;
    --table)  ONLY_TABLE="${2:?--table needs a table name}"; shift ;;
    -h|--help) sed -n '5,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

"${MYSQL[@]}" -e "
CREATE DATABASE IF NOT EXISTS \`$OPS_DB\`;
CREATE TABLE IF NOT EXISTS \`$OPS_DB\`.index_usage_capture (
  captured_at   DATETIME(3)  NOT NULL,
  -- Derived as captured_at - uptime, so every capture taken between two
  -- restarts carries the same value. This is what makes the counters
  -- comparable across a reset: within one boot_time they only ever grow, so
  -- the maximum is that session's true total.
  boot_time     DATETIME(3)  NOT NULL,
  object_name   VARCHAR(64)  NOT NULL,
  index_name    VARCHAR(64)  NOT NULL,
  count_read    BIGINT UNSIGNED NOT NULL,
  count_write   BIGINT UNSIGNED NOT NULL,
  count_delete  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (boot_time, object_name, index_name, captured_at),
  KEY idx_object (object_name, index_name)
) ENGINE=InnoDB;"

if [ "$MODE" = report ]; then
  FILTER=""
  [ -n "$ONLY_TABLE" ] && FILTER="WHERE object_name = '$ONLY_TABLE'"
  "${MYSQL[@]}" -e "
  SELECT
    CONCAT(COUNT(DISTINCT boot_time), ' boot sessions, ',
           DATE(MIN(boot_time)), ' .. ', DATE(MAX(captured_at))) AS coverage
  FROM \`$OPS_DB\`.index_usage_capture;

  -- Sum each boot session's peak. Summing raw counters would double-count
  -- every capture within a session, since they are cumulative-since-boot.
  SELECT object_name, index_name,
         SUM(peak_read)   AS total_reads,
         SUM(peak_write)  AS total_writes,
         SUM(peak_delete) AS total_deletes,
         COUNT(*)         AS sessions
  FROM (
    SELECT boot_time, object_name, index_name,
           MAX(count_read)   AS peak_read,
           MAX(count_write)  AS peak_write,
           MAX(count_delete) AS peak_delete
    FROM \`$OPS_DB\`.index_usage_capture
    GROUP BY boot_time, object_name, index_name
  ) per_session
  $FILTER
  GROUP BY object_name, index_name
  ORDER BY object_name, total_reads DESC;"
  exit 0
fi

# NULL INDEX_NAME means a full table scan rather than an index; it is recorded
# under a readable label because "this table is scanned N times" is exactly as
# interesting as which indexes get used.
"${MYSQL[@]}" -e "
SET @uptime := (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Uptime');
SET @now    := NOW(3);
SET @derived := @now - INTERVAL @uptime SECOND;

-- Snap to the previous capture's boot_time when the two are close, instead of
-- storing the freshly derived value every time.
--
-- Uptime has one-second resolution while NOW(3) has milliseconds, so the
-- derived boot instant jitters by up to a second between captures. Storing it
-- raw made every capture look like a NEW boot session, and since the report
-- sums one peak per session, that multiplied every total by the number of
-- captures - two captures a second apart reported '2 boot sessions' and
-- double-counted 9.9M reads.
--
-- A real restart moves the derived instant by at least the previous uptime
-- plus any downtime, so 60 seconds separates jitter from a genuine restart.
-- The one case this merges wrongly is MySQL restarting after less than a
-- minute of uptime, which would under-report rather than inflate.
SET @prev := (SELECT boot_time FROM \`$OPS_DB\`.index_usage_capture
              ORDER BY captured_at DESC LIMIT 1);
SET @boot := IF(@prev IS NOT NULL AND ABS(TIMESTAMPDIFF(SECOND, @prev, @derived)) <= 60,
                @prev, @derived);

INSERT IGNORE INTO \`$OPS_DB\`.index_usage_capture
  (captured_at, boot_time, object_name, index_name, count_read, count_write, count_delete)
SELECT @now, @boot, OBJECT_NAME, IFNULL(INDEX_NAME,'(table scan)'),
       COUNT_READ, COUNT_WRITE, COUNT_DELETE
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE OBJECT_SCHEMA = '$TARGET_SCHEMA';"

ROWS=$("${MYSQL[@]}" -N -B -e "SELECT COUNT(*) FROM \`$OPS_DB\`.index_usage_capture;")
UP=$("${MYSQL[@]}" -N -B -e "SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Uptime';")
echo "$(date '+%F %T')  captured (mysql uptime ${UP}s, ${ROWS} rows retained)"

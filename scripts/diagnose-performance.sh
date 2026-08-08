#!/usr/bin/env sh
set -eu

# Local-dev version, native MySQL (Homebrew, no Docker) - see
# scripts/diagnose-performance-prod.sh for the native-production variant.

MYSQL_USER="${MYSQL_USER:-option_decode}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-option_decode}"
MYSQL_DATABASE="${MYSQL_DATABASE:-option_decode}"
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"

run_mysql() {
  mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "$1"
}

echo "== Option Decode performance snapshot =="
date

echo
echo "== MySQL process list =="
run_mysql "SHOW FULL PROCESSLIST;"

echo
echo "== MySQL table sizes =="
run_mysql "
SELECT
  table_name,
  table_rows,
  ROUND((data_length + index_length) / 1024 / 1024, 2) AS total_mb,
  ROUND(data_length / 1024 / 1024, 2) AS data_mb,
  ROUND(index_length / 1024 / 1024, 2) AS index_mb
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY (data_length + index_length) DESC;
"

echo
echo "== MySQL indexes =="
run_mysql "
SELECT
  table_name,
  index_name,
  GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns,
  non_unique
FROM information_schema.statistics
WHERE table_schema = DATABASE()
GROUP BY table_name, index_name, non_unique
ORDER BY table_name, index_name;
"

echo
echo "== Slow query configuration =="
run_mysql "SHOW VARIABLES WHERE Variable_name IN ('slow_query_log','long_query_time','log_queries_not_using_indexes');"

echo
echo "== api/worker logs =="
echo "No log file - api/worker run in the foreground of your 'pnpm dev' terminal locally. Check that terminal directly."

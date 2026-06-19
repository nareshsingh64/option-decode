#!/usr/bin/env sh
set -eu

COMPOSE_PROFILE="${COMPOSE_PROFILE:-app}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-root}"
MYSQL_DATABASE="${MYSQL_DATABASE:-option_decode}"

run_mysql() {
  docker compose --profile "$COMPOSE_PROFILE" exec -T mysql mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "$1"
}

echo "== Option Decode performance snapshot =="
date

echo
echo "== Container CPU / memory =="
docker compose --profile "$COMPOSE_PROFILE" ps
docker compose --profile "$COMPOSE_PROFILE" stats --no-stream

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
echo "== Recent API logs =="
docker compose --profile "$COMPOSE_PROFILE" logs --tail=80 api

echo
echo "== Recent worker logs =="
docker compose --profile "$COMPOSE_PROFILE" logs --tail=80 worker

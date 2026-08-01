#!/usr/bin/env bash
# Production variant of scripts/diagnose-performance.sh in the option-decode
# repo. The original script assumes a `mysql` Docker service and defaults to
# root/root credentials — neither is true in production, where MySQL runs
# natively on the EC2 host under the `option_decode` user. Run this on the
# EC2 host itself, from /opt/option-decode.
set -eu

cd "$(dirname "$0")" 2>/dev/null || true

MYSQL_USER="$(grep -E '^MYSQL_USER=' .env.production | cut -d= -f2-)"
MYSQL_PASSWORD="$(grep -E '^MYSQL_PASSWORD=' .env.production | cut -d= -f2-)"
MYSQL_DATABASE="$(grep -E '^MYSQL_DATABASE=' .env.production | cut -d= -f2-)"

run_mysql() {
  mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -h 127.0.0.1 "$MYSQL_DATABASE" -e "$1"
}

echo "== Option Decode production performance snapshot =="
date

echo
echo "== Container CPU / memory =="
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app ps
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app stats --no-stream

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
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app logs --tail=80 api

echo
echo "== Recent worker logs =="
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app logs --tail=80 worker

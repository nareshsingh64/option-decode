#!/usr/bin/env bash
# Production performance snapshot. Run on the EC2 host.
#
# Production is native systemd - api, worker and web are each a
# `pnpm ... exec tsx` process, and MySQL/Redis/nginx are apt installs. Docker
# was removed from the host on 2026-08-05, so the container commands this
# script used to run (`docker compose ps/stats/logs`) are gone.
#
# Two other things it used to get wrong, both worth knowing if you edit it:
#   - It read MYSQL_DATABASE from the env file, which is NOT set on this host.
#     That silently produced `mysql ""` and "No database selected". The
#     database name is derived from DATABASE_URL below, with an explicit
#     fallback.
#   - It looked for .env.production next to itself. The real file lives in
#     /opt/option-decode-native/shared/.
#
# The API and worker do NOT log to journald - their pino output goes to
# /opt/option-decode-native/logs/. `journalctl -u option-decode-api` shows
# only systemd's own lines, so reading the journal and seeing nothing is not
# evidence that nothing was logged.
set -eu

BASE=/opt/option-decode-native
ENV_FILE="$BASE/shared/.env.production"

DB_NAME=option_decode
if [ -r "$ENV_FILE" ]; then
  url="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- || true)"
  parsed="$(printf '%s' "$url" | sed -n 's|.*/\([^/?]*\)\(?.*\)\?$|\1|p')"
  [ -n "$parsed" ] && DB_NAME="$parsed"
fi

# sudo mysql uses unix_socket auth as root - no credentials to read or leak.
run_mysql() { sudo mysql "$DB_NAME" -e "$1"; }

echo "== Option Decode production performance snapshot =="
date -u '+%F %T UTC'
echo "release: $(readlink -f "$BASE/current" 2>/dev/null | xargs -r basename)"

echo
echo "== Host =="
uptime
free -m
df -h / | tail -1

echo
echo "== Service state, memory and CPU =="
for unit in option-decode-api option-decode-worker option-decode-web nginx mysql redis-server; do
  state="$(systemctl is-active "$unit" 2>/dev/null || echo inactive)"
  mem="$(systemctl show "$unit" -p MemoryCurrent --value 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+$/ && $1 > 0) printf "%.0fM", $1/1048576; else print "-" }')"
  cpu="$(systemctl show "$unit" -p CPUUsageNSec --value 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+$/) printf "%.0fs", $1/1000000000; else print "-" }')"
  printf '  %-24s %-10s mem=%-8s cpu=%s\n' "$unit" "$state" "$mem" "$cpu"
done

echo
echo "== Top processes by RSS =="
ps -eo pid,comm,pcpu,pmem,rss --sort=-rss | head -8

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
echo "== Slowest recent API requests =="
# Fastify logs responseTime on every request; this is the fastest way to see
# which endpoint is actually costing time rather than guessing.
sudo tail -5000 "$BASE/logs/api/api.log" 2>/dev/null | python3 -c "
import sys, json
urls, rows = {}, []
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    if d.get('msg') == 'incoming request':
        urls[d.get('reqId')] = d.get('req', {}).get('url', '?')
    elif d.get('msg') == 'request completed' and d.get('responseTime') is not None:
        rows.append((d['responseTime'], urls.get(d.get('reqId'), '?')))
rows.sort(reverse=True)
for rt, u in rows[:10]:
    print(f'  {rt:9.0f} ms  {u[:72]}')
ov = sorted(r[0] for r in rows if 'market/overview' in r[1])
if ov:
    print(f\"\n  overview: n={len(ov)} min={ov[0]:.0f} median={ov[len(ov)//2]:.0f} max={ov[-1]:.0f} ms\")
" 2>/dev/null || echo "  (no parsable API log)"

echo
echo "== Recent API errors =="
sudo tail -2000 "$BASE/logs/api/api.log" 2>/dev/null | grep -E '"level":(50|60)' | tail -10 || echo "  none"

echo
echo "== Recent worker log =="
sudo tail -30 "$BASE/logs/worker/worker.log" 2>/dev/null || echo "  (no worker log)"

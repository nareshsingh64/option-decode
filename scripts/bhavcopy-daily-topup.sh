#!/usr/bin/env bash
#
# Cron-safe daily top-up of DailyBar from the NSE bhavcopy archive.
#
# The ingest itself is already idempotent — DailyBar's primary key is
# (symbol, date) and only dates with no rows are fetched — so this wrapper
# exists for the things cron needs on top of that: a lock so two runs cannot
# overlap, a bounded lookback so a few missed days heal themselves, logging,
# and a non-zero exit when something actually failed.
#
# WHY A LOOKBACK RATHER THAN "YESTERDAY". Running for a single date breaks the
# moment a run is missed, the machine is asleep, or NSE rate-limits (403, which
# this pipeline deliberately records as UNKNOWN rather than as a holiday).
# Re-asking for the last N days costs almost nothing — already-ingested dates
# are skipped by a single indexed query, and confirmed non-trading days are
# cached in $TMPDIR/nse-bhavcopy-cache/non-trading-days.json — and it means any
# gap heals on the next run without intervention.
#
# WHEN TO SCHEDULE. NSE publishes the bhavcopy after the close, typically by
# ~18:00 IST. 20:00 IST leaves margin. Running earlier just 404s and the day is
# picked up tomorrow, so an early run is harmless, only useless.
#
# Usage:
#   scripts/bhavcopy-daily-topup.sh [LOOKBACK_DAYS]        # default 10
#
# Cron (local macOS, 20:00 IST — set CRON_TZ or use the host's local time):
#   0 20 * * * /Users/naresh.singh/option-decode-dev/scripts/bhavcopy-daily-topup.sh >> /tmp/bhavcopy-cron.log 2>&1
#
# systemd timer (production), /etc/systemd/system/bhavcopy-topup.service:
#   [Service]
#   Type=oneshot
#   User=option-decode
#   WorkingDirectory=/opt/option-decode-native/current
#   ExecStart=/opt/option-decode-native/current/scripts/bhavcopy-daily-topup.sh
# and bhavcopy-topup.timer:
#   [Timer]
#   OnCalendar=*-*-* 20:00:00 Asia/Kolkata
#   Persistent=true          # catches up after downtime
#
set -uo pipefail

LOOKBACK_DAYS="${1:-10}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${BHAVCOPY_LOG_DIR:-${TMPDIR:-/tmp}/bhavcopy-topup}"
# mkdir is atomic on POSIX, unlike `flock`, which macOS does not ship. Using a
# directory as the lock keeps this portable between the dev Mac and the
# production Ubuntu host without a second code path.
LOCK_DIR="${TMPDIR:-/tmp}/bhavcopy-topup.lock"
STALE_LOCK_SECONDS=3600

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/topup-$(date +%Y%m%d).log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*" | tee -a "$LOG_FILE"; }

# --- Lock -------------------------------------------------------------------
# A crashed run leaves the lock behind, and a stuck lock silently stops every
# later run. Treat one older than STALE_LOCK_SECONDS as abandoned.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0) ))
  if [ "$lock_age" -gt "$STALE_LOCK_SECONDS" ]; then
    log "WARN removing stale lock (${lock_age}s old, held by PID $(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?'))"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { log "ERROR could not acquire lock after clearing stale one"; exit 1; }
  else
    log "SKIP another run is in progress (PID $(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?'), ${lock_age}s old)"
    exit 0
  fi
fi
echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

# --- Run --------------------------------------------------------------------
if [ ! -f "$REPO_ROOT/.env.local" ]; then
  log "ERROR $REPO_ROOT/.env.local not found - the ingest needs DATABASE_URL from it"
  exit 1
fi

# GNU date and BSD date disagree on relative-date syntax; try both.
FROM_DATE="$(date -v-"${LOOKBACK_DAYS}"d +%Y-%m-%d 2>/dev/null || date -d "${LOOKBACK_DAYS} days ago" +%Y-%m-%d)"
TO_DATE="$(date +%Y-%m-%d)"

log "START top-up ${FROM_DATE} .. ${TO_DATE} (lookback ${LOOKBACK_DAYS}d)"

cd "$REPO_ROOT" || { log "ERROR cannot cd to $REPO_ROOT"; exit 1; }

set +e
OUTPUT=$(pnpm --filter @option-decode/api exec dotenv -e ../../.env.local -- \
  tsx src/scripts/ingest-nse-bhavcopy.ts --from "$FROM_DATE" --to "$TO_DATE" --concurrency 2 2>&1)
STATUS=$?
set -e

printf '%s\n' "$OUTPUT" >> "$LOG_FILE"

if [ $STATUS -ne 0 ]; then
  log "ERROR ingest exited $STATUS"
  printf '%s\n' "$OUTPUT" | tail -20
  exit $STATUS
fi

# The ingest exits 0 even when individual dates were rate-limited, because a
# throttled date is not a failure - it is unresolved and the next run retries
# it. Surface it so a persistent block is visible in the log rather than
# silently leaving a hole.
if printf '%s' "$OUTPUT" | grep -q "throttled (403) [1-9]"; then
  log "WARN some dates were rate-limited and remain unresolved - the next run will retry them"
fi
if printf '%s' "$OUTPUT" | grep -q "FAILED"; then
  log "WARN ingest reported failed dates:"
  printf '%s\n' "$OUTPUT" | grep "FAILED" | tee -a "$LOG_FILE"
fi

# `|| true` is load-bearing: with `pipefail` set, a grep that matches nothing
# returns 1 and takes the whole script down before it can log DONE. That is the
# normal case on a weekend, when there is nothing to ingest and so no summary
# line to match - i.e. the failure mode would have appeared only on the days
# the run was working correctly.
SUMMARY=$(printf '%s\n' "$OUTPUT" | grep -E "DailyBar now holds|Staged" || true)
if [ -n "$SUMMARY" ]; then
  while IFS= read -r line; do log "  $line"; done <<< "$SUMMARY"
else
  log "  nothing new to ingest (weekend, holiday, or bhavcopy not published yet)"
fi
log "DONE"

# Keep two weeks of logs; this runs daily and nothing reads the old ones.
find "$LOG_DIR" -name 'topup-*.log' -type f -mtime +14 -delete 2>/dev/null || true

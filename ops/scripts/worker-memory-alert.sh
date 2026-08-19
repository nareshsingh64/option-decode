#!/bin/bash
# Decide whether this morning's worker-memory report is worth an email.
#
# DELIBERATELY NOT A DAILY EMAIL. A message that arrives every weekday whether
# or not anything happened gets filtered within a fortnight, and then the one
# that matters is filtered too. So:
#
#   - REGRESSION: worst screener-scan peak at or above the threshold. Sent any
#     weekday. An email always means something needs a look.
#   - FRIDAY SUMMARY: the whole trend table, once a week, so a quiet week is
#     confirmed as measured rather than assumed. This is also what catches a
#     report that silently stopped being produced - a missing day shows as a
#     gap in the table, where regression-only alerting would just stay quiet.
#
# THE THRESHOLD, AND WHY IT IS WHERE IT IS
# Lowered 1,200 -> 600 MB on 2026-08-19, when the growth was actually fixed
# (a per-call Intl.DateTimeFormat in the screener's rvol loop - see CLAUDE.md).
# The old value was set against a 594 MB reading taken on 2026-08-17, which
# looked like an improvement and was really a Monday artifact: the screener's
# 2-day lookback reaches into an empty weekend, so a Monday scan loads ~30
# price points per symbol against ~750 by Wednesday. Sizing a tripwire off
# that reading meant sizing it off the quietest day of the week.
#
# The real post-fix baseline is ~330 MB per scan, measured across eight
# consecutive scans and a 45-minute uninterrupted generation that held a flat
# 372-377 MB. 600 MB is a little under twice that: still clear of ordinary
# variance including the Monday/Wednesday swing in points loaded, but it now
# fires on a doubling instead of waiting for a quadrupling. Against the old
# 1,200 the regression would have had to more than triple before anyone heard
# about it.
#
# It is a tripwire, not a target - if the real number settles somewhere else,
# move it rather than letting it cry wolf.
#
# Reads the reports the 04:15 UTC cron writes, so it must run AFTER that job.
#
# Usage:
#   worker-memory-alert.sh                 # decide and send if warranted
#   worker-memory-alert.sh --force-summary # send the summary now, for testing
#   worker-memory-alert.sh --dry-run       # print the decision, send nothing
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/send-alert-email.sh
. "$HERE/lib/send-alert-email.sh"

REPORT_DIR="${REPORT_DIR:-/opt/option-decode-native/logs/memory-reports}"
REGRESSION_MB="${REGRESSION_MB:-600}"
FORCE_SUMMARY=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force-summary) FORCE_SUMMARY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

TODAY=$(date -u +%F)
DOW=$(date -u +%u)   # 5 = Friday
TREND=$("$HERE/worker-memory-trend.sh" 2>/dev/null)
REPORT="$REPORT_DIR/$TODAY.txt"

if [ ! -s "$REPORT" ]; then
  # No report for today. Worth saying so on a Friday (the summary would be
  # misleading without it) but not worth a weekday alert of its own - the cron
  # ahead of this one may simply not have finished.
  echo "no report at $REPORT"
  TODAY_WORST=""
else
  TODAY_WORST=$(grep -oE 'worst peak=[0-9]+ MB' "$REPORT" | tail -1 | grep -oE '[0-9]+')
fi

echo "today=$TODAY worstPeak=${TODAY_WORST:-none} threshold=${REGRESSION_MB}MB dow=$DOW"

send() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY RUN - would send: $1"
    return 0
  fi
  send_alert_email "$1" "$2"
}

if [ -n "$TODAY_WORST" ] && [ "$TODAY_WORST" -ge "$REGRESSION_MB" ]; then
  send "[MEMORY REGRESSION] worker scan peak ${TODAY_WORST}MB - $TODAY" \
"The worker's screener-scan RSS peaked at ${TODAY_WORST} MB this morning, at or
above the ${REGRESSION_MB} MB tripwire.

For context: the scan peaked at 2,921 MB on 2026-08-13, before the cause was
found. Since the fix on 2026-08-19 - a per-call Intl.DateTimeFormat in the
screener's rvol loop, ~318,000 ICU allocations per scan - the baseline has been
about 330 MB per scan.

$TREND

READ THIS BEFORE ACTING. There is no longer a periodic worker restart bounding
this. option-decode-worker-restart.timer was removed on 2026-08-19, so a peak
here is a peak in a process that may have been running for hours, not one
capped by a 7-minute generation. The host has 3.8 GB total and shares it with
MySQL, Redis, api and web; the last time this went unchecked the worker took
2.9 GB, swap thrashing starved MySQL, and unrelated API endpoints returned 500
after waiting out the full 10s connection-pool timeout.

If it needs stopping right now, WAVE_SCREENER_SCAN_ENABLED=false in
.env.production disables the screener scan alone - quote capture keeps running,
so no price history is lost - then restart the worker. That buys time to find
the cause rather than re-arming a restart timer.

And find the cause. Three weeks were spent guessing at mechanisms - Prisma's
native engine, its WASM successor, the mariadb driver, glibc - and every guess
was wrong. What worked was replaying the real loop over the real universe with
one variable changed at a time. CLAUDE.md's worker-memory entry has the method.

Full report: $REPORT"
  echo "regression alert sent"
  exit 0
fi

if [ "$DOW" = "5" ] || [ "$FORCE_SUMMARY" = "1" ]; then
  send "[MEMORY OK] weekly worker memory summary - week ending $TODAY" \
"No regression this week: the worker's screener-scan peak stayed under the
${REGRESSION_MB} MB tripwire every day it was measured.

$TREND

Read the scans column alongside the peaks. Cadence went from 3 to 10 minutes on
2026-08-12, so recent rows have fewer, wider-spaced samples - a low peak on 5
scans is weaker evidence than the same peak on 16. A missing date means no
report was produced that day, which is itself worth checking.

Mondays read low for a reason that is not an improvement: the screener's 2-day
lookback reaches into an empty weekend, so a Monday scan loads roughly 30 price
points per symbol against ~750 by Wednesday. Memory scales with points, so
compare Monday against Monday. A 594 MB Monday reading was briefly mistaken for
a fix in August 2026.

Since 2026-08-19 there is no periodic worker restart, so these peaks are
reached in long-lived processes rather than inside a 7-minute generation.

Reports: $REPORT_DIR"
  echo "weekly summary sent"
  exit 0
fi

echo "nothing to report - quiet day, no email sent"

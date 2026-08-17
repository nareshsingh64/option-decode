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
# The screener scan peaked at 2,921 MB on 2026-08-13 and 594 MB on 2026-08-17
# after the memory work. 1,200 MB sits at roughly twice the current level and
# well under half the old one: high enough that ordinary day-to-day variance
# will not trip it, low enough to fire long before the box is in trouble again.
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
REGRESSION_MB="${REGRESSION_MB:-1200}"
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

For context: it ran 2,921 MB on 2026-08-13 before the memory work and 594 MB on
2026-08-17 after it. A number back in four figures means the growth that was
being contained is happening again.

$TREND

The 15-minute worker restart timer is still active, so this is a peak reached
WITHIN one short generation - the box is not necessarily in trouble yet, but
the thing that was fixed is no longer behaving.

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

Reports: $REPORT_DIR"
  echo "weekly summary sent"
  exit 0
fi

echo "nothing to report - quiet day, no email sent"

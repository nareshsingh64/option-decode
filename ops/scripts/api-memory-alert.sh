#!/bin/bash
#
# Decide whether the API's memory is worth an email.
#
# Same discipline as worker-memory-alert.sh, and for the same reason: a message
# that arrives every weekday whether or not anything happened gets filtered
# within a fortnight, and then the one that matters is filtered too.
#
#   - REGRESSION: peak RSS at or above the threshold. Any weekday. An email
#     always means something needs a look.
#   - FRIDAY SUMMARY: the week's peaks, so a quiet week is confirmed as
#     measured rather than assumed - and so a report that silently stopped
#     being produced shows up as a gap rather than as silence.
#
# THE THRESHOLD, AND WHY IT IS PROVISIONAL
# The worker's 600 MB is anchored to a ~330 MB baseline measured across eight
# consecutive scans and a 45-minute uninterrupted generation. Nothing
# comparable exists for the API yet. What is known on 2026-08-31 is three point
# readings around a deploy - 327 MB before the Live Order work, 502 MB after
# the 1-second refresh landed, 477 MB after that query was tightened - and
# point readings taken minutes after a restart cannot tell a plateau from a
# step in a staircase.
#
# So 900 MB is deliberately loose: a little under twice the highest figure
# observed, chosen to catch a doubling rather than to be precise. Sizing a
# tripwire off an unstable baseline is exactly the mistake that put the
# worker's threshold at 1,200 MB - it was set against a Monday reading that
# looked like an improvement and was really an artifact of the screener's
# lookback reaching into an empty weekend.
#
# REVISIT THIS once api-memory-report.sh has a week of peaks. The right value
# is a little under twice the settled peak, and this comment should be replaced
# with the measurement that produced it.
API_MEMORY_THRESHOLD_MB="${API_MEMORY_THRESHOLD_MB:-900}"

set -uo pipefail

REPORT_DIR="${REPORT_DIR:-/opt/option-decode-native/logs/memory-reports}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODAY="$(date +%F)"
REPORT="$REPORT_DIR/api-$TODAY.txt"

if [ ! -r "$REPORT" ]; then
  echo "api-memory-alert: no report at $REPORT - nothing to judge." >&2
  exit 0
fi

PEAK="$(awk '/^  peak/ { print $2; exit }' "$REPORT")"
if [ -z "$PEAK" ]; then
  # A report with no samples is itself worth knowing about: it means the API
  # has not restarted since the sampler shipped, or the sampler stopped.
  echo "api-memory-alert: report exists but carries no peak - sampler may not be running." >&2
  exit 0
fi

PEAK_INT="${PEAK%%.*}"
IS_FRIDAY=0
[ "$(date +%u)" = "5" ] && IS_FRIDAY=1
REGRESSED=0
[ "$PEAK_INT" -ge "$API_MEMORY_THRESHOLD_MB" ] && REGRESSED=1

if [ "$REGRESSED" = "0" ] && [ "$IS_FRIDAY" = "0" ]; then
  echo "api-memory-alert: peak ${PEAK} MB is under ${API_MEMORY_THRESHOLD_MB} MB and it is not Friday - staying quiet."
  exit 0
fi

if [ "$REGRESSED" = "1" ]; then
  SUBJECT="[API MEMORY] peak ${PEAK} MB on $(hostname) - above the ${API_MEMORY_THRESHOLD_MB} MB threshold"
else
  SUBJECT="[API MEMORY] weekly summary - peak ${PEAK} MB"
fi

{
  echo "API memory, $TODAY."
  echo
  cat "$REPORT"
  echo
  echo "This week's peaks:"
  for f in "$REPORT_DIR"/api-*.txt; do
    [ -r "$f" ] || continue
    d="$(basename "$f" .txt | sed 's/^api-//')"
    p="$(awk '/^  peak/ { print $2; exit }' "$f")"
    printf "  %s  %s MB\n" "$d" "${p:-no samples}"
  done
  echo
  echo "Threshold ${API_MEMORY_THRESHOLD_MB} MB is provisional - see the comment at the top of"
  echo "ops/scripts/api-memory-alert.sh. It was set against point readings rather"
  echo "than a settled baseline and should be re-derived once a week of peaks exists."
} | "$SCRIPT_DIR/send-memory-report.sh" "$SUBJECT"

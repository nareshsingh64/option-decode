#!/bin/bash
#
# Summarise the API's memory samples for one day.
#
# The API logs `console.log("Api memory usage", {...})` from
# apps/api/src/api-memory.ts, which Node pretty-prints across MULTIPLE lines -
# the same shape as the worker's, and the same reason a naive `grep rssMb`
# returns nothing useful. This reassembles those blocks into one row each.
#
# WHY THIS EXISTS SEPARATELY FROM THE WORKER REPORT
# The worker's problem was per-scan allocation with a clear 3-minute period, so
# its report is organised around scan brackets. The API is request-driven and
# has no equivalent bracket, so the useful questions are different:
#
#   - Is the PEAK per restart generation rising day over day? That is a leak.
#   - Does RSS come back down between peaks? If it does, the cost is transient
#     and the fix is different from a ratchet - this is the distinction that
#     took the worker investigation three weeks to make.
#   - Is heapTotalMb rising, or nativeGapMb? The first makes
#     --max-old-space-size relevant; the second means native allocation outside
#     V8's accounting and that flag is a no-op.
#
# api.log interleaves pino JSON with plain-text Prisma and pnpm output from each
# unit's ExecStartPre, so roughly 46% of its lines are not JSON. That is normal
# and does not affect this - these samples are matched by their own marker.
#
# Usage:
#   ops/scripts/api-memory-report.sh [LOG_PATH]
#
# Read-only; safe to run any time.
set -uo pipefail

LOG="${1:-/opt/option-decode-native/logs/api/api.log}"

if [ ! -r "$LOG" ]; then
  echo "api-memory-report: cannot read $LOG" >&2
  exit 1
fi

echo "log:  $LOG"
echo "size: $(du -h "$LOG" 2>/dev/null | cut -f1)"
echo "generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
echo

awk '
  /Api memory usage/ { inblock = 1; ts=""; rss=""; heap=""; native=""; next }
  inblock {
    if ($0 ~ /ts:/)          { match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+/); ts = substr($0, RSTART, RLENGTH) }
    if ($0 ~ /rssMb:/)       { match($0, /[0-9.]+/); rss = substr($0, RSTART, RLENGTH) }
    if ($0 ~ /heapTotalMb:/) { match($0, /[0-9.]+/); heap = substr($0, RSTART, RLENGTH) }
    if ($0 ~ /nativeGapMb:/) { match($0, /[0-9.]+/); native = substr($0, RSTART, RLENGTH) }
    if ($0 ~ /}/) {
      inblock = 0
      if (rss != "") {
        printf "%-26s rss=%-8s heapTotal=%-8s nativeGap=%s\n", ts, rss, heap, native
        n++
        sum += rss
        if (rss + 0 > max + 0) { max = rss; maxts = ts }
        if (min == "" || rss + 0 < min + 0) { min = rss }
      }
    }
  }
  END {
    if (n == 0) {
      print "No API memory samples found."
      print "The sampler ships in apps/api/src/api-memory.ts and starts after listen();"
      print "if this is empty the API has not been restarted since that was deployed."
      exit
    }
    printf "\n%d samples\n", n
    printf "  min  %8.1f MB\n", min
    printf "  mean %8.1f MB\n", sum / n
    printf "  peak %8.1f MB   at %s\n", max, maxts
    printf "\nPeak is the figure to compare across days. A rising peak with a\n"
    printf "falling minimum is transient cost; a rising peak AND a rising minimum\n"
    printf "is a ratchet, and only the second is a leak.\n"
  }
' "$LOG"

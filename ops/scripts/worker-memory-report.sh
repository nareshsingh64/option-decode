#!/bin/bash
# Summarise the worker's memory instrumentation.
#
# apps/worker/src/worker.ts logs `console.log("Worker memory usage", {...})`,
# which Node pretty-prints across MULTIPLE lines. That is why a naive
# `grep rssMb` returns nothing useful and why an earlier session concluded
# the worker logged no memory at all - it logs plenty, just not as one-line
# JSON. This script reassembles those blocks into one row each.
#
# What to look for (see CLAUDE.md's worker-memory entry for the full story):
#   - nativeGapMb is RSS minus everything Node can account for. It is the
#     quantity that moves: ~100MB at rest, ~2.7GB at peak.
#   - heapTotalMb stays under ~165MB throughout. If it ever doesn't, the
#     diagnosis has changed and --max-old-space-size becomes relevant again;
#     while it does, that flag is a no-op.
#   - capture:before -> capture:after on the SAME jobId is the attribution:
#     a large positive delta means the burst is inside captureOnce().
#
# Usage:
#   ops/scripts/worker-memory-report.sh [LOG_PATH]
#   ssh dhan-ec2 'bash -s' < ops/scripts/worker-memory-report.sh   # remote
#
# Defaults to the production log path. Read-only; safe to run any time.

set -uo pipefail

LOG="${1:-/opt/option-decode-native/logs/worker/worker.log}"

if [ ! -r "$LOG" ]; then
  echo "worker-memory-report: cannot read $LOG" >&2
  exit 1
fi

echo "=== Worker memory report ==="
echo "log:  $LOG"
echo "size: $(du -h "$LOG" 2>/dev/null | cut -f1)"
echo "now:  $(date -u +%Y-%m-%dT%H:%M:%SZ) UTC / $(TZ=Asia/Kolkata date +%H:%M) IST"
echo

awk '
  # A record starts at the marker and ends at the closing brace.
  /Worker memory usage \{/ { inrec=1; at=""; rss=""; ht=""; ng=""; job=""; took=""; next }
  inrec && /at:/            { v=$2; gsub(/[",'"'"']/,"",v); sub(/,$/,"",v); at=v }
  inrec && /rssMb:/         { v=$2; gsub(/,/,"",v); rss=v+0 }
  inrec && /heapTotalMb:/   { v=$2; gsub(/,/,"",v); ht=v+0 }
  inrec && /nativeGapMb:/   { v=$2; gsub(/,/,"",v); ng=v+0 }
  inrec && /jobId:/         { v=$2; gsub(/[",'"'"']/,"",v); n=split(v,p,":"); job=p[n] }
  inrec && /tookMs:/        { v=$2; gsub(/,/,"",v); took=v+0 }
  inrec && /^\}/ {
    inrec=0
    total++
    if (ng != "") { if (ng > peak) peak=ng; if (mn=="" || ng < mn) mn=ng }
    if (ht != "" && ht > peakHeap) peakHeap=ht
    # Labels are "capture:before" (pre-split) or "capture:NIFTY:before"
    # (per-underlying). Pair on whatever precedes the final :before/:after
    # so both formats work and the split can be compared against history.
    phase=""; subject=at
    if (at ~ /:before$/) { phase="before"; sub(/:before$/, "", subject) }
    if (at ~ /:after$/)  { phase="after";  sub(/:after$/,  "", subject) }
    key = subject "#" job
    if (phase == "before" && job != "") { before[key]=ng; beforeRss[key]=rss; label[key]=subject }
    if (phase == "after" && job != "" && key in before) {
      d = ng - before[key]
      pairs++
      printf "  %-22s nativeGap %7.0f -> %7.0f MB   delta %+8.0f MB   RSS %6.0f -> %6.0f MB   took %ss\n",
             label[key], before[key], ng, d, beforeRss[key], rss, (took==""?"?":sprintf("%.1f", took/1000))
      if (d > maxd) { maxd=d; maxjob=label[key] }
      sumd += d
      delete before[key]
    }
    next
  }
  END {
    printf "\n  samples=%d  capture-pairs=%d\n", total, pairs
    if (total)  printf "  nativeGap  min=%.0f MB  peak=%.0f MB\n", mn, peak
    if (peakHeap) printf "  heapTotal  peak=%.0f MB %s\n", peakHeap, (peakHeap>500 ? "  <-- ABOVE 500MB: heap is now material, re-read CLAUDE.md" : "(steady; heap is NOT the problem)")
    if (pairs)  printf "  capture delta: worst=%+.0f MB (job %s)  mean=%+.0f MB\n", maxd, maxjob, sumd/pairs
    if (!pairs) print "  no complete capture:before/after pairs yet (worker restarts every 15 min; wait for a cycle)"
  }
' "$LOG"

#!/bin/bash
# Summarise every daily worker-memory report as one trend table.
#
# WHY THIS EXISTS
# The daily reports (ops/scripts/worker-memory-report.sh, cron
# option-decode-memory-report) each describe one morning in ~80KB of detail.
# Judging whether the memory work actually held needs the OPPOSITE view: one
# line per day, so a regression shows up as a trend rather than having to be
# spotted by re-reading a wall of text.
#
# THE COMPARISON IS ONLY VALID BECAUSE EVERY REPORT COVERS THE SAME CLOCK
# WINDOW. Cron fires at 04:15 UTC (09:45 IST) and the script reads a fixed
# lookback, so 03:32-04:14 UTC on one day lines up with the same window on
# another - same point in the session, same distance from the 08:15 boot.
# That is what makes day-over-day numbers comparable at all. If the cron time
# ever moves, older rows stop being comparable and this table becomes
# misleading rather than merely sparse.
#
# Read the scan-count column. Cadence changed from 3 to 10 minutes on
# 2026-08-12, so days before that have ~16 scans in the window and days after
# have ~5. Fewer, wider-spaced samples can miss a spike that a tighter cadence
# would have caught, so a lower peak on fewer scans is weaker evidence than
# the same peak on more.
#
# Usage:  worker-memory-trend.sh            # all reports
#         worker-memory-trend.sh 2026-08-13 # from a date onward
set -uo pipefail

DIR="${REPORT_DIR:-/opt/option-decode-native/logs/memory-reports}"
FROM="${1:-0000-00-00}"

[ -d "$DIR" ] || { echo "no report directory at $DIR" >&2; exit 1; }

printf "%-12s %6s %10s %10s %12s %12s %10s\n" \
  "date" "scans" "meanPeak" "worstPeak" "nativeGapPk" "captureWorst" "samples"
printf "%-12s %6s %10s %10s %12s %12s %10s\n" \
  "------------" "------" "----------" "----------" "------------" "------------" "----------"

for f in "$DIR"/*.txt; do
  [ -e "$f" ] || continue
  day=$(basename "$f" .txt)
  [ "$day" \< "$FROM" ] && continue

  # "scans=5  mean peak=355 MB  worst peak=594 MB"
  scanline=$(grep -oE 'scans=[0-9]+ +mean peak=[0-9]+ MB +worst peak=[0-9]+ MB' "$f" | tail -1)
  scans=$(echo "$scanline"  | grep -oE 'scans=[0-9]+'      | cut -d= -f2)
  mean=$(echo "$scanline"   | grep -oE 'mean peak=[0-9]+'  | cut -d= -f2)
  worst=$(echo "$scanline"  | grep -oE 'worst peak=[0-9]+' | cut -d= -f2)

  # "nativeGap  min=42 MB  peak=451 MB"
  gap=$(grep -oE 'nativeGap +min=[0-9]+ MB +peak=[0-9]+ MB' "$f" | tail -1 | grep -oE 'peak=[0-9]+' | cut -d= -f2)
  # "capture delta: worst=+72 MB (job ...)"
  cap=$(grep -oE 'capture delta: worst=[+-]?[0-9]+ MB' "$f" | tail -1 | grep -oE '[+-]?[0-9]+ MB' | tr -d ' MB')
  # "samples=2039  capture-pairs=695"
  samples=$(grep -oE 'samples=[0-9]+' "$f" | tail -1 | cut -d= -f2)

  printf "%-12s %6s %10s %10s %12s %12s %10s\n" \
    "$day" "${scans:--}" "${mean:--}" "${worst:--}" "${gap:--}" "${cap:--}" "${samples:--}"
done

echo
echo "meanPeak/worstPeak: screener-scan RSS peak, MB. nativeGapPk: RSS minus V8's"
echo "own accounting, MB - this is where the growth lives, not the heap."
echo "captureWorst: largest single capture job's RSS delta, MB."
echo
echo "Baseline for reference: 2026-08-13 ran 2268 mean / 2921 worst on a 3-minute"
echo "scan cadence. The 15-minute restart timer is still active on every row here,"
echo "so these are peaks WITHIN a short generation - low numbers mean the growth is"
echo "slower, not that it has stopped."

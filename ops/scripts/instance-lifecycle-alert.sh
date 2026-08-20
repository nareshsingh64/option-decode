#!/bin/bash
# Email when the production instance starts and when it shuts down.
#
# The box is on an EventBridge schedule (08:15-23:50 IST Mon-Fri, plus a
# monthly maintenance weekend - see docs/operations-schedule.md). Those
# transitions were previously invisible: the only way to know whether the box
# had come up was to notice something else failing.
#
# Deliberately reports the STATE, not just the transition. A boot mail that
# says the three services are active and how much memory is free is worth
# reading; one that only says "started" is not, and gets filtered.
#
# Invoked by option-decode-lifecycle-alert.service, whose ExecStart fires at
# boot and ExecStop during shutdown.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/send-alert-email.sh
. "$HERE/lib/send-alert-email.sh" 2>/dev/null || exit 0
declare -f send_alert_email >/dev/null || exit 0

PHASE="${1:-start}"
IST=$(TZ=Asia/Kolkata date "+%a %F %H:%M IST")
SERVICES=$(systemctl is-active option-decode-api option-decode-worker option-decode-web 2>/dev/null | tr '\n' ' ')
MEM=$(free -m | awk '/^Mem:/{printf "%s MB used, %s MB available of %s MB", $3, $7, $2}')
SWAP=$(free -m | awk '/^Swap:/{printf "%s MB of %s MB", $3, $2}')
DISK=$(df -h / | awk 'NR==2{printf "%s used of %s (%s)", $3, $2, $5}')
UPTIME=$(uptime -p 2>/dev/null || echo "unknown")

if [ "$PHASE" = "stop" ]; then
  # Worth knowing on the way down: whether the MCX settlement pass at 23:40
  # actually ran, since it has only a ten-minute margin before this shutdown.
  EOD=$(grep -c 'sim-eod-mtm:mark-mcx' /opt/option-decode-native/logs/worker/worker.log 2>/dev/null || echo "?")
  OPEN_PAST_EXPIRY=$(mysql option_decode -N -e "SELECT COUNT(*) FROM SimTrade WHERE status='OPEN' AND expiryDate < CURDATE();" 2>/dev/null || echo "?")
  send_alert_email \
    "[EC2 STOP] production shutting down - $IST" \
"The production instance is shutting down.

  when      $IST
  uptime    $UPTIME
  services  $SERVICES
  memory    $MEM
  swap      $SWAP
  disk      $DISK

MCX settlement check (the 23:40 pass has only ten minutes before this
shutdown, so it is worth confirming rather than assuming):
  sim-eod-mtm:mark-mcx runs in this log   $EOD
  sim trades still OPEN past their expiry $OPEN_PAST_EXPIRY

A non-zero count on that last line means a position did not settle and is
still holding margin. See CLAUDE.md's settlement section." || true
else
  send_alert_email \
    "[EC2 START] production is up - $IST" \
"The production instance has started.

  when      $IST
  services  $SERVICES
  memory    $MEM
  swap      $SWAP
  disk      $DISK

Scheduled for today: token renewal 08:20 IST, retention prune, memory report
09:45, alert 09:50. Market opens 09:00 (MCX) and 09:14 (NSE)." || true
fi

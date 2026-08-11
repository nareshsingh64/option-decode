#!/bin/bash
# Runs daily after market close (15:41 IST since 2026-08-11) via cron.
# Only restarts MySQL if needrestart still has it flagged as running against
# upgraded/deleted libraries (e.g. from an unattended-upgrades libc patch
# earlier in the day). Restart is skipped entirely on days nothing was
# flagged, so this is a no-op most days.

LOG=/var/log/option-decode-mysql-restart.log

FLAGGED=$(sudo needrestart -b 2>/dev/null | grep -c "NEEDRESTART-SVC: mysql")

if [ "$FLAGGED" -gt 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - mysql flagged by needrestart, restarting in safe window" >> "$LOG"
  sudo systemctl restart mysql
  sleep 5
  sudo systemctl is-active mysql >> "$LOG" 2>&1
else
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - mysql not flagged, no restart needed" >> "$LOG"
fi

#!/bin/bash
# Runs daily after market close (16:00 IST) via cron.
# Every `docker compose ... build` on this host builds from the same
# Dockerfile/image tag (option-decode-app:latest, see docker-compose.prod.yml)
# - BuildKit's layer cache from each build accumulates independently of the
# image itself, and unlike dangling images/stopped containers (which this
# setup doesn't actually leave behind under normal compose usage - confirmed
# by observation, both were already at 0 reclaimable), that cache is not
# self-limiting. Observed growing to 20GB+ with 90%+ of it reclaimable after
# a day of repeated rebuilds (2026-07-29). Safe to run daily regardless of
# whether a build actually happened - `docker builder prune -f` is a fast
# no-op when there's nothing to reclaim, and never touches running
# containers, tagged images, or volumes.

LOG=/var/log/option-decode-docker-prune.log

{
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - starting build cache prune"
  echo "--- before ---"
  docker system df
  docker builder prune -f
  echo "--- after ---"
  docker system df
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - done"
  echo
} >> "$LOG" 2>&1

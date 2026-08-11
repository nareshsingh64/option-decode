#!/bin/bash
# Native (non-Docker) deploy script for Option Decode on the EC2 host.
#
# NOTE: the comments below refer to the Dockerfile and docker-compose files
# this script was ported from. Those were deleted on 2026-08-05 once Docker
# was removed from the host - the references explain WHY steps look the way
# they do, they are not files you can still go and read.
#
# Ports the Dockerfile's build steps (install/generate/build) plus a
# release-dir + symlink pattern so a bad deploy can be rolled back
# instantly by flipping the symlink back, without a rebuild.
#
# Source of code is the existing, already-authenticated /opt/option-decode
# checkout (SOURCE_REPO below), copied via rsync rather than a fresh git
# clone. This script needs to run as root (sudo) for the later
# chown/systemctl steps, and root doesn't have the ubuntu user's SSH
# deploy key that /opt/option-decode's origin remote relies on (its git
# pull output shows a custom "github.com-option-decode" SSH host alias) -
# so a git clone/fetch from inside this script would fail under sudo.
# Run `git -C /opt/option-decode pull` yourself first (same first step as
# any routine Docker deploy), then run this script.
#
# Layout:
#   $BASE/releases/<git-sha>/    - one full checkout+build per deploy
#   $BASE/current                - symlink to the active release
#   $BASE/shared/.env.production - env file, symlinked into each release
#                                   (not duplicated)
#   $BASE/logs/{api,worker,web}/ - persistent across releases
#
# BASE defaults to /opt/option-decode-native - kept deliberately separate
# from /opt/option-decode (the live Docker checkout) for the whole
# pre-cutover testing phase (steps 1-7). Only at the actual cutover (step
# 9) does BASE get pointed at /opt/option-decode itself, as a conscious
# decision made in that maintenance window - not a default here.
#
# Usage: sudo BASE=/opt/option-decode-native ./native-deploy.sh

set -euo pipefail

SOURCE_REPO=/opt/option-decode
BASE="${BASE:-/opt/option-decode-native}"
RELEASES="$BASE/releases"
SHARED="$BASE/shared"
KEEP_RELEASES=5

mkdir -p "$RELEASES" "$SHARED" "$BASE/logs/api" "$BASE/logs/worker" "$BASE/logs/web"

SHA=$(git -C "$SOURCE_REPO" rev-parse --short HEAD)
RELEASE_DIR="$RELEASES/$SHA"

if [ -d "$RELEASE_DIR" ]; then
  echo "Release $SHA already built, reusing $RELEASE_DIR"
else
  echo "Building release $SHA into $RELEASE_DIR (from $SOURCE_REPO)"
  mkdir -p "$RELEASE_DIR"
  rsync -a \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='logs' \
    "$SOURCE_REPO/" "$RELEASE_DIR/"
  cd "$RELEASE_DIR"

  # Same three steps as the Dockerfile, run directly on the host instead
  # of inside a build stage. Installing pnpm via corepack (as the
  # Dockerfile does) hit a real substitution bug on this host - asking
  # for pnpm@11.8.0 silently downloaded 11.18.0 instead, even after
  # clearing the corepack cache. 11.8.0 does exist on the npm registry
  # (verified directly), so this is a Corepack-side resolution issue, not
  # a missing version - installing via npm instead sidesteps it and pins
  # the exact version reliably.
  command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@11.8.0
  pnpm install --frozen-lockfile
  pnpm --filter @option-decode/db db:generate

  # NEXT_PUBLIC_API_URL is inlined into the client-side JS bundle at build
  # time by Next.js - it is NOT read at runtime. The Dockerfile always
  # passed this as a build ARG (NEXT_PUBLIC_API_URL: ${APP_PUBLIC_URL} in
  # docker-compose.prod.yml); missing it here silently left every
  # client-side fetch() call (login included) falling back to its
  # hardcoded "http://localhost:4000" default, which resolves to the
  # BROWSER's own machine, not the server - surfaced in production as a
  # "Load failed" error on login. Source the same value from the shared
  # env file that the Docker build always used.
  APP_URL=$(grep '^APP_PUBLIC_URL=' "$SHARED/.env.production" | cut -d= -f2-)
  if [ -z "$APP_URL" ]; then
    echo "ERROR: APP_PUBLIC_URL not found in $SHARED/.env.production - refusing to build without it" >&2
    exit 1
  fi
  NEXT_PUBLIC_API_URL="$APP_URL" pnpm --filter @option-decode/web build

  ln -sf "$SHARED/.env.production" "$RELEASE_DIR/.env.production"
  chown -R option-decode:option-decode "$RELEASE_DIR"
fi

echo "Switching current -> $RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$BASE/current"

# Install the logrotate policy as a REAL root-owned 0644 file.
#
# /etc/logrotate.d/option-decode used to be a symlink into the repo checkout,
# which logrotate silently refuses to load twice over: it rejects a config
# that is group/other-writable (git checks out 0664 under the default umask)
# AND one not owned by uid 0 (repo files are owned by ubuntu). Both checks
# only surface under `logrotate -d`, so the policy looked installed while
# never running - which is how api.log reached 26MB unrotated with
# "rotate 14" retaining nothing. Copying on each deploy keeps the repo as the
# single source of truth without tripping either check.
if [ -f "$RELEASE_DIR/ops/logrotate/option-decode" ]; then
  install -o root -g root -m 0644 \
    "$RELEASE_DIR/ops/logrotate/option-decode" /etc/logrotate.d/option-decode
  if logrotate -d /etc/logrotate.d/option-decode >/dev/null 2>&1; then
    echo "logrotate policy installed and parses cleanly"
  else
    echo "WARNING: logrotate policy installed but failed to parse - run 'logrotate -d /etc/logrotate.d/option-decode'" >&2
  fi
fi

# api/worker first (shorter restart, migrate deploy runs via ExecStartPre),
# then web - same ordering as the existing Docker deploy runbook, to keep
# the bad-gateway window as short as possible.
systemctl restart option-decode-api option-decode-worker
sleep 2
systemctl restart option-decode-web

echo "Deployed $SHA. Pruning old releases (keeping last $KEEP_RELEASES)..."
cd "$RELEASES"
ls -1t | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

echo "Done. Current release: $SHA"
echo "Rollback: ln -sfn $RELEASES/<previous-sha> $BASE/current && systemctl restart option-decode-api option-decode-worker option-decode-web"

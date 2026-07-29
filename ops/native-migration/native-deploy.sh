#!/bin/bash
# Native (non-Docker) deploy script for Option Decode on the EC2 host.
# Ports the Dockerfile's build steps (install/generate/build) plus a
# release-dir + symlink pattern so a bad deploy can be rolled back
# instantly by flipping the symlink back, without a rebuild.
#
# Layout:
#   $BASE/releases/<git-sha>/   - one full checkout+build per deploy
#   $BASE/current               - symlink to the active release
#   $BASE/shared/.env.production - env file, symlinked into each release
#                                   (not duplicated)
#   $BASE/logs/{api,worker,web}/ - persistent across releases
#
# BASE defaults to /opt/option-decode-native - kept deliberately separate
# from /opt/option-decode (the live Docker checkout) for the whole
# pre-cutover testing phase (steps 1-7), so this script can never touch
# the live deploy by accident. Only at the actual cutover (step 9) does
# BASE get pointed at /opt/option-decode itself, as a conscious decision
# made in that maintenance window - not a default here.
#
# Usage: BASE=/opt/option-decode-native ./native-deploy.sh [git-ref]
#        (defaults to origin/main for the ref, /opt/option-decode-native for BASE)

set -euo pipefail

REPO_URL="git@github.com:nareshsingh64/option-decode.git"
BASE="${BASE:-/opt/option-decode-native}"
RELEASES="$BASE/releases"
SHARED="$BASE/shared"
REF="${1:-origin/main}"
KEEP_RELEASES=5

mkdir -p "$RELEASES" "$SHARED" "$BASE/logs/api" "$BASE/logs/worker" "$BASE/logs/web"

cd "$BASE"
if [ ! -d "$BASE/repo" ]; then
  git clone "$REPO_URL" "$BASE/repo"
fi
cd "$BASE/repo"
git fetch origin
git checkout "$REF"
SHA=$(git rev-parse --short HEAD)

RELEASE_DIR="$RELEASES/$SHA"
if [ -d "$RELEASE_DIR" ]; then
  echo "Release $SHA already built, reusing $RELEASE_DIR"
else
  echo "Building release $SHA into $RELEASE_DIR"
  cp -a "$BASE/repo" "$RELEASE_DIR"
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
  pnpm --filter @option-decode/web build

  ln -sf "$SHARED/.env.production" "$RELEASE_DIR/.env.production"
  chown -R option-decode:option-decode "$RELEASE_DIR"
fi

echo "Switching current -> $RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$BASE/current"

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

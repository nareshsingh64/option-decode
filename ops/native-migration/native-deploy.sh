#!/bin/bash
# Native (non-Docker) deploy script for Option Decode on the EC2 host.
# Ports the Dockerfile's build steps (install/generate/build) plus a
# release-dir + symlink pattern so a bad deploy can be rolled back
# instantly by flipping the symlink back, without a rebuild.
#
# Layout:
#   /opt/option-decode/releases/<git-sha>/   - one full checkout+build per deploy
#   /opt/option-decode/current               - symlink to the active release
#   /opt/option-decode/shared/.env.production - env file, symlinked into
#                                                 each release (not duplicated)
#   /opt/option-decode/logs/{api,worker,web}/ - persistent across releases
#
# Usage: ./native-deploy.sh [git-ref]   (defaults to origin/main)

set -euo pipefail

REPO_URL="git@github.com:nareshsingh64/option-decode.git"
BASE=/opt/option-decode
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
  # of inside a build stage.
  corepack enable
  corepack prepare pnpm@11.8.0 --activate
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

#!/bin/bash
# Renew the Dhan access token before it expires, and restart the services
# that hold it.
#
# WHY THIS EXISTS
# Dhan access tokens are valid for exactly 24 hours (SEBI guidance on API
# access management), and there is no long-lived credential that can replace
# them: the 12-month "API key & secret" only MINTS a token, and minting
# requires an interactive browser login with 2FA every time. The one
# automatable path is POST/GET /v2/RenewToken, which extends an ACTIVE token
# by another 24h with no browser. That is what this does.
#
# THE DANGEROUS PART, READ BEFORE EDITING
# Dhan's own docs: "This API expires your current token and provides you
# with a new token." The call is DESTRUCTIVE - the moment it succeeds, the
# token in .env.production is dead. If the new one is not persisted, the app
# is locked out of its own market data until someone logs into Dhan Web by
# hand. Hence: the new token is validated against a real authenticated
# endpoint BEFORE it is written, the env file is backed up and replaced
# atomically, and every failure path leaves the existing file untouched and
# exits non-zero.
#
# It also only works on tokens generated from Dhan Web ("tokenConsumerType":
# "SELF", empty partnerId). A partner-minted token cannot be renewed this
# way and needs the consent flow instead - the preflight check below refuses
# rather than burning the token to find out.
#
# WHY IT RESTARTS SERVICES
# api and worker both read DHAN_ACCESS_TOKEN from EnvironmentFile at start,
# so writing the file changes nothing for the running processes. api is the
# one that matters most: it makes ~300 ticker LTP/OHLC calls every 6 hours
# and, unlike worker, is NOT restarted by any timer - it would carry a dead
# token until the next deploy.
#
# SCHEDULE, AND WHAT IT CANNOT DO
# The EC2 instance runs 08:15-23:55 IST, Mon-Fri. That is 8.3h down every
# weeknight and 56.3h down over the weekend, against a token that lives 24h.
#
# Weeknights are fine: renewing at 22:00 IST leaves 13.75h at the next boot.
# WEEKENDS ARE IMPOSSIBLE. Any token renewed on Friday expires Saturday,
# while the box is off, and an expired token cannot be renewed - only
# replaced by hand at web.dhan.co. So MONDAY MORNING ALWAYS NEEDS A MANUAL
# TOKEN. No cron schedule can fix that; only a longer-lived credential could,
# and Dhan does not offer one. The post-boot run exists partly to say so
# loudly rather than let Monday fail as a wall of 401s.
#
# Usage:
#   dhan-token-renew.sh --dry-run              # check and report only
#   dhan-token-renew.sh                        # renew if <12h left
#   dhan-token-renew.sh --threshold-hours 25   # renew unconditionally

set -uo pipefail

ENV_FILE=/opt/option-decode-native/shared/.env.production
BACKUP_DIR=/opt/option-decode-native/shared/token-backups
LOG_TAG="dhan-token-renew"
# Renew when the token has less than this left. Guards against a cron that
# fires twice, and against burning a freshly-issued token for no reason.
RENEW_IF_HOURS_LEFT_BELOW=12
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    # The pre-shutdown run passes a threshold above the 24h token life so it
    # always renews, sending a full-life token into the overnight gap. There
    # is no cost to renewing early - it simply resets the 24h clock.
    --threshold-hours) shift; RENEW_IF_HOURS_LEFT_BELOW="${1:?--threshold-hours needs a value}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[$LOG_TAG $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { log "FAILED: $*"; exit 1; }

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"

TOKEN=$(grep '^DHAN_ACCESS_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')
CLIENT_ID=$(grep '^DHAN_CLIENT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$TOKEN" ] || die "DHAN_ACCESS_TOKEN missing from $ENV_FILE"
[ -n "$CLIENT_ID" ] || die "DHAN_CLIENT_ID missing from $ENV_FILE"

# --- Preflight: is this token renewable, and does it need renewing? -------
PREFLIGHT=$(TOKEN="$TOKEN" python3 - <<'PY'
import base64, json, os, time
tok = os.environ["TOKEN"]
try:
    c = json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "=="))
except Exception as e:
    print("ERR could not decode JWT: %s" % e); raise SystemExit
exp = c.get("exp")
if not exp:
    print("ERR token has no exp claim"); raise SystemExit
left_h = (exp - time.time()) / 3600.0
if c.get("partnerId"):
    print("ERR partner-minted token; /v2/RenewToken only renews Dhan Web tokens"); raise SystemExit
if left_h <= 0:
    # Expected every Monday: the box is off from Fri 23:55 to Mon 08:15,
    # which is 56h against a 24h token. Nothing can renew this; say so in
    # terms that are actionable rather than leaving a wall of 401s.
    print("ERR MANUAL ACTION REQUIRED - token expired %.1fh ago. It cannot be renewed, "
          "only regenerated at web.dhan.co > My Profile > Access DhanHQ APIs. "
          "Expected on Mondays: the weekend shutdown (56h) outlives a 24h token." % -left_h)
    raise SystemExit
print("OK %.2f" % left_h)
PY
)
case "$PREFLIGHT" in
  ERR*) die "${PREFLIGHT#ERR }" ;;
esac
HOURS_LEFT=$(echo "$PREFLIGHT" | awk '{print $2}')
log "token valid, ${HOURS_LEFT}h remaining"

if awk "BEGIN{exit !($HOURS_LEFT > $RENEW_IF_HOURS_LEFT_BELOW)}"; then
  log "more than ${RENEW_IF_HOURS_LEFT_BELOW}h left - nothing to do"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: would call /v2/RenewToken, validate, persist, restart api+worker"
  exit 0
fi

# --- Renew. POST first; some docs show GET, so fall back on 404/405 ------
log "calling /v2/RenewToken"
RESP=$(curl -s -w '\n%{http_code}' -X POST 'https://api.dhan.co/v2/RenewToken' \
  -H "access-token: $TOKEN" -H "dhanClientId: $CLIENT_ID" -H 'Content-Type: application/json')
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
if [ "$CODE" = "404" ] || [ "$CODE" = "405" ]; then
  log "POST returned $CODE, retrying as GET (docs disagree on the verb; neither 404 nor 405 consumes the token)"
  RESP=$(curl -s -w '\n%{http_code}' 'https://api.dhan.co/v2/RenewToken' \
    -H "access-token: $TOKEN" -H "dhanClientId: $CLIENT_ID")
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
fi
[ "$CODE" = "200" ] || die "RenewToken HTTP $CODE - existing token left in place, no harm done. Body: $(echo "$BODY" | head -c 500)"

NEW_TOKEN=$(BODY="$BODY" python3 - <<'PY'
import json, os
try:
    d = json.loads(os.environ["BODY"])
except Exception:
    print(""); raise SystemExit
for k in ("accessToken", "access_token", "token"):
    if isinstance(d.get(k), str) and d[k].count(".") == 2:
        print(d[k]); raise SystemExit
print("")
PY
)
[ -n "$NEW_TOKEN" ] || die "no JWT in RenewToken response - THE OLD TOKEN IS NOW DEAD. Recover by hand from this body if a token is in it (logged in full deliberately: a JWT is ~300 chars, so truncating here could destroy the only copy). Body: $BODY"

# Sanity-check the new token before trusting it.
CHECK=$(NEW_TOKEN="$NEW_TOKEN" python3 - <<'PY'
import base64, json, os, time
c = json.loads(base64.urlsafe_b64decode(os.environ["NEW_TOKEN"].split(".")[1] + "=="))
left = (c.get("exp", 0) - time.time()) / 3600.0
print("OK %.1f" % left if left > 1 else "ERR new token expires in %.1fh" % left)
PY
)
case "$CHECK" in ERR*) die "${CHECK#ERR }" ;; esac
log "new token accepted by Dhan, valid for $(echo "$CHECK" | awk '{print $2}')h"

# Prove it actually authenticates BEFORE persisting.
VERIFY=$(curl -s -o /dev/null -w '%{http_code}' 'https://api.dhan.co/v2/fundlimit' \
  -H "access-token: $NEW_TOKEN" -H "dhanClientId: $CLIENT_ID")
[ "$VERIFY" = "200" ] || die "new token rejected by /v2/fundlimit (HTTP $VERIFY). The old token is likely dead - regenerate at web.dhan.co"
log "new token verified against /v2/fundlimit"

# --- Persist atomically, keeping the old one recoverable -----------------
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
cp -p "$ENV_FILE" "$BACKUP_DIR/.env.production.$(date -u +%Y%m%dT%H%M%SZ)" || die "backup failed"
find "$BACKUP_DIR" -name '.env.production.*' -mtime +14 -delete 2>/dev/null

TMP=$(mktemp "${ENV_FILE}.XXXXXX") || die "mktemp failed"
chmod --reference="$ENV_FILE" "$TMP" 2>/dev/null || chmod 600 "$TMP"
chown --reference="$ENV_FILE" "$TMP" 2>/dev/null || true
NEW_TOKEN="$NEW_TOKEN" python3 - "$ENV_FILE" "$TMP" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
new = os.environ["NEW_TOKEN"]
wrote = False
with open(src) as fh, open(dst, "w") as out:
    for line in fh:
        if line.startswith("DHAN_ACCESS_TOKEN="):
            out.write("DHAN_ACCESS_TOKEN=%s\n" % new); wrote = True
        else:
            out.write(line)
if not wrote:
    sys.exit("DHAN_ACCESS_TOKEN line vanished")
PY
[ $? -eq 0 ] || { rm -f "$TMP"; die "rewrite failed - env file untouched"; }
grep -q '^DHAN_ACCESS_TOKEN=' "$TMP" || { rm -f "$TMP"; die "sanity check failed - env file untouched"; }
mv -f "$TMP" "$ENV_FILE" || die "atomic replace failed"
log "token persisted to $ENV_FILE (backup kept)"

# --- Restart the holders -------------------------------------------------
systemctl restart option-decode-api option-decode-worker || die "token persisted but restart failed - restart api+worker by hand"
sleep 5
for u in option-decode-api option-decode-worker; do
  systemctl is-active --quiet "$u" || die "$u did not come back after restart"
done
log "api and worker restarted on the new token"
log "SUCCESS"

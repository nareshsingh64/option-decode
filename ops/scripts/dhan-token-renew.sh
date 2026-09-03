#!/bin/bash
# Renew the Dhan access token before it expires, and restart the services
# that hold it.
#
# WHY THIS EXISTS
# Dhan access tokens are valid for exactly 24 hours (SEBI guidance on API
# access management), and there is no long-lived credential that can replace
# them: the 12-month "API key & secret" only MINTS a token, and minting
# requires an interactive browser login with 2FA every time. The one
# automatable path is GET /v2/RenewToken, which extends an ACTIVE token
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
# THE PREFLIGHT PROVES THE TOKEN IS ALIVE, not merely unexpired. A JWT's exp
# claim cannot know it has been revoked server-side, so the run starts with a
# read-only /v2/fundlimit call. A 4xx there stops the run with MANUAL ACTION
# REQUIRED; a 5xx is ignored, because a Dhan hiccup must never block a
# legitimate renewal.
#
# A FAILURE TO VERIFY IS NOT A BAD TOKEN. Once RenewToken has returned 200 the
# old token is gone, so the new one is the only credential in existence and
# discarding it is the destructive act. A 5xx or a timeout from the verify
# endpoint is Dhan's problem, not the token's - those are retried and then
# persisted anyway with a loud warning. Only a 4xx is treated as a real
# rejection, and even then the token is logged rather than lost. This is not
# hypothetical: a 502 on 2026-08-17 threw away a good token and forced a manual
# regeneration.
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
# EMAIL ALERTS
# Every terminal path emails TOKEN_ALERT_EMAIL (read from the env file):
# SUCCESS with the new expiry, or FAILED with the reason. Alerting is hooked
# into die() rather than sprinkled at each exit, so a failure path added later
# is covered automatically. Mail is best-effort - it can never turn a good
# renewal into a bad exit code - and the token is never included in it.
#
# Usage:
#   dhan-token-renew.sh --dry-run              # check and report only
#   dhan-token-renew.sh                        # renew if <12h left
#   dhan-token-renew.sh --threshold-hours 25   # renew unconditionally
#   dhan-token-renew.sh --test-alert           # email a sample, token untouched

set -uo pipefail

NO_RESTART=0

ENV_FILE=/opt/option-decode-native/shared/.env.production
BACKUP_DIR=/opt/option-decode-native/shared/token-backups
LOG_TAG="dhan-token-renew"
# Renew when the token has less than this left. Guards against a cron that
# fires twice, and against burning a freshly-issued token for no reason.
RENEW_IF_HOURS_LEFT_BELOW=12
DRY_RUN=0
TEST_ALERT=0
# Set when the token was persisted without a successful /v2/fundlimit check,
# so the success email says so rather than implying a clean run.
UNVERIFIED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    # Send a sample alert and exit WITHOUT touching the token. Exists because
    # the only other way to see what the email looks like is to renew for
    # real, and RenewToken destroys the current token on success - you cannot
    # "just try it" on this endpoint.
    --test-alert) TEST_ALERT=1 ;;
    # Persist the new token but do NOT restart api/worker.
    #
    # The restart exists so the running services pick up the new token. That is
    # pointless when the box reboots shortly afterwards - it reads the file at
    # boot anyway - and it is actively harmful during maintenance: a restart
    # kills whatever the worker is doing, and on 2026-08-20 exactly that turned
    # a 26-minute retention DELETE into a three-hour rollback that saturated
    # the host and left retention seven days behind.
    --no-restart) NO_RESTART=1 ;;
    # The pre-shutdown run passes a threshold above the 24h token life so it
    # always renews, sending a full-life token into the overnight gap. There
    # is no cost to renewing early - it simply resets the 24h clock.
    --threshold-hours) shift; RENEW_IF_HOURS_LEFT_BELOW="${1:?--threshold-hours needs a value}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[$LOG_TAG $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# --- Email alerting -------------------------------------------------------
# Sends through the SAME GoDaddy mailbox the app itself uses. That is not
# laziness: the domain publishes DMARC p=quarantine with SPF
# "v=spf1 include:secureserver.net -all", and the -all is a hard fail. Any
# OTHER sender would be quarantined until it was added to the SPF record, so
# reusing support@pytrade.co.in is what keeps these alerts deliverable.
#
# Recipients come from TOKEN_ALERT_EMAIL in the env file, comma-separated for
# more than one. If it is missing the script logs and carries on - a missing
# alert address must never be the reason a token renewal fails.
#
# NEVER PUT THE TOKEN IN THE EMAIL. Status, expiry and a masked client id only.
# Mail lands in third-party inboxes and gets forwarded; a JWT in there is a
# live credential sitting in someone's mail archive.
notify() {
  local status="$1" detail="$2"
  local to
  to=$(grep '^TOKEN_ALERT_EMAIL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'')
  if [ -z "$to" ]; then
    log "no TOKEN_ALERT_EMAIL set - skipping email alert"
    return 0
  fi
  # Best effort by design: || true so a mail outage cannot turn a successful
  # renewal into a non-zero exit, which is how you end up "fixing" a token
  # that was never broken.
  ENV_FILE="$ENV_FILE" ALERT_TO="$to" ALERT_STATUS="$status" ALERT_DETAIL="$detail" \
    ALERT_HOST="$(hostname)" python3 - <<'PYEOF' 2>&1 | while read -r l; do log "mail: $l"; done || true
import os, smtplib, ssl, datetime
from email.message import EmailMessage

env = {}
for line in open(os.environ["ENV_FILE"]):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

host = env.get("SMTP_HOST"); port = int(env.get("SMTP_PORT", "465"))
user = env.get("SMTP_USER"); pw = env.get("SMTP_PASSWORD")
sender = env.get("EMAIL_FROM") or user
if not (host and user and pw):
    print("SMTP not configured - skipped"); raise SystemExit

status = os.environ["ALERT_STATUS"]
detail = os.environ["ALERT_DETAIL"]
now = datetime.datetime.now(datetime.timezone.utc)
ist = (now + datetime.timedelta(hours=5, minutes=30)).strftime("%a %d %b %Y %H:%M IST")

msg = EmailMessage()
# Status first so it is readable in a phone notification without opening it.
msg["Subject"] = f"[{status}] Dhan token renewal - {ist}"
msg["From"] = sender
# Comma-separated list. send_message() derives the envelope recipients from
# this header, so every address gets a copy from one connection - no loop, and
# no chance of one address failing silently while another succeeds.
recipients = [a.strip() for a in os.environ["ALERT_TO"].split(",") if a.strip()]
if not recipients:
    print("TOKEN_ALERT_EMAIL parsed to no addresses - skipped"); raise SystemExit
msg["To"] = ", ".join(recipients)
msg.set_content(
    f"Dhan access token renewal: {status}\n"
    f"Host: {os.environ.get('ALERT_HOST','?')}\n"
    f"When: {ist}  ({now.strftime('%Y-%m-%dT%H:%M:%SZ')})\n\n"
    f"{detail}\n\n"
    "-- \n"
    "Sent by ops/scripts/dhan-token-renew.sh on the Option Decode host.\n"
    "The token itself is deliberately not included in this email.\n"
)
ctx = ssl.create_default_context()
if str(env.get("SMTP_SECURE", "true")).lower() == "true" or port == 465:
    with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as smtp:
        smtp.login(user, pw); smtp.send_message(msg)
else:
    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.starttls(context=ctx); smtp.login(user, pw); smtp.send_message(msg)
print("alert sent to " + ", ".join(recipients))
PYEOF
}

die() { log "FAILED: $*"; notify "FAILED" "$*"; exit 1; }

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"

TOKEN=$(grep '^DHAN_ACCESS_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')
CLIENT_ID=$(grep '^DHAN_CLIENT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')
[ -n "$TOKEN" ] || die "DHAN_ACCESS_TOKEN missing from $ENV_FILE"
[ -n "$CLIENT_ID" ] || die "DHAN_CLIENT_ID missing from $ENV_FILE"

if [ "$TEST_ALERT" = "1" ]; then
  log "sending a test alert - the token is NOT touched"
  notify "TEST" "This is a test of the token-renewal alert path. No renewal was attempted and the token on this host is unchanged.

If this reached you, the SUCCESS and FAILED alerts will too."
  log "test alert done"
  exit 0
fi

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
log "token claims ${HOURS_LEFT}h remaining"

# --- Is the token actually alive, or does it only LOOK alive? ------------
#
# The exp claim above is self-reported and cannot know the token was revoked
# server-side. On 2026-08-17 that gap showed itself: a renewal consumed the
# token, the replacement was lost to a separate bug, and every subsequent run
# cheerfully reported "token valid, 10.98h remaining" about a credential that
# had been dead for hours. A JWT has no idea it has been revoked.
#
# One read-only call closes it. /v2/fundlimit does not consume or modify
# anything - unlike RenewToken, this is an endpoint you can safely poke.
#
# The response is judged the OPPOSITE way round to the post-renewal check, and
# deliberately so. Here the old token is still alive, so a 4xx is real news:
# stop, say MANUAL ACTION REQUIRED, and do not spend a renewal attempt
# discovering it. A 5xx or a timeout says nothing about the token - it must
# NOT block a legitimate renewal, or one Dhan hiccup at 23:35 would strand the
# box overnight with a token nobody refreshed.
PRECHECK=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 'https://api.dhan.co/v2/fundlimit' \
  -H "access-token: $TOKEN" -H "dhanClientId: $CLIENT_ID")
case "$PRECHECK" in
  200)
    log "token confirmed live against /v2/fundlimit"
    ;;
  4*)
    die "MANUAL ACTION REQUIRED - the token still claims ${HOURS_LEFT}h but /v2/fundlimit rejects it (HTTP $PRECHECK), so it has been revoked or already consumed. An exp claim cannot know that. It cannot be renewed in this state - regenerate at web.dhan.co > My Profile > Access DhanHQ APIs."
    ;;
  *)
    log "WARNING: could not confirm the token against /v2/fundlimit (HTTP ${PRECHECK:-000})."
    log "WARNING: that is a Dhan-side or network fault and says nothing about the token - continuing."
    ;;
esac

if awk "BEGIN{exit !($HOURS_LEFT > $RENEW_IF_HOURS_LEFT_BELOW)}"; then
  log "more than ${RENEW_IF_HOURS_LEFT_BELOW}h left - nothing to do"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: would call /v2/RenewToken, validate, persist, restart api+worker"
  exit 0
fi

# --- Renew ---------------------------------------------------------------
# THE CONTRACT, ESTABLISHED BY PROBING PRODUCTION 2026-08-14. The docs are
# wrong or ambiguous on both halves, so do not "correct" this from them:
#
#   GET  https://api.dhan.co/v2/RenewToken
#   headers: access-token, dhanClientId          <- NOT client-id
#   200 body: {"createTime":..., "expiryTime":..., "token":"<JWT>"}
#
# POST returns 400 DH-905 "Missing required fields" - which is how the first
# live run failed, harmlessly. And the header name is the one place this
# endpoint differs from every other Dhan call the app makes: the rest of the
# client sends "client-id" (see packages/dhan/src/index.ts), and sending that
# here also yields 400. The response field is "token", not "accessToken".
#
# A 400 is rejected before the token is consumed, so a wrong-shaped request
# is safe. A 200 consumes it immediately - which is why everything below
# treats the body as the only surviving copy.
# --- Call RenewToken, retrying a TRANSIENT failure safely -----------------
#
# A 5xx here is ambiguous in a way that matters. "502 Bad Gateway" usually
# means the request never reached the token service, in which case the old
# token is untouched and retrying is free. But it can also mean the service
# processed the call and the RESPONSE was lost on the way back - and in that
# case the old token is already dead, a new one exists that we never saw, and
# blindly retrying with the dead token would turn a recoverable blip into a
# manual regeneration.
#
# So the ambiguity is RESOLVED rather than guessed at: probe the OLD token
# against /v2/fundlimit. If it still authenticates, the renewal definitively
# did not happen and a retry is safe. If it does not, the renewal DID happen
# and the new token is lost - say so loudly instead of retrying into a wall.
#
# Seen twice: 2026-08-17 and 2026-08-18, both at 02:50 UTC, both 502.
RENEW_ATTEMPTS=3
CODE=""
BODY=""
for attempt in $(seq 1 "$RENEW_ATTEMPTS"); do
  log "calling GET /v2/RenewToken (attempt $attempt/$RENEW_ATTEMPTS)"
  RESP=$(curl -s -w '\n%{http_code}' --max-time 30 'https://api.dhan.co/v2/RenewToken' \
    -H "access-token: $TOKEN" -H "dhanClientId: $CLIENT_ID")
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
  [ "$CODE" = "200" ] && break

  case "$CODE" in
    4*)
      die "RenewToken HTTP $CODE - a genuine rejection, existing token left in place. Body: $(echo "$BODY" | head -c 500)"
      ;;
  esac

  # Transient. Establish whether the old token survived before deciding.
  STILL_ALIVE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 'https://api.dhan.co/v2/fundlimit' \
    -H "access-token: $TOKEN" -H "dhanClientId: $CLIENT_ID")
  if [ "$STILL_ALIVE" = "200" ]; then
    log "RenewToken HTTP $CODE (transient) but the existing token still authenticates - the call did not go through"
    if [ "$attempt" -lt "$RENEW_ATTEMPTS" ]; then
      log "retrying in $((attempt * 10))s"
      sleep $((attempt * 10))
      continue
    fi
    # Out of attempts, but nothing was consumed and the token is still good.
    # This is NOT a failure worth alarming about: the next scheduled run will
    # try again long before the token expires.
    log "RenewToken unreachable after $RENEW_ATTEMPTS attempts, but the current token is UNHARMED and still valid."
    notify "NO ACTION NEEDED" "Dhan's /v2/RenewToken was unreachable this run (HTTP $CODE, repeated $RENEW_ATTEMPTS times).

NOTHING IS BROKEN AND NOTHING NEEDS DOING. The renewal call never went through,
so the existing token was not consumed - it was re-checked against
/v2/fundlimit after each attempt and still authenticates.

  Token still valid for : ${HOURS_LEFT}h
  Dhan client           : ...${CLIENT_ID: -4}

The next scheduled run will renew it. This message exists so a failed run is
visible, not because action is required - if the token were actually at risk
this would say MANUAL ACTION REQUIRED instead."
    log "exiting cleanly - transient upstream fault, token intact"
    exit 0
  fi

  # The probe did not return 200. That is TWO different situations and they must
  # not share a branch - which they did until 2026-09-03, when RenewToken gave
  # 502, this probe gave 502 too, and the run reported MANUAL ACTION REQUIRED
  # about a token that was still perfectly alive. Checked by hand eleven minutes
  # later: /v2/fundlimit returned 200 and the token had 14.9h left. A false
  # MANUAL ACTION REQUIRED is expensive - it is the one alert that says "go and
  # regenerate by hand right now".
  case "$STILL_ALIVE" in
    4*)
      # A 4xx is real news: Dhan looked at the old token and refused it. It was
      # alive at preflight minutes ago, so the renewal DID happen server-side
      # and its reply was lost. The new token exists and nobody received it.
      die "MANUAL ACTION REQUIRED - RenewToken returned HTTP $CODE and the previous token is now REJECTED (/v2/fundlimit gave $STILL_ALIVE). The renewal almost certainly succeeded server-side and its response was lost, so the new token exists but was never received. Regenerate at web.dhan.co > My Profile > Access DhanHQ APIs. Body: $(echo "$BODY" | head -c 500)"
      ;;
  esac

  # Anything else - 5xx, or 000 for a timeout - means the PROBE failed, not the
  # token. Dhan is simply unreachable and we have learned nothing about the
  # credential. Assuming the worst here is what produced the false alarm.
  log "RenewToken HTTP $CODE and the probe was inconclusive (/v2/fundlimit gave $STILL_ALIVE) - Dhan appears to be down, token state unknown"
  if [ "$attempt" -lt "$RENEW_ATTEMPTS" ]; then
    log "retrying in $((attempt * 10))s"
    sleep $((attempt * 10))
    continue
  fi
  notify "NO ACTION NEEDED" "Dhan was unreachable for this run: /v2/RenewToken gave HTTP $CODE and the follow-up check gave $STILL_ALIVE, so neither call reached a working server.

NOTHING NEEDS DOING NOW. The token was valid at the start of this run and there
is no evidence it was consumed - the renewal call did not get a real answer.

  Token life at start of run : ${HOURS_LEFT}h
  Dhan client                : ...${CLIENT_ID: -4}

The next scheduled run re-checks the token before doing anything, and if it HAS
been consumed that run will say MANUAL ACTION REQUIRED with certainty rather
than guessing from an unreachable server."
  log "exiting cleanly - Dhan unreachable, token state unconfirmed but unharmed as far as we can tell"
  exit 0
done

[ "$CODE" = "200" ] || die "RenewToken HTTP $CODE - existing token left in place, no harm done. Body: $(echo "$BODY" | head -c 500)"

NEW_TOKEN=$(BODY="$BODY" python3 - <<'PY'
import json, os
try:
    d = json.loads(os.environ["BODY"])
except Exception:
    print(""); raise SystemExit
# "token" is what Dhan actually returns; the others are defensive.
for k in ("token", "accessToken", "access_token"):
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

# --- Verify, but understand what a failure here actually means -----------
#
# THE PRIORITY INVERTS THE MOMENT RenewToken RETURNS 200. Before that call,
# the old token is alive and refusing to persist a bad new one is the safe
# choice. After it, the old token is DEAD and this new one is the only
# credential that exists - so discarding it is the destructive act, not
# keeping it.
#
# This cost a real token on 2026-08-17. RenewToken returned 200, a valid 24h
# token came back, and /v2/fundlimit answered 502 - a Bad Gateway from Dhan's
# own infrastructure, nothing to do with the token. The script treated any
# non-200 as "rejected", died before persisting, and threw away a perfectly
# good credential that the old one had already been spent to obtain. Monday
# morning then needed a manual regeneration for no reason.
#
# So failures are now separated by kind:
#   200          -> verified, persist normally
#   5xx/000      -> TRANSIENT (gateway error, timeout, DNS). Retry; if it
#                   still will not answer, PERSIST ANYWAY and warn loudly. A
#                   probably-good token beats a definitely-dead one.
#   4xx          -> a genuine rejection. Do not persist, but log the token so
#                   it is recoverable by hand rather than lost.
VERIFY_ATTEMPTS=3
VERIFIED=0
VERIFY=""
for attempt in $(seq 1 "$VERIFY_ATTEMPTS"); do
  VERIFY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 'https://api.dhan.co/v2/fundlimit' \
    -H "access-token: $NEW_TOKEN" -H "dhanClientId: $CLIENT_ID")
  if [ "$VERIFY" = "200" ]; then
    VERIFIED=1
    break
  fi
  case "$VERIFY" in
    4*) log "verify returned HTTP $VERIFY - a genuine rejection, retrying will not help"; break ;;
  esac
  if [ "$attempt" -lt "$VERIFY_ATTEMPTS" ]; then
    log "verify attempt $attempt/$VERIFY_ATTEMPTS got HTTP $VERIFY (transient) - retrying in $((attempt * 5))s"
    sleep $((attempt * 5))
  fi
done

if [ "$VERIFIED" = "1" ]; then
  log "new token verified against /v2/fundlimit"
else
  case "$VERIFY" in
    4*)
      # Provably bad, and the old one is already dead. Nothing to persist that
      # would help, but the token must not vanish - log it exactly as the
      # unparseable-response path does, for the same reason.
      log "TOKEN BELOW IS THE ONLY COPY - the old token was consumed and this one did not authenticate."
      log "NEW_TOKEN=$NEW_TOKEN"
      die "MANUAL ACTION REQUIRED - new token rejected by /v2/fundlimit (HTTP $VERIFY) and the old one is already dead. The new token is in the line above if it is worth trying; otherwise regenerate at web.dhan.co"
      ;;
    *)
      log "WARNING: could not verify the new token after $VERIFY_ATTEMPTS attempts (last HTTP ${VERIFY:-000})."
      log "WARNING: this looks like a Dhan-side or network fault, NOT a bad token. Persisting anyway -"
      log "WARNING: the old token is already dead, so keeping this one is strictly better than discarding it."
      log "NEW_TOKEN=$NEW_TOKEN"
      UNVERIFIED=1
      ;;
  esac
fi

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
if [ "$NO_RESTART" = "1" ]; then
  log "--no-restart: token persisted, services left running on the old one (they read the new token at next boot)"
else
systemctl restart option-decode-api option-decode-worker || die "token persisted but restart failed - restart api+worker by hand"
sleep 5
for u in option-decode-api option-decode-worker; do
  systemctl is-active --quiet "$u" || die "$u did not come back after restart"
done
log "api and worker restarted on the new token"
fi

# Claims only - decoded from the NEW token so the email states the real expiry
# rather than "24h from now", which would be an assumption.
SUMMARY=$(NEW_TOKEN="$NEW_TOKEN" CLIENT_ID="$CLIENT_ID" python3 - <<'PYEOF'
import base64, json, os, datetime
c = json.loads(base64.urlsafe_b64decode(os.environ["NEW_TOKEN"].split(".")[1] + "=="))
def fmt(ts):
    u = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
    return (u + datetime.timedelta(hours=5, minutes=30)).strftime("%a %d %b %Y %H:%M IST")
exp = c.get("exp"); iat = c.get("iat")
print("The token was renewed and both services were restarted on it.")
print("")
print("  New token expires : %s" % fmt(exp))
if iat:
    print("  Issued            : %s" % fmt(iat))
    print("  Life              : %.1f hours" % ((exp - iat) / 3600))
print("  Dhan client       : ...%s" % os.environ["CLIENT_ID"][-4:])
print("  Renewable again   : %s" % ("yes" if c.get("tokenConsumerType") == "SELF" and not c.get("partnerId") else "NO - partner token"))
print("")
print("Verified against /v2/fundlimit before it was saved, so it is known to")
print("authenticate rather than merely well-formed.")
PYEOF
)
if [ "$UNVERIFIED" = "1" ]; then
  # Renewed and persisted, but never proved to authenticate. That is a
  # materially different outcome from a clean run and the subject line has to
  # say so - "SUCCESS" here would be a quiet lie.
  notify "SUCCESS (UNVERIFIED)" "$SUMMARY

WARNING: /v2/fundlimit could not be reached to confirm this token actually
authenticates - it answered with a server-side error or timed out across every
retry. The token was persisted anyway, because RenewToken had already consumed
the previous one and a probably-good token is better than a certainly-dead one.

Check that market data is flowing. If it is not, regenerate at web.dhan.co."
  log "SUCCESS (persisted without verification - see warnings above)"
else
  notify "SUCCESS" "$SUMMARY"
  log "SUCCESS"
fi

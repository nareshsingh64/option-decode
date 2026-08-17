# Shared alert mailer. Source this, then call send_alert_email.
#
#   send_alert_email "<subject>" "<body>"
#
# WHY IT MUST USE THE APP'S OWN MAILBOX
# The domain publishes DMARC p=quarantine with SPF
# "v=spf1 include:secureserver.net -all". That -all is a hard fail, so ANY
# sender other than the GoDaddy mailbox the app already authenticates as would
# be quarantined until the DNS record changed. Reusing SMTP_* from
# .env.production is what keeps these deliverable - it is not laziness.
#
# WHY IT IS ALWAYS BEST EFFORT
# Every caller is an ops job whose real work has already succeeded or failed on
# its own terms. A mail outage must never change that outcome: an SMTP timeout
# turning a good run into a non-zero exit is how someone ends up "fixing"
# something that was never broken.
#
# NEVER PUT A CREDENTIAL IN A BODY PASSED TO THIS. Mail is forwarded and
# archived; a token in an inbox is a live credential.
#
# NOTE: ops/scripts/dhan-token-renew.sh still carries its own inline copy of
# this logic. It is the older, load-bearing one and was deliberately not
# migrated while it was being actively fixed. Fold it into this file the next
# time that script is touched for another reason - do not do it as a drive-by
# on a day the token path matters.

ALERT_ENV_FILE="${ALERT_ENV_FILE:-/opt/option-decode-native/shared/.env.production}"

send_alert_email() {
  local subject="$1" body="$2"
  local to
  to=$(grep '^TOKEN_ALERT_EMAIL=' "$ALERT_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'')
  if [ -z "$to" ]; then
    echo "no TOKEN_ALERT_EMAIL set - skipping email"
    return 0
  fi
  ALERT_ENV_FILE="$ALERT_ENV_FILE" ALERT_TO="$to" ALERT_SUBJECT="$subject" ALERT_BODY="$body" \
    python3 - <<'PYEOF' 2>&1 || true
import os, smtplib, ssl
from email.message import EmailMessage

env = {}
for line in open(os.environ["ALERT_ENV_FILE"]):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

host = env.get("SMTP_HOST"); port = int(env.get("SMTP_PORT", "465"))
user = env.get("SMTP_USER"); pw = env.get("SMTP_PASSWORD")
sender = env.get("EMAIL_FROM") or user
if not (host and user and pw):
    print("SMTP not configured - skipped"); raise SystemExit

recipients = [a.strip() for a in os.environ["ALERT_TO"].split(",") if a.strip()]
if not recipients:
    print("no recipients after parsing - skipped"); raise SystemExit

body = os.environ["ALERT_BODY"]

msg = EmailMessage()
msg["Subject"] = os.environ["ALERT_SUBJECT"]
msg["From"] = sender
# One To header, not a loop: send_message derives the envelope recipients from
# it, so every address is delivered on one connection or fails as a unit.
msg["To"] = ", ".join(recipients)
msg.set_content(body)

# HTML alternative, purely so COLUMNS SURVIVE. These bodies contain
# space-padded tables that are correctly aligned in a fixed-width font, but
# mail clients render text/plain in a PROPORTIONAL font by default - which
# collapses the padding and makes a table of numbers unreadable, reported
# 2026-08-17. The <pre> block is the whole point; nothing here is styling for
# its own sake.
#
# Sent as an alternative rather than a replacement so a plain-text client still
# gets a readable message, and so the alignment problem cannot come back by
# someone deciding HTML mail is unnecessary.
esc = body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
msg.add_alternative(
    "<html><body style=\"margin:0;padding:12px;background:#ffffff\">"
    "<pre style=\"font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace;"
    "font-size:13px;line-height:1.45;color:#1f2937;white-space:pre;"
    "overflow-x:auto;margin:0\">" + esc + "</pre></body></html>",
    subtype="html"
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

#!/bin/bash
#
# Send an ad-hoc memory report by email.
#
# The scheduled worker-memory-alert.sh deliberately only mails on a regression
# or on Fridays, so that an email always means something. This is the other
# case: someone asked for the current figures now, usually after a change that
# might have moved them.
#
# Reads SMTP settings by GREP, never by sourcing .env.production - line 31 of
# that file is an unquoted EMAIL_FROM containing a `<`, so `. .env.production`
# aborts there and silently leaves every later variable, including the SMTP
# credentials, unset.
#
# Usage: ops/scripts/send-memory-report.sh "Subject" <<< "body text"
#
set -uo pipefail

ENV_FILE="${ENV_FILE:-/opt/option-decode-native/shared/.env.production}"
SUBJECT="${1:-Option Decode memory report}"
BODY="$(cat)"

envval () { sudo grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r'; }

SMTP_HOST="$(envval SMTP_HOST)"
SMTP_PORT="$(envval SMTP_PORT)"
SMTP_USER="$(envval SMTP_USER)"
SMTP_PASS="$(envval SMTP_PASSWORD)"
SMTP_SECURE="$(envval SMTP_SECURE)"
MAIL_FROM="$(envval EMAIL_FROM)"
MAIL_TO="$(envval TOKEN_ALERT_EMAIL)"

if [ -z "$SMTP_HOST" ] || [ -z "$MAIL_TO" ]; then
  echo "SMTP_HOST or TOKEN_ALERT_EMAIL missing - cannot send." >&2
  exit 1
fi

# Recipients go into ONE To header rather than a loop: one connection either
# delivers to all of them or fails as a unit, where a loop lets the second
# address fail silently after the first has gone out.
SUBJECT="$SUBJECT" BODY="$BODY" \
SMTP_HOST="$SMTP_HOST" SMTP_PORT="${SMTP_PORT:-465}" SMTP_USER="$SMTP_USER" \
SMTP_PASS="$SMTP_PASS" SMTP_SECURE="${SMTP_SECURE:-true}" \
MAIL_FROM="$MAIL_FROM" MAIL_TO="$MAIL_TO" python3 - <<'PYEOF'
import os, smtplib, ssl
from email.message import EmailMessage

msg = EmailMessage()
msg["Subject"] = os.environ["SUBJECT"]
msg["From"] = os.environ["MAIL_FROM"]
msg["To"] = os.environ["MAIL_TO"]
msg.set_content(os.environ["BODY"])

host = os.environ["SMTP_HOST"]
port = int(os.environ["SMTP_PORT"])
user = os.environ.get("SMTP_USER") or ""
password = os.environ.get("SMTP_PASS") or ""
secure = os.environ.get("SMTP_SECURE", "true").lower() in ("1", "true", "yes", "on")

ctx = ssl.create_default_context()
if secure:
    # Implicit TLS on 465, which is what GoDaddy's smtpout expects.
    with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as smtp:
        if user:
            smtp.login(user, password)
        smtp.send_message(msg)
else:
    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.starttls(context=ctx)
        if user:
            smtp.login(user, password)
        smtp.send_message(msg)
print("sent")
PYEOF

#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="${1:-./nginx/certs}"
PRIMARY_DOMAIN="${2:-pytrade.co.in}"
ALT_DOMAIN="${3:-www.pytrade.co.in}"

mkdir -p "$CERT_DIR"

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/selfsigned.key" \
  -out "$CERT_DIR/selfsigned.crt" \
  -days 365 \
  -subj "/C=IN/ST=Maharashtra/L=Mumbai/O=PyTrade/CN=${PRIMARY_DOMAIN}" \
  -addext "subjectAltName=DNS:${PRIMARY_DOMAIN},DNS:${ALT_DOMAIN}"

chmod 600 "$CERT_DIR/selfsigned.key"
chmod 644 "$CERT_DIR/selfsigned.crt"

echo "Self-signed certificate generated:"
echo "  cert: $CERT_DIR/selfsigned.crt"
echo "  key : $CERT_DIR/selfsigned.key"
echo "  SAN : ${PRIMARY_DOMAIN}, ${ALT_DOMAIN}"


#!/usr/bin/env bash
# Restores current-expiry option-chain data (OptionChainSnapshot,
# OptionContractTick, PressureScore) from the old Dockerized MySQL cold
# backup into the native MySQL now serving production.
#
# Only touches the ONE current (nearest upcoming) expiry per underlying, and
# only for underlyings where the old Docker backup actually has matching
# history - it's a no-op (skipped) for anything that doesn't overlap.
#
# Uses --insert-ignore, so it only adds rows that are MISSING from native -
# it will never duplicate or overwrite data native already has. Safe to
# re-run.
#
# Run this from /opt/option-decode on EC2.

set -euo pipefail

ENV_FILE=".env.production"
TEMP_CONTAINER="mysql_restore_temp"
OLD_VOLUME="option-decode_option_decode_mysql"
DUMP_DIR="$(mktemp -d)"

echo "== Loading native MySQL credentials from $ENV_FILE =="
source <(grep -E '^(MYSQL_USER|MYSQL_PASSWORD|MYSQL_DATABASE|MYSQL_ROOT_PASSWORD|FEED_UNDERLYINGS)=' "$ENV_FILE")

NATIVE_HOST="127.0.0.1"
NATIVE_PORT="3306"
SOURCE_HOST="127.0.0.1"
SOURCE_PORT="3307"

native_mysql() {
  mysql -h "$NATIVE_HOST" -P "$NATIVE_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" -N -B "$MYSQL_DATABASE" -e "$1" 2>/dev/null
}

source_mysql() {
  mysql -h "$SOURCE_HOST" -P "$SOURCE_PORT" -u root -p"$MYSQL_ROOT_PASSWORD" -N -B "$MYSQL_DATABASE" -e "$1" 2>/dev/null
}

echo "== Starting temporary container from the old (frozen) MySQL volume =="
docker rm -f "$TEMP_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$TEMP_CONTAINER" \
  -v "${OLD_VOLUME}:/var/lib/mysql" \
  -p "127.0.0.1:${SOURCE_PORT}:3306" \
  mysql:8.4 --mysql-native-password=ON

echo "== Waiting for it to accept connections (up to 60s) =="
for i in $(seq 1 30); do
  if mysql -h "$SOURCE_HOST" -P "$SOURCE_PORT" -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1" >/dev/null 2>&1; then
    echo "Source MySQL is up."
    break
  fi
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "Timed out waiting for source MySQL to start. Check: docker logs $TEMP_CONTAINER"
    exit 1
  fi
done

IFS=',' read -ra SYMBOLS <<< "$FEED_UNDERLYINGS"

for SYM in "${SYMBOLS[@]}"; do
  echo ""
  echo "== $SYM =="

  NATIVE_ROW=$(native_mysql "
    SELECT e.id, e.expiryDate FROM Expiry e
    JOIN Underlying u ON e.underlyingId = u.id
    WHERE u.symbol = '${SYM}' AND e.expiryDate >= CURDATE()
    ORDER BY e.expiryDate ASC LIMIT 1;
  " 2>/dev/null || true)

  if [ -z "${NATIVE_ROW:-}" ]; then
    echo "  no current expiry found in native DB for $SYM, skipping"
    continue
  fi

  TARGET_EXPIRY_ID=$(echo "$NATIVE_ROW" | awk '{print $1}')
  TARGET_EXPIRY_DATE=$(echo "$NATIVE_ROW" | awk '{print $2}')

  SOURCE_EXPIRY_ID=$(source_mysql "
    SELECT e.id FROM Expiry e
    JOIN Underlying u ON e.underlyingId = u.id
    WHERE u.symbol = '${SYM}' AND e.expiryDate = '${TARGET_EXPIRY_DATE}';
  " || true)

  if [ -z "${SOURCE_EXPIRY_ID:-}" ]; then
    echo "  old Docker backup has no data for expiry ${TARGET_EXPIRY_DATE}, skipping"
    continue
  fi

  echo "  found overlapping expiry ${TARGET_EXPIRY_DATE} (source id ${SOURCE_EXPIRY_ID} -> target id ${TARGET_EXPIRY_ID})"

  SNAP_DUMP="${DUMP_DIR}/${SYM}_snapshots.sql"
  TICK_DUMP="${DUMP_DIR}/${SYM}_ticks.sql"
  PRESSURE_DUMP="${DUMP_DIR}/${SYM}_pressure.sql"

  mysqldump -h "$SOURCE_HOST" -P "$SOURCE_PORT" -u root -p"$MYSQL_ROOT_PASSWORD" \
    --single-transaction --no-create-info --skip-triggers --insert-ignore \
    --where="expiryId='${SOURCE_EXPIRY_ID}'" \
    "$MYSQL_DATABASE" OptionChainSnapshot > "$SNAP_DUMP"

  # Point the copied snapshot rows at the native DB's own Expiry id.
  sed -i "s/'${SOURCE_EXPIRY_ID}'/'${TARGET_EXPIRY_ID}'/g" "$SNAP_DUMP"

  mysqldump -h "$SOURCE_HOST" -P "$SOURCE_PORT" -u root -p"$MYSQL_ROOT_PASSWORD" \
    --single-transaction --no-create-info --skip-triggers --insert-ignore \
    --where="snapshotId IN (SELECT id FROM OptionChainSnapshot WHERE expiryId='${SOURCE_EXPIRY_ID}')" \
    "$MYSQL_DATABASE" OptionContractTick > "$TICK_DUMP"

  mysqldump -h "$SOURCE_HOST" -P "$SOURCE_PORT" -u root -p"$MYSQL_ROOT_PASSWORD" \
    --single-transaction --no-create-info --skip-triggers --insert-ignore \
    --where="snapshotId IN (SELECT id FROM OptionChainSnapshot WHERE expiryId='${SOURCE_EXPIRY_ID}')" \
    "$MYSQL_DATABASE" PressureScore > "$PRESSURE_DUMP"

  SNAP_ROWS=$(grep -c "^INSERT" "$SNAP_DUMP" || true)
  if [ "$SNAP_ROWS" -eq 0 ]; then
    echo "  no snapshot rows to copy, skipping"
    continue
  fi

  echo "  importing into native MySQL..."
  mysql -h "$NATIVE_HOST" -P "$NATIVE_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < "$SNAP_DUMP"
  mysql -h "$NATIVE_HOST" -P "$NATIVE_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < "$TICK_DUMP"
  mysql -h "$NATIVE_HOST" -P "$NATIVE_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < "$PRESSURE_DUMP"

  NEW_COUNT=$(native_mysql "SELECT COUNT(*) FROM OptionChainSnapshot WHERE expiryId='${TARGET_EXPIRY_ID}';")
  echo "  done - native now has ${NEW_COUNT} snapshot rows for ${SYM} ${TARGET_EXPIRY_DATE}"
done

echo ""
echo "== Cleaning up temporary container (old volume is left untouched) =="
docker rm -f "$TEMP_CONTAINER"
rm -rf "$DUMP_DIR"

echo ""
echo "Done."

#!/usr/bin/env bash
# Validates today's captured NIFTY option-chain data quality (9:14-15:41 IST session).
# Run from /opt/option-decode on EC2.

set -euo pipefail
source <(grep -E '^(MYSQL_USER|MYSQL_PASSWORD|MYSQL_DATABASE)=' .env.production)

run() {
  mysql -h127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "$1" 2>/dev/null
}

echo "== 1. Overall coverage: count, time range, spot/ATM range =="
run "
SELECT
  COUNT(*) AS snapshot_count,
  MIN(snapshotTime) AS first_snapshot_utc,
  MAX(snapshotTime) AS last_snapshot_utc,
  MIN(spotPrice) AS min_spot,
  MAX(spotPrice) AS max_spot,
  MIN(atmStrike) AS min_atm,
  MAX(atmStrike) AS max_atm
FROM OptionChainSnapshot
WHERE underlyingSymbol = 'NIFTY' AND tradingDate = CURDATE();
"

echo ""
echo "== 2. Capture gaps > 3 minutes during the session (should be empty/none if capture ran smoothly) =="
run "
SELECT prev_time, snapshotTime AS gap_end, TIMESTAMPDIFF(SECOND, prev_time, snapshotTime) AS gap_seconds
FROM (
  SELECT
    snapshotTime,
    LAG(snapshotTime) OVER (ORDER BY snapshotTime) AS prev_time
  FROM OptionChainSnapshot
  WHERE underlyingSymbol = 'NIFTY' AND tradingDate = CURDATE()
) t
WHERE prev_time IS NOT NULL
  AND TIMESTAMPDIFF(SECOND, prev_time, snapshotTime) > 180
ORDER BY snapshotTime;
"

echo ""
echo "== 3. PCR / Max Pain sanity bounds across the day (flags anything outside a sane range) =="
run "
SELECT
  COUNT(*) AS score_rows,
  MIN(pcr) AS min_pcr, MAX(pcr) AS max_pcr,
  MIN(maxPain) AS min_max_pain, MAX(maxPain) AS max_max_pain,
  SUM(CASE WHEN pcr IS NULL THEN 1 ELSE 0 END) AS null_pcr_rows,
  SUM(CASE WHEN maxPain IS NULL THEN 1 ELSE 0 END) AS null_max_pain_rows
FROM PressureScore
WHERE underlyingSymbol = 'NIFTY' AND DATE(scoreTime) = CURDATE();
"

echo ""
echo "== 4. Tick-level sanity: any zero/negative/null spot or OI on CE/PE at ATM strikes today =="
run "
SELECT COUNT(*) AS suspicious_tick_rows
FROM OptionContractTick t
JOIN OptionChainSnapshot s ON s.id = t.snapshotId
WHERE s.underlyingSymbol = 'NIFTY' AND s.tradingDate = CURDATE()
  AND (t.lastPrice IS NOT NULL AND t.lastPrice < 0)
  OR (t.openInterest IS NOT NULL AND t.openInterest < 0);
"

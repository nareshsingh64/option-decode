import assert from "node:assert/strict";
import { test } from "node:test";

import { expirySettlementMoment, hasContractExpired } from "./index.js";

// The live incident this guard exists for. A SILVER 188000 CE paper position on
// the 2026-08-28 expiry stayed OPEN past settlement, so the worker kept asking
// Dhan for that expiry's chain roughly every 30 seconds and collected an
// HTTP 400 "Invalid Expiry Date" plus a stack trace each time.
const SILVER_EXPIRY = "2026-08-28";

const at = (iso: string) => new Date(iso);

test("MCX and NSE contracts die nearly eight hours apart on the same date", () => {
  // 23:30 IST = 18:00 UTC, 15:41 IST = 10:11 UTC.
  assert.equal(expirySettlementMoment(SILVER_EXPIRY, "SILVER")?.toISOString(), "2026-08-28T18:00:00.000Z");
  assert.equal(expirySettlementMoment(SILVER_EXPIRY, "NIFTY")?.toISOString(), "2026-08-28T10:11:00.000Z");
});

test("a commodity is still trading through the afternoon of its expiry day", () => {
  // 15:45 IST, when the first EOD pass runs. NIFTY is done; SILVER has almost
  // eight hours left, which is the whole reason for the second 23:40 pass.
  const afternoon = at("2026-08-28T10:15:00.000Z");
  assert.equal(hasContractExpired(SILVER_EXPIRY, "SILVER", afternoon), false);
  assert.equal(hasContractExpired(SILVER_EXPIRY, "NIFTY", afternoon), true);
});

test("a commodity is expired once its own session has closed", () => {
  assert.equal(hasContractExpired(SILVER_EXPIRY, "SILVER", at("2026-08-28T17:59:59.000Z")), false);
  assert.equal(hasContractExpired(SILVER_EXPIRY, "SILVER", at("2026-08-28T18:00:00.000Z")), true);
  // Three days later - the state the worker was actually logging from.
  assert.equal(hasContractExpired(SILVER_EXPIRY, "SILVER", at("2026-08-31T05:00:00.000Z")), true);
});

test("a Date and its YYYY-MM-DD label are the same expiry", () => {
  // expiryDate is a Prisma @db.Date (UTC midnight); expiryLabel is the string
  // form the paper module stores. Both callers must agree.
  const asDate = at("2026-08-28T00:00:00.000Z");
  assert.equal(expirySettlementMoment(asDate, "SILVER")?.getTime(), expirySettlementMoment(SILVER_EXPIRY, "SILVER")?.getTime());
});

test("an unparseable expiry fails open rather than reading as expired", () => {
  // Failing open is deliberate: the callers either settle a position or stop
  // fetching its live data, and doing either to a LIVE contract by mistake is
  // worse than doing neither to a dead one.
  assert.equal(hasContractExpired("not-a-date", "SILVER", at("2030-01-01T00:00:00.000Z")), false);
  assert.equal(expirySettlementMoment("not-a-date", "SILVER"), null);
  assert.equal(hasContractExpired(new Date(Number.NaN), "SILVER"), false);
});

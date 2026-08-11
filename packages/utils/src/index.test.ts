import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpiryInPast, isMarketSessionOpen, todayIstDateKey } from "./index.ts";

test("todayIstDateKey converts a UTC instant to the correct IST calendar date", () => {
  // 2026-08-01T19:00:00Z is 2026-08-02T00:30 IST - past midnight, next day.
  assert.equal(todayIstDateKey(new Date("2026-08-01T19:00:00Z")), "2026-08-02");
  // 2026-08-01T00:00:00Z is 2026-08-01T05:30 IST - same calendar day.
  assert.equal(todayIstDateKey(new Date("2026-08-01T00:00:00Z")), "2026-08-01");
});

test("todayIstDateKey pads single-digit month/day to two digits", () => {
  assert.equal(todayIstDateKey(new Date("2026-01-05T04:00:00Z")), "2026-01-05");
});

test("isExpiryInPast is true for a calendar date strictly before today (IST)", () => {
  const now = new Date("2026-08-01T06:00:00Z"); // 2026-08-01T11:30 IST
  assert.equal(isExpiryInPast("2026-06-18", now), true);
  assert.equal(isExpiryInPast("2026-07-31", now), true);
});

test("isExpiryInPast is false for today's own expiry - a same-day contract is still live", () => {
  const now = new Date("2026-08-01T06:00:00Z"); // 2026-08-01T11:30 IST
  assert.equal(isExpiryInPast("2026-08-01", now), false);
});

test("isExpiryInPast is false for a future expiry", () => {
  const now = new Date("2026-08-01T06:00:00Z"); // 2026-08-01T11:30 IST
  assert.equal(isExpiryInPast("2026-08-07", now), false);
  assert.equal(isExpiryInPast("2027-01-01", now), false);
});

test("isExpiryInPast uses the IST calendar day, not the UTC one, at the day boundary", () => {
  // 2026-08-01T19:00:00Z is already 2026-08-02T00:30 IST - IST has rolled
  // over to the 2nd even though UTC is still on the 1st. An expiry of
  // 2026-08-01 must read as already-past in IST terms.
  const now = new Date("2026-08-01T19:00:00Z");
  assert.equal(isExpiryInPast("2026-08-01", now), true);
  assert.equal(isExpiryInPast("2026-08-02", now), false);
});

// NSE session moved to 09:14-15:41 IST (from 09:15-15:30). Both edges are
// asserted inclusive, and the minute either side exclusive, so a future
// timing change cannot quietly widen or narrow the window unnoticed.
test("isMarketSessionOpen (equity/index segment) is open 09:14-15:41 IST on a weekday", () => {
  // 2026-08-03 is a Monday.
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-03T03:43:00Z")), false); // 09:13 IST
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-03T03:44:00Z")), true); // 09:14 IST - new open
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-03T03:45:00Z")), true); // 09:15 IST
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-03T10:00:00Z")), true); // 15:30 IST - old close, now mid-session
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-03T10:11:00Z")), true); // 15:41 IST - new close
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-03T10:12:00Z")), false); // 15:42 IST
});

test("isMarketSessionOpen is closed on a weekend regardless of time of day", () => {
  // 2026-08-01 is a Saturday, 2026-08-02 is a Sunday.
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-01T06:00:00Z")), false);
  assert.equal(isMarketSessionOpen("NSE_FNO", new Date("2026-08-02T06:00:00Z")), false);
});

test("isMarketSessionOpen (MCX_COMM segment) uses the wider 09:00-23:30 IST window", () => {
  assert.equal(isMarketSessionOpen("MCX_COMM", new Date("2026-08-03T03:29:00Z")), false); // 08:59 IST
  assert.equal(isMarketSessionOpen("MCX_COMM", new Date("2026-08-03T03:30:00Z")), true); // 09:00 IST
  assert.equal(isMarketSessionOpen("MCX_COMM", new Date("2026-08-03T18:00:00Z")), true); // 23:30 IST
  assert.equal(isMarketSessionOpen("MCX_COMM", new Date("2026-08-03T18:01:00Z")), false); // 23:31 IST
});

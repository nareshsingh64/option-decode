import { test } from "node:test";
import assert from "node:assert/strict";
import { blackScholesDelta, blackScholesPrice, DEFAULT_RISK_FREE_RATE, getYearsToExpiry, solveBreakevenSpot } from "./option-pricing.ts";

const spot = 24000;
const strike = 24000;
const years = 7 / 365; // roughly a weekly NIFTY option
const iv = 0.14;

test("put-call parity holds: C - P = S - K*exp(-rT)", () => {
  const call = blackScholesPrice("CE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const put = blackScholesPrice("PE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const expected = spot - strike * Math.exp(-DEFAULT_RISK_FREE_RATE * years);

  assert.ok(Math.abs(call - put - expected) < 0.01, `expected parity within 1 paisa, got call=${call} put=${put} expected diff=${expected}`);
});

test("call price is strictly increasing in spot; put price is strictly decreasing", () => {
  const lowSpot = blackScholesPrice("CE", spot - 200, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const midSpot = blackScholesPrice("CE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const highSpot = blackScholesPrice("CE", spot + 200, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  assert.ok(lowSpot < midSpot && midSpot < highSpot);

  const putLow = blackScholesPrice("PE", spot - 200, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const putMid = blackScholesPrice("PE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const putHigh = blackScholesPrice("PE", spot + 200, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  assert.ok(putLow > putMid && putMid > putHigh);
});

test("delta stays within its theoretical bounds: [0,1] for calls, [-1,0] for puts", () => {
  const callDelta = blackScholesDelta("CE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const putDelta = blackScholesDelta("PE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  assert.ok(callDelta > 0 && callDelta < 1);
  assert.ok(putDelta > -1 && putDelta < 0);
  // ATM delta should be roughly 0.5 / -0.5 (slightly skewed by the
  // risk-free-rate drift term, which is why this isn't an exact equality).
  assert.ok(Math.abs(callDelta - 0.5) < 0.1);
  assert.ok(Math.abs(putDelta + 0.5) < 0.1);
});

test("deep ITM call delta approaches 1, deep OTM call delta approaches 0", () => {
  const deepItmDelta = blackScholesDelta("CE", 26000, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const deepOtmDelta = blackScholesDelta("CE", 22000, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  assert.ok(deepItmDelta > 0.95);
  assert.ok(deepOtmDelta < 0.05);
});

test("solveBreakevenSpot round-trips: solving for the price at a known spot recovers that spot", () => {
  const trueBreakevenSpot = 24150;
  const premiumAtThatSpot = blackScholesPrice("CE", trueBreakevenSpot, strike, years, DEFAULT_RISK_FREE_RATE, iv);

  const solved = solveBreakevenSpot("CE", strike, premiumAtThatSpot, years, DEFAULT_RISK_FREE_RATE, iv);
  assert.ok(solved !== undefined);
  assert.ok(Math.abs(solved! - trueBreakevenSpot) < 1, `expected ~${trueBreakevenSpot}, got ${solved}`);
});

test("today's breakeven requires a smaller move than the at-expiry breakeven while time remains (CE)", () => {
  const entryPremium = blackScholesPrice("CE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const breakevenAtExpiry = strike + entryPremium;
  const breakevenToday = solveBreakevenSpot("CE", strike, entryPremium, years, DEFAULT_RISK_FREE_RATE, iv);

  assert.ok(breakevenToday !== undefined);
  // Time value in the premium means less of the required move has to come
  // from pure intrinsic value, so today's breakeven sits below the
  // strike+premium number.
  assert.ok(breakevenToday! < breakevenAtExpiry, `expected breakevenToday (${breakevenToday}) < breakevenAtExpiry (${breakevenAtExpiry})`);
});

test("today's breakeven requires a smaller (upward-capped) move than at-expiry for puts", () => {
  const entryPremium = blackScholesPrice("PE", spot, strike, years, DEFAULT_RISK_FREE_RATE, iv);
  const breakevenAtExpiry = strike - entryPremium;
  const breakevenToday = solveBreakevenSpot("PE", strike, entryPremium, years, DEFAULT_RISK_FREE_RATE, iv);

  assert.ok(breakevenToday !== undefined);
  assert.ok(breakevenToday! > breakevenAtExpiry, `expected breakevenToday (${breakevenToday}) > breakevenAtExpiry (${breakevenAtExpiry})`);
});

test("the today-vs-expiry breakeven gap shrinks as time to expiry shrinks", () => {
  // Comparative rather than an absolute near-zero check: right at the
  // extreme (literally seconds to expiry) an ATM option's price is
  // dominated by subtracting two nearly-equal probabilities, which is a
  // well-known numerically unstable regime for any Black-Scholes
  // implementation using an approximate normal CDF - not something a real
  // trader would be staring at anyway. What actually matters for this
  // feature is the trend: a trade opened with only a couple of hours left
  // should show today's breakeven much closer to the at-expiry number than
  // one opened with a full week left.
  const gapAt = (yearsToExpiry: number) => {
    const entryPremium = blackScholesPrice("CE", spot, strike, yearsToExpiry, DEFAULT_RISK_FREE_RATE, iv);
    const breakevenAtExpiry = strike + entryPremium;
    const breakevenToday = solveBreakevenSpot("CE", strike, entryPremium, yearsToExpiry, DEFAULT_RISK_FREE_RATE, iv);
    assert.ok(breakevenToday !== undefined);
    return breakevenAtExpiry - breakevenToday!;
  };

  const gapWithAWeekLeft = gapAt(7 / 365);
  const gapWithTwoHoursLeft = gapAt(2 / (365 * 24));

  assert.ok(gapWithTwoHoursLeft < gapWithAWeekLeft / 5, `expected the 2-hour gap (${gapWithTwoHoursLeft}) to be much smaller than the 7-day gap (${gapWithAWeekLeft})`);
});

test("getYearsToExpiry converts an ISO expiry label to a positive year fraction before market close", () => {
  const asOf = Date.parse("2026-07-01T04:00:00.000Z"); // 09:30 IST
  const years = getYearsToExpiry("2026-07-08", asOf);
  // Expiry cutoff is 10:00 UTC (15:30 IST) on 2026-07-08, so this is 7 days
  // plus 6 hours out from 04:00 UTC on 2026-07-01 - just over 7/365 years.
  assert.ok(years > 7 / 365 && years < 7.5 / 365, `expected ~7.25/365, got ${years}`);
});

test("getYearsToExpiry floors at a small positive value once expiry has passed, rather than going negative", () => {
  const asOf = Date.parse("2026-07-10T12:00:00.000Z");
  const years = getYearsToExpiry("2026-07-08", asOf);
  assert.ok(years > 0);
  assert.ok(years < 1 / 365);
});

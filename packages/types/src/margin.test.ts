import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MARGIN_BASE_PCT_INDEX,
  MARGIN_BASE_PCT_STOCK,
  MARGIN_PCT_INDEX_HIGH,
  MARGIN_PCT_INDEX_LOW,
  marginBasePctFor,
  shortLegItmAmount,
  shortLegMarginPerUnit
} from "./index.js";

// The worked example recorded in CLAUDE.md and in the model's own doc comment.
// NIFTY 2026-08-14: spot 24,366, short 24,650 CE, lot 65. The published figure
// for a naked NIFTY short held overnight is Rs 1.25-1.5 lakh per lot; the old
// prescribed-minimum formula produced Rs 2,99,335, which is 2.2x the middle of
// that range and is the bug this model exists to fix.
const SPOT = 24_366;
const STRIKE = 24_650;
const LOT = 65;

test("the documented NIFTY example lands inside the published per-lot range", () => {
  const total = shortLegMarginPerUnit("NIFTY", SPOT, STRIKE, "CE") * LOT;
  assert.ok(total >= 125_000 && total <= 150_000, `expected Rs 1.25-1.5 lakh, got ${Math.round(total)}`);
  // And nowhere near the old figure - a regression to the prescribed minimum
  // would land at ~2,99,335 and this bound would catch it.
  assert.ok(total < 200_000, `looks like the prescribed-minimum formula is back: ${Math.round(total)}`);
});

test("the sensitivity band brackets the published range", () => {
  const low = MARGIN_PCT_INDEX_LOW * SPOT * LOT;
  const high = MARGIN_PCT_INDEX_HIGH * SPOT * LOT;
  assert.ok(low <= 126_000, `band low ${Math.round(low)} should reach down to ~1.25 lakh`);
  assert.ok(high >= 149_000, `band high ${Math.round(high)} should reach up to ~1.5 lakh`);
  assert.ok(MARGIN_PCT_INDEX_LOW < MARGIN_BASE_PCT_INDEX && MARGIN_BASE_PCT_INDEX < MARGIN_PCT_INDEX_HIGH);
});

// This is the assertion most likely to be "cleaned up" by someone consolidating
// two constants that look redundant. They are not: the 20% prescribed minimum
// is calibrated for single stocks and is roughly right for them, which is why
// the 2x error only ever appeared on indices. Collapsing them to the index
// figure would understate stock margin by the same factor - the same bug
// pointed the other way, and harder to spot because it flatters the account.
test("index and stock base percentages are deliberately different", () => {
  assert.equal(marginBasePctFor("NIFTY"), MARGIN_BASE_PCT_INDEX);
  assert.equal(marginBasePctFor("SENSEX"), MARGIN_BASE_PCT_INDEX);
  assert.equal(marginBasePctFor("RELIANCE"), MARGIN_BASE_PCT_STOCK);
  assert.ok(MARGIN_BASE_PCT_STOCK > MARGIN_BASE_PCT_INDEX * 2, "a stock must cost materially more margin than an index");
});

test("underlying matching is case-insensitive", () => {
  assert.equal(marginBasePctFor("nifty"), MARGIN_BASE_PCT_INDEX);
  assert.equal(marginBasePctFor("BankNifty"), MARGIN_BASE_PCT_INDEX);
});

test("an unknown symbol falls back to the stock rate, not the index rate", () => {
  // Erring towards the higher requirement: an unrecognised symbol is far more
  // likely to be a stock than an index, and over-blocking is the safe direction.
  assert.equal(marginBasePctFor("SOMETHINGNEW"), MARGIN_BASE_PCT_STOCK);
});

test("itm amount is zero while the short is out of the money", () => {
  assert.equal(shortLegItmAmount(24_366, 24_650, "CE"), 0);
  assert.equal(shortLegItmAmount(24_366, 24_100, "PE"), 0);
  assert.equal(shortLegItmAmount(24_800, 24_650, "CE"), 150);
  assert.equal(shortLegItmAmount(24_000, 24_100, "PE"), 100);
});

test("margin escalates point-for-point once the short goes ITM", () => {
  const atStrike = shortLegMarginPerUnit("NIFTY", STRIKE, STRIKE, "CE");
  const deepIn = shortLegMarginPerUnit("NIFTY", STRIKE + 500, STRIKE, "CE");
  // 500 points of intrinsic, plus the base percentage applied to the higher
  // spot. This escalation is the behaviour that matters most: it is what
  // actually blows up a real short-premium account.
  assert.ok(deepIn - atStrike > 500, "ITM escalation must exceed the intrinsic move");
});

test("margin is flat in strike distance while OTM", () => {
  // Deliberate: real SPAN does charge less for further-OTM strikes, but the
  // published figures overlap too heavily to fit that curve, so no coefficient
  // is invented here. If someone adds one, this test should be updated with
  // the source that justified it - not deleted.
  const near = shortLegMarginPerUnit("NIFTY", SPOT, 24_500, "CE");
  const far = shortLegMarginPerUnit("NIFTY", SPOT, 26_000, "CE");
  assert.equal(near, far);
});

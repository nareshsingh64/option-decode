import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBrokerQuantity, getFallbackLotSize, toBrokerQuantity } from "./index.js";

// The unit a broker order carries is NOT the same on every exchange, and the
// difference is a factor of the lot size - 100x on CRUDEOIL, 2500x on COPPER.
// An order sized with the wrong convention does not error. It fills.
//
// Measured against Dhan's live margin calculator on 2026-08-30:
//
//   CRUDEOIL (lot 100)  quantity 1   -> Rs   2,49,675
//                       quantity 2   -> Rs   4,99,350   (exactly 2x)
//                       quantity 100 -> Rs 2,49,67,500  (exactly 100x)
//   BANKNIFTY (lot 30)  quantity 30  -> one lot (leverage 9.78 x 1,78,392
//                                       = Rs 17.4L = 58,000 x 30)
//
// so MCX counts lots and NSE counts contracts.

test("NSE and BSE underlyings are sized in contracts", () => {
  assert.equal(toBrokerQuantity("NIFTY", 1), 65);
  assert.equal(toBrokerQuantity("NIFTY", 3), 195);
  assert.equal(toBrokerQuantity("BANKNIFTY", 1), 30);
  assert.equal(toBrokerQuantity("SENSEX", 2), 40);
});

test("MCX underlyings are sized in lots, not contracts", () => {
  // The whole point. If any of these ever returns lots * lotSize, an order
  // placed through it is 100x-2500x oversized.
  assert.equal(toBrokerQuantity("CRUDEOIL", 1), 1, "CRUDEOIL 1 lot must be quantity 1, not 100");
  assert.equal(toBrokerQuantity("CRUDEOIL", 2), 2);
  assert.equal(toBrokerQuantity("NATURALGAS", 1), 1, "NATURALGAS 1 lot must be quantity 1, not 1250");
  assert.equal(toBrokerQuantity("COPPER", 1), 1, "COPPER 1 lot must be quantity 1, not 2500");
  assert.equal(toBrokerQuantity("SILVER", 4), 4);
});

test("the MCX and NSE conventions actually differ for the same lot count", () => {
  // A guard against someone "simplifying" the helper to one branch. SILVER's
  // lot size is 30, the same as BANKNIFTY's - so a single-branch implementation
  // would look correct on this pair and be wrong by 30x on one of them.
  assert.equal(getFallbackLotSize("SILVER"), getFallbackLotSize("BANKNIFTY"));
  assert.notEqual(toBrokerQuantity("SILVER", 1), toBrokerQuantity("BANKNIFTY", 1));
});

test("symbol casing does not change the convention", () => {
  assert.equal(toBrokerQuantity("crudeoil", 1), 1);
  assert.equal(toBrokerQuantity("Nifty", 1), 65);
});

test("a non-positive or fractional lot count is rejected rather than rounded", () => {
  // Silently flooring 0.5 lots to 0 would place a zero-quantity order; silently
  // rounding up would place one the user did not ask for.
  assert.throws(() => toBrokerQuantity("NIFTY", 0));
  assert.throws(() => toBrokerQuantity("NIFTY", -1));
  assert.throws(() => toBrokerQuantity("NIFTY", 1.5));
});

test("an unknown symbol falls back to a lot size of 1", () => {
  // getFallbackLotSize returns 1 for anything unknown, deliberately, so a miss
  // shows up as a single-unit position rather than a plausible wrong number.
  assert.equal(toBrokerQuantity("NOTAREALSYMBOL", 3), 3);
});

test("fromBrokerQuantity inverts toBrokerQuantity on both exchanges", () => {
  for (const symbol of ["NIFTY", "BANKNIFTY", "SENSEX", "CRUDEOIL", "NATURALGAS", "COPPER", "SILVER"]) {
    for (const lots of [1, 2, 7]) {
      assert.equal(
        fromBrokerQuantity(symbol, toBrokerQuantity(symbol, lots)),
        lots,
        `${symbol} ${lots} lots did not round-trip`
      );
    }
  }
});

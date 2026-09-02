import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DTE_GAMMA_THRESHOLD_DAYS,
  closeOrderTypeFor,
  orderCloseSequence,
  HARD_STOP_MULTIPLE,
  costToClose,
  evaluateExit,
  profitTargetPct,
  type ExitInput
} from "./exit-rules.js";

// A one-lot NIFTY bear call spread: short 24100 CE at 51.15, long 24400 CE at
// 6.00, 65 contracts. Credit = (51.15 - 6.00) * 65 = 2,934.75. These are the
// real fills from the first live order placed through this module.
function spread(overrides: Partial<ExitInput> = {}): ExitInput {
  return {
    structure: "BEAR_CALL_SPREAD",
    netCredit: (51.15 - 6.0) * 65,
    quantity: 65,
    daysToExpiry: 28,
    legs: [
      { side: "SELL", entryPrice: 51.15, lastPrice: 51.15 },
      { side: "BUY", entryPrice: 6.0, lastPrice: 6.0 }
    ],
    ...overrides
  };
}

test("a position at entry triggers nothing", () => {
  assert.equal(evaluateExit(spread()), null);
});

test("cost to close nets the hedge off rather than adding it", () => {
  // Buying the short back costs; selling the long back returns. A sign error
  // here would price a spread as if it were two naked shorts.
  assert.equal(costToClose(spread().legs, 65), (51.15 - 6.0) * 65);
});

test("profit target fires at 50% of credit for a spread", () => {
  const atTarget = spread({
    legs: [
      // 22.50/unit to close against a 45.15 credit = 50.2% captured. The first
      // draft used 22.60 and missed the threshold by Rs 1.63 - the test caught
      // the arithmetic, which is what it is for.
      { side: "SELL", entryPrice: 51.15, lastPrice: 28.0 },
      { side: "BUY", entryPrice: 6.0, lastPrice: 5.5 }
    ]
  });
  const decision = evaluateExit(atTarget);
  assert.equal(decision?.rule, "PROFIT_TARGET");
  assert.match(decision!.detail, /target 50%/);
});

test("a straddle takes profit earlier than a spread", () => {
  assert.equal(profitTargetPct("SHORT_STRADDLE"), 30);
  assert.equal(profitTargetPct("BEAR_CALL_SPREAD"), 50);
});

test("the hard stop fires at 3x the credit", () => {
  const credit = (51.15 - 6.0) * 65;
  // Cost to close needs to reach 3x credit = 3 * 45.15 = 135.45 per unit.
  const blownOut = spread({
    legs: [
      { side: "SELL", entryPrice: 51.15, lastPrice: 140.0 },
      { side: "BUY", entryPrice: 6.0, lastPrice: 4.0 }
    ]
  });
  const decision = evaluateExit(blownOut);
  assert.equal(decision?.rule, "HARD_STOP_3X");
  assert.ok(costToClose(blownOut.legs, 65) >= HARD_STOP_MULTIPLE * credit);
});

test("profit is taken before a stop is considered", () => {
  // Both conditions cannot hold at once on a real book, but the ordering is
  // policy rather than accident, so it is asserted rather than assumed.
  const decision = evaluateExit(
    spread({
      netCredit: 100,
      legs: [
        { side: "SELL", entryPrice: 51.15, lastPrice: 0.1 },
        { side: "BUY", entryPrice: 6.0, lastPrice: 0.05 }
      ]
    })
  );
  assert.equal(decision?.rule, "PROFIT_TARGET");
});

test("the gamma window fires inside the threshold, not outside", () => {
  assert.equal(evaluateExit(spread({ daysToExpiry: DTE_GAMMA_THRESHOLD_DAYS + 1 })), null);
  assert.equal(evaluateExit(spread({ daysToExpiry: DTE_GAMMA_THRESHOLD_DAYS }))?.rule, "DTE_GAMMA");
});

test("a fresh weekly position is NOT closed on sight", () => {
  // The regression this threshold exists to prevent. At 7 days the near NIFTY
  // weekly - which expires every Tuesday and is therefore never more than a
  // week out - was auto-closed on the first sweep after it opened. On
  // 2026-09-02 a 24100 CE sold at 51.80 was bought back at 52.15 thirty
  // seconds later, six days from expiry.
  //
  // Pinned to literal day counts on purpose. Writing these in terms of the
  // constant would make the test agree with whatever the constant says, which
  // is exactly how the original went unnoticed.
  for (const daysToExpiry of [6, 5, 4, 3, 2]) {
    assert.equal(
      evaluateExit(spread({ daysToExpiry })),
      null,
      `${daysToExpiry} DTE is a normal weekly holding and must not be auto-closed`
    );
  }
  // Still protected where it matters: the day before expiry, and expiry day.
  assert.equal(evaluateExit(spread({ daysToExpiry: 1 }))?.rule, "DTE_GAMMA");
  assert.equal(evaluateExit(spread({ daysToExpiry: 0 }))?.rule, "EXPIRY_TODAY");
});

test("expiry day is its own rule, not merely the gamma window", () => {
  // Distinct because it is an assignment decision rather than a risk one, and
  // the exit event should say which.
  assert.equal(evaluateExit(spread({ daysToExpiry: 0 }))?.rule, "EXPIRY_TODAY");
});

test("a doubled short delta fires when both deltas are usable", () => {
  const decision = evaluateExit(
    spread({
      legs: [
        { side: "SELL", entryPrice: 51.15, lastPrice: 60, entryDelta: 0.2, currentDelta: 0.41 },
        { side: "BUY", entryPrice: 6.0, lastPrice: 7 }
      ]
    })
  );
  assert.equal(decision?.rule, "DELTA_2X");
});

test("a ZERO delta is missing data and must not satisfy the delta rule", () => {
  // Dhan zeroes delta on roughly three-quarters of NIFTY ticks. If zero counted
  // as a real value the rule would either never fire or fire constantly, and
  // both look like protection while being none.
  const decision = evaluateExit(
    spread({
      legs: [
        { side: "SELL", entryPrice: 51.15, lastPrice: 60, entryDelta: 0, currentDelta: 0 },
        { side: "BUY", entryPrice: 6.0, lastPrice: 7 }
      ]
    })
  );
  assert.notEqual(decision?.rule, "DELTA_2X");
});

test("premium doubling stands in when delta is unavailable", () => {
  const decision = evaluateExit(
    spread({
      // Kept under the 3x hard stop so this is unambiguously the premium rule.
      netCredit: 45.15 * 65 * 2,
      legs: [
        { side: "SELL", entryPrice: 51.15, lastPrice: 103.0 },
        { side: "BUY", entryPrice: 6.0, lastPrice: 8.0 }
      ]
    })
  );
  assert.equal(decision?.rule, "PREMIUM_2X");
  assert.match(decision!.detail, /delta unavailable/);
});

test("the premium fallback only looks at SHORT legs", () => {
  // A long leg tripling is good news, not a stop.
  const decision = evaluateExit(
    spread({
      legs: [
        { side: "SELL", entryPrice: 51.15, lastPrice: 50.0 },
        { side: "BUY", entryPrice: 6.0, lastPrice: 30.0 }
      ]
    })
  );
  assert.notEqual(decision?.rule, "PREMIUM_2X");
});

test("a zero or negative credit cannot trigger profit or stop rules", () => {
  // Division by the credit is how both are expressed; a debit structure would
  // otherwise produce nonsense percentages.
  const decision = evaluateExit(spread({ netCredit: 0, daysToExpiry: 30 }));
  assert.equal(decision, null);
});

// A bought option is a DEBIT: netCredit is negative. The seller rules are
// expressed as percentages of a credit received, so they must not fire on one -
// a "50% of credit" target against a negative credit is meaningless arithmetic,
// and a 3x stop would trigger immediately.
function longCall(overrides: Partial<ExitInput> = {}): ExitInput {
  return {
    structure: "LONG_CALL",
    netCredit: -6.0 * 65,
    quantity: 65,
    daysToExpiry: 28,
    legs: [{ side: "BUY", entryPrice: 6.0, lastPrice: 6.0 }],
    ...overrides
  };
}

test("seller rules never fire on a bought option", () => {
  assert.equal(evaluateExit(longCall()), null);
  // Even when it has lost most of its value - which for a long is simply the
  // trade going wrong, not a stop being breached.
  assert.equal(evaluateExit(longCall({ legs: [{ side: "BUY", entryPrice: 6.0, lastPrice: 0.5 }] })), null);
  // And even when it has multiplied, which is profit rather than a hard stop.
  assert.equal(evaluateExit(longCall({ legs: [{ side: "BUY", entryPrice: 6.0, lastPrice: 40 }] })), null);
});

test("expiry rules still apply to a bought option", () => {
  // These are about time rather than about credit, so they hold in both
  // directions - a long left to expire worthless is the same mistake as a short
  // left to be assigned.
  assert.equal(evaluateExit(longCall({ daysToExpiry: 0 }))?.rule, "EXPIRY_TODAY");
  assert.equal(evaluateExit(longCall({ daysToExpiry: 1 }))?.rule, "DTE_GAMMA");
  // ...and a bought weekly with days left is left alone, same as a sold one.
  assert.equal(evaluateExit(longCall({ daysToExpiry: 3 })), null);
});

test("an empty or zero-quantity position is never actioned", () => {
  assert.equal(evaluateExit(spread({ legs: [] })), null);
  assert.equal(evaluateExit(spread({ quantity: 0 })), null);
});

// --- closing behaviour -----------------------------------------------------

test("urgent rules close at market, unhurried ones at limit", () => {
  // A hard stop that rests as an unfilled limit is not a stop: it fires
  // precisely when the market has moved away from the last print.
  assert.equal(closeOrderTypeFor("HARD_STOP_3X"), "MARKET");
  assert.equal(closeOrderTypeFor("DELTA_2X"), "MARKET");
  assert.equal(closeOrderTypeFor("PREMIUM_2X"), "MARKET");
  // On expiry day the alternative to filling is assignment.
  assert.equal(closeOrderTypeFor("EXPIRY_TODAY"), "MARKET");
  // Harvesting a good outcome; paying the spread is the larger cost here.
  assert.equal(closeOrderTypeFor("PROFIT_TARGET"), "LIMIT");
  // A days-long condition, not a seconds-long one.
  assert.equal(closeOrderTypeFor("DTE_GAMMA"), "LIMIT");
});

test("short legs are always closed before long ones", () => {
  // Closing the long wing first leaves the account naked short - briefly
  // unbounded risk and a far larger margin requirement, on a position that was
  // defined-risk a moment earlier. If only one leg closes it must be the one
  // that REMOVES risk.
  const condor = [
    { side: "BUY" as const, id: "long-put-wing" },
    { side: "SELL" as const, id: "short-put" },
    { side: "BUY" as const, id: "long-call-wing" },
    { side: "SELL" as const, id: "short-call" }
  ];
  const sequenced = orderCloseSequence(condor);
  assert.deepEqual(
    sequenced.map((l) => l.side),
    ["SELL", "SELL", "BUY", "BUY"]
  );
  // Stable within each side, so the output is predictable rather than merely
  // correct - two runs must produce the same order.
  assert.deepEqual(orderCloseSequence(condor).map((l) => l.id), sequenced.map((l) => l.id));
});

test("sequencing does not mutate the caller's array", () => {
  const legs = [{ side: "BUY" as const }, { side: "SELL" as const }];
  orderCloseSequence(legs);
  assert.equal(legs[0].side, "BUY", "the input order must be untouched");
});

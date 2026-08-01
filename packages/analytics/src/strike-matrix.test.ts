import { test } from "node:test";
import assert from "node:assert/strict";
import type { OptionChainSnapshot, OptionContractTick } from "@option-decode/types";
import { calculateStrikeMatrix, isTradingHorizon, STRIKE_MATRIX_HORIZONS } from "./strike-matrix.js";

function tick(overrides: Partial<OptionContractTick> & Pick<OptionContractTick, "optionType" | "strikePrice">): OptionContractTick {
  return {
    tradingDate: "2026-07-16",
    tickTime: "2026-07-16T10:00:00.000Z",
    underlyingSymbol: "NIFTY",
    expiry: "2026-07-21",
    lastPrice: 100,
    ...overrides
  };
}

function snapshot(ticks: OptionContractTick[]): OptionChainSnapshot {
  return {
    tradingDate: "2026-07-16",
    snapshotTime: "2026-07-16T10:00:00.000Z",
    underlyingSymbol: "NIFTY",
    expiry: "2026-07-21",
    spotPrice: 25000,
    atmStrike: 25000,
    ticks
  };
}

test("universe keeps only strikes inside the horizon delta band and with a delta", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 100, changeInOpenInterest: 50 }),
      tick({ optionType: "CE", strikePrice: 25000, delta: 0.5, volume: 100, changeInOpenInterest: 50 }), // outside band
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 100, changeInOpenInterest: 50 }),
      tick({ optionType: "PE", strikePrice: 24000, delta: -0.05, volume: 100, changeInOpenInterest: 50 }), // outside band
      tick({ optionType: "PE", strikePrice: 24900, volume: 100, changeInOpenInterest: 50 }) // no delta
    ]),
    "intraday"
  );
  assert.deepEqual(
    result.universe.map((row) => row.strikePrice).sort((a, b) => a - b),
    [24800, 25200]
  );
});

test("WCI is oiChange / volume and undefined at zero volume", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 400, changeInOpenInterest: 100 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 0, changeInOpenInterest: 100 })
    ]),
    "intraday"
  );
  const call = result.universe.find((row) => row.optionType === "CE");
  const put = result.universe.find((row) => row.optionType === "PE");
  assert.equal(call?.wci, 0.25);
  assert.equal(put?.wci, undefined);
});

test("DRC is signed and DRCR aggregates |DRC| puts over |DRC| calls", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      // put DRC = 1000 × -0.2 = -200 → |200|
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: 1000 }),
      // call DRC = 500 × 0.2 = 100
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500 })
    ]),
    "intraday"
  );
  const put = result.universe.find((row) => row.optionType === "PE");
  assert.equal(put?.drc, -200);
  assert.equal(result.putDrcTotal, 200);
  assert.equal(result.callDrcTotal, 100);
  assert.equal(result.drcr, 2);
  assert.equal(result.bias, "Bullish");
});

test("DRCR bias bands: neutral, bearish, transitional gap, and zero-call guard", () => {
  const build = (putOic: number, callOic: number) =>
    calculateStrikeMatrix(
      snapshot([
        tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: putOic }),
        tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: callOic })
      ]),
      "intraday"
    );
  assert.equal(build(1000, 1000).bias, "Neutral"); // DRCR 1.0
  assert.equal(build(500, 1000).bias, "Bearish"); // DRCR 0.5
  assert.equal(build(1300, 1000).bias, "Transitional"); // DRCR 1.3 gap
  const zeroCall = build(1000, 0);
  assert.equal(zeroCall.drcr, undefined);
  assert.equal(zeroCall.bias, "Transitional");
  assert.equal(zeroCall.recommendation, undefined);
});

test("walls pick highest |WCI| per side and apply the horizon threshold to signed WCI", () => {
  // Chain-wide baseline = (400+100+300)/3000 = 0.2667; intraday threshold =
  // 0.2667 × 1.3 ≈ 0.347. Only the 0.4 WCI strike clears it.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 400 }), // WCI 0.4
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.16, volume: 1000, changeInOpenInterest: 100 }), // WCI 0.1
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: -300 }) // WCI -0.30 (unwinding)
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25200);
  assert.equal(result.callWall?.meetsThreshold, true);
  assert.equal(result.putWall?.strikePrice, 24800); // highest |WCI|
  assert.equal(result.putWall?.meetsThreshold, false); // negative WCI never qualifies
});

test("a qualifying wall is never masked by a larger-magnitude unwinding strike on the same side", () => {
  // Reproduces the exact live shape (BANKNIFTY, 2026-07-31): a strongly
  // negative (unwinding) strike has bigger |WCI| than a genuinely
  // qualifying strike elsewhere on the same side. The qualifying one must
  // win - previously the unwinding strike won on magnitude alone and the
  // real wall was never surfaced anywhere in the response. A high-volume
  // background strike (outside the intraday delta band, so excluded from
  // the universe) keeps the chain-wide baseline realistic: baseline =
  // (1000+800+2000)/53000 ≈ 0.0717, threshold ≈ 0.0717 × 1.3 ≈ 0.093.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25100, delta: 0.2, volume: 1000, changeInOpenInterest: -1000 }), // WCI -1.0, unwinding, larger |WCI|
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.18, volume: 2000, changeInOpenInterest: 800 }), // WCI 0.4, qualifies
      tick({ optionType: "CE", strikePrice: 26500, delta: 0.5, volume: 50000, changeInOpenInterest: 2000 }) // background, outside band
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25200);
  assert.equal(result.callWall?.meetsThreshold, true);
});

test("with no qualifying strike on a side, the highest-|WCI| strike still surfaces for display", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25100, delta: 0.2, volume: 1000, changeInOpenInterest: -300 }), // WCI -0.30
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.18, volume: 1000, changeInOpenInterest: 50 }) // WCI 0.05, doesn't qualify either
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25100); // highest |WCI| among non-qualifiers
  assert.equal(result.callWall?.meetsThreshold, false);
});

test("weekly horizon applies a stricter WCI multiplier than intraday against the same chain", () => {
  // Both horizons derive their threshold from the same chain-wide
  // baseline (150/1000 = 0.15) but weekly demands a bigger multiple above
  // it (1.75x vs intraday's 1.3x) - reflecting the doc's higher
  // conviction bar for overnight/weekend gap risk.
  const chain = snapshot([tick({ optionType: "CE", strikePrice: 25200, delta: 0.15, volume: 1000, changeInOpenInterest: 150 })]);
  const intradayResult = calculateStrikeMatrix(chain, "intraday");
  const weeklyResult = calculateStrikeMatrix(chain, "weekly");
  assert.equal(intradayResult.wciThreshold, 0.15 * 1.3);
  assert.equal(weeklyResult.wciThreshold, 0.15 * 1.75);
  assert.ok(weeklyResult.wciThreshold > intradayResult.wciThreshold);
});

test("the WCI threshold scales with a chain's own aggregate turnover, not one fixed absolute number", () => {
  // Reproduces the live front-week vs back-week regime gap (NIFTY,
  // production, 2026-07-31): a front-week contract's day-volume runs far
  // ahead of its OI change, structurally pinning every strike's WCI lower
  // than a back-week contract's at the same instant - confirmed live,
  // front-week's chain-wide ratio ran 0.03-0.13 through the day vs
  // back-week's tight 0.11-0.14 at the same moments. The threshold must
  // track that regime rather than judging both against one fixed bar.
  const highTurnoverChain = snapshot([
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 100000, changeInOpenInterest: 5000 }) // WCI 0.05
  ]);
  const lowTurnoverChain = snapshot([
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 10000, changeInOpenInterest: 5000 }) // WCI 0.5
  ]);
  const highTurnoverResult = calculateStrikeMatrix(highTurnoverChain, "intraday");
  const lowTurnoverResult = calculateStrikeMatrix(lowTurnoverChain, "intraday");
  assert.ok(highTurnoverResult.wciThreshold < lowTurnoverResult.wciThreshold);
});

test("recommendation picks execution strikes closest to the matrix cell's target delta", () => {
  // Neutral intraday → short strangle at ±0.15
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.22, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.16, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.24, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.15, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Neutral"); // DRCR = (120+75)/(110+80) ≈ 1.03
  assert.equal(result.recommendation?.structure, "Sell short strangle");
  assert.equal(result.recommendation?.callStrike, 25300);
  assert.equal(result.recommendation?.putStrike, 24700);
  assert.equal(result.recommendation?.theoreticalPop, 85);
});

test("a zero-liquidity strike closest to target delta is skipped in favor of a liquid one further away", () => {
  // Reproduces the exact live shape (BANKNIFTY): the strike nearest target
  // delta has zero OI and zero volume - it must never be recommended, even
  // though it's the mathematically closest match.
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25150, delta: 0.18, volume: 0, changeInOpenInterest: 0, openInterest: 0 }), // exact target delta, illiquid
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.22, volume: 1000, changeInOpenInterest: 200, openInterest: 5000 }), // further from target, liquid, still inside the delta band
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.18, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Bullish");
  assert.equal(result.recommendation?.putStrike, 24700);
});

test("a Neutral (both-sides) structure withholds the whole recommendation when one required side has no liquid strike", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.15, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.15, volume: 0, changeInOpenInterest: 500, openInterest: 0 }) // only CE strike in the universe, illiquid
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Neutral"); // Neutral intraday writes both sides
  assert.equal(result.recommendation, undefined, "no execution strike exists for the call side, so the recommendation must not fire at all rather than naming an illiquid strike");
});

test("bullish structures only populate the put side", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500, openInterest: 5000 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Bullish"); // DRCR = 360/100 = 3.6
  assert.equal(result.recommendation?.callStrike, undefined);
  assert.equal(result.recommendation?.putStrike, 24800);
});

test("isTradingHorizon narrows only the three valid horizons", () => {
  assert.equal(isTradingHorizon("intraday"), true);
  assert.equal(isTradingHorizon("weekly"), true);
  assert.equal(isTradingHorizon("monthly"), true);
  assert.equal(isTradingHorizon("daily"), false);
  assert.equal(isTradingHorizon(undefined), false);
});

test("horizon profiles match the decision-matrix doc", () => {
  assert.equal(STRIKE_MATRIX_HORIZONS.intraday.deltaMin, 0.15);
  assert.equal(STRIKE_MATRIX_HORIZONS.intraday.deltaMax, 0.25);
  assert.equal(STRIKE_MATRIX_HORIZONS.weekly.deltaMin, 0.12);
  assert.equal(STRIKE_MATRIX_HORIZONS.weekly.deltaMax, 0.2);
  assert.equal(STRIKE_MATRIX_HORIZONS.monthly.deltaMin, 0.08);
  assert.equal(STRIKE_MATRIX_HORIZONS.monthly.deltaMax, 0.15);
});

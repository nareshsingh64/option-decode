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
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 150 }), // WCI 0.15
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.16, volume: 1000, changeInOpenInterest: 80 }), // WCI 0.08
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.2, volume: 1000, changeInOpenInterest: -300 }) // WCI -0.30 (unwinding)
    ]),
    "intraday"
  );
  assert.equal(result.callWall?.strikePrice, 25200);
  assert.equal(result.callWall?.meetsThreshold, true); // 0.15 > 0.10
  assert.equal(result.putWall?.strikePrice, 24800); // highest |WCI|
  assert.equal(result.putWall?.meetsThreshold, false); // negative WCI never qualifies
});

test("weekly horizon uses the stricter 0.20 WCI threshold", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.15, volume: 1000, changeInOpenInterest: 150 }) // WCI 0.15
    ]),
    "weekly"
  );
  assert.equal(result.wciThreshold, 0.2);
  assert.equal(result.callWall?.meetsThreshold, false);
});

test("recommendation picks execution strikes closest to the matrix cell's target delta", () => {
  // Neutral intraday → short strangle at ±0.15
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.22, volume: 1000, changeInOpenInterest: 500 }),
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.16, volume: 1000, changeInOpenInterest: 500 }),
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.24, volume: 1000, changeInOpenInterest: 500 }),
      tick({ optionType: "PE", strikePrice: 24700, delta: -0.15, volume: 1000, changeInOpenInterest: 500 })
    ]),
    "intraday"
  );
  assert.equal(result.bias, "Neutral"); // DRCR = (120+75)/(110+80) ≈ 1.03
  assert.equal(result.recommendation?.structure, "Sell short strangle");
  assert.equal(result.recommendation?.callStrike, 25300);
  assert.equal(result.recommendation?.putStrike, 24700);
  assert.equal(result.recommendation?.theoreticalPop, 85);
});

test("bullish structures only populate the put side", () => {
  const result = calculateStrikeMatrix(
    snapshot([
      tick({ optionType: "PE", strikePrice: 24800, delta: -0.18, volume: 1000, changeInOpenInterest: 2000 }),
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.2, volume: 1000, changeInOpenInterest: 500 })
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

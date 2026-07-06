import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketBiasSummary, OptionChainSnapshot, OptionContractTick, PressureScore, StrikeMovementRow, TradeInterpretation } from "@option-decode/types";
import { calculateTradeRecommendations } from "./index.ts";
import { blackScholesDelta, DEFAULT_IMPLIED_VOLATILITY, DEFAULT_RISK_FREE_RATE, getYearsToExpiry } from "./option-pricing.ts";

function tick(overrides: Partial<OptionContractTick> & Pick<OptionContractTick, "optionType" | "strikePrice">): OptionContractTick {
  return {
    tradingDate: "2026-07-01",
    tickTime: "2026-07-01T09:30:00.000Z",
    underlyingSymbol: "NIFTY",
    expiry: "2026-07-31",
    lotSize: 1,
    lastPrice: 100,
    lastPriceChange: 0,
    volume: 0,
    openInterest: 0,
    changeInOpenInterest: 0,
    ...overrides
  };
}

function snapshot(ticks: OptionContractTick[], spotPrice: number, atmStrike: number): OptionChainSnapshot {
  return {
    tradingDate: "2026-07-01",
    snapshotTime: "2026-07-01T09:30:00.000Z",
    underlyingSymbol: "NIFTY",
    expiry: "2026-07-31",
    spotPrice,
    atmStrike,
    ticks
  };
}

function bullishMarketBias(overrides: Partial<MarketBiasSummary> = {}): MarketBiasSummary {
  return {
    bias: "Bullish",
    pressureGap: 20,
    absGap: 20,
    readiness: "Watch",
    conviction: "Moderate",
    setupScore: 55,
    setupQuality: "B Setup",
    nearMaxPain: false,
    ...overrides
  };
}

function strikeMovementRow(overrides: Partial<StrikeMovementRow> = {}): StrikeMovementRow {
  return {
    strike: 24000,
    isAtm: true,
    distance: 0,
    peScore: 10,
    ceScore: 5,
    netScore: 5,
    netScorePercent: 33,
    trendScore: 0,
    trendDirection: 0,
    bias: "Up / support",
    trend: "Flat",
    ceActivity: "NEUTRAL",
    peActivity: "NEUTRAL",
    buyerMomentumScore: 0,
    sellerSafetyScore: 0,
    ...overrides
  };
}

const noInterpretation: TradeInterpretation = { buyerScore: 0, sellerScore: 0 };

// Three strikes 50 apart so getStrikeInterval() (internal to buildTradeSetup)
// has something realistic to measure, matching a NIFTY-style chain.
const supportStrike = 24000;
const chainTicks = [
  tick({ optionType: "CE", strikePrice: supportStrike, lastPrice: 100, delta: 0.5 }),
  tick({ optionType: "PE", strikePrice: supportStrike, lastPrice: 40 }),
  tick({ optionType: "CE", strikePrice: 24050, lastPrice: 80 }),
  tick({ optionType: "PE", strikePrice: 24050, lastPrice: 55 }),
  tick({ optionType: "CE", strikePrice: 24200, lastPrice: 20 }),
  tick({ optionType: "PE", strikePrice: 24200, lastPrice: 150 })
];

const bullishPressure: PressureScore = {
  bullishPressure: 60,
  bearishPressure: 40,
  supportZones: [{ strikePrice: supportStrike, score: 100, reason: "PE support pressure" }],
  resistanceZones: [{ strikePrice: 24200, score: 80, reason: "CE resistance pressure" }],
  pcr: 1.2,
  maxPain: 24000
};

test("bullish-bias recommendation includes a trade setup anchored to the support strike's CE premium", () => {
  const recs = calculateTradeRecommendations(
    snapshot(chainTicks, 24010, supportStrike),
    bullishPressure,
    bullishMarketBias(),
    [strikeMovementRow({ netScore: 5 })],
    noInterpretation
  );

  const rec = recs.find((candidate) => candidate.id === "bullish-bias");
  assert.ok(rec, "expected a bullish-bias recommendation to fire");
  assert.ok(rec!.tradeSetup, "expected a tradeSetup on the bullish-bias recommendation");

  const setup = rec!.tradeSetup!;
  assert.equal(setup.optionType, "CE");
  assert.equal(setup.strike, supportStrike);
  // delta 0.5 * strike interval 50 = 25 points of premium, which sits inside
  // the 10%-30% of entry (100) clamp band, so the raw delta-implied
  // distance is used as-is.
  assert.equal(setup.entryPrice, 100);
  assert.equal(setup.stopLoss, 75);
  assert.equal(setup.target, 150);
  assert.equal(setup.riskRewardRatio, 2);

  // Breakeven: the textbook expiry number is strike + premium exactly...
  assert.equal(setup.breakevenAtExpiry, supportStrike + 100);
  // ...while today's (time-value-aware) breakeven should require a smaller
  // upward move, since there's over three weeks of time value left in the
  // premium (snapshot is 2026-07-01, expiry 2026-07-31).
  assert.ok(setup.breakevenToday < setup.breakevenAtExpiry, `expected breakevenToday (${setup.breakevenToday}) < breakevenAtExpiry (${setup.breakevenAtExpiry})`);
});

test("trade setup stop distance is clamped to at least 10% of premium when delta is very low", () => {
  const ticks = chainTicks.map((candidate) => (candidate.optionType === "CE" && candidate.strikePrice === supportStrike ? { ...candidate, delta: 0.02 } : candidate));

  const recs = calculateTradeRecommendations(snapshot(ticks, 24010, supportStrike), bullishPressure, bullishMarketBias(), [strikeMovementRow({ netScore: 5 })], noInterpretation);

  const setup = recs.find((candidate) => candidate.id === "bullish-bias")!.tradeSetup!;
  // Raw distance would be 0.02 * 50 = 1 point (1% of entry) - clamped up to
  // the 10% floor instead of leaving an unrealistically tight stop.
  assert.equal(setup.stopLoss, 90);
  assert.equal(setup.target, 120);
});

test("trade setup stop distance is clamped to at most 30% of premium when delta is very high", () => {
  const ticks = chainTicks.map((candidate) => (candidate.optionType === "CE" && candidate.strikePrice === supportStrike ? { ...candidate, delta: 0.95 } : candidate));

  const recs = calculateTradeRecommendations(snapshot(ticks, 24010, supportStrike), bullishPressure, bullishMarketBias(), [strikeMovementRow({ netScore: 5 })], noInterpretation);

  const setup = recs.find((candidate) => candidate.id === "bullish-bias")!.tradeSetup!;
  // Raw distance would be 0.95 * 50 = 47.5 points (47.5% of entry) - capped
  // down to the 30% ceiling.
  assert.equal(setup.stopLoss, 70);
  assert.equal(setup.target, 160);
});

test("trade setup falls back to the Black-Scholes model delta (from the tick's IV) when the tick has no delta of its own", () => {
  const ticks = chainTicks.map((candidate) => (candidate.optionType === "CE" && candidate.strikePrice === supportStrike ? { ...candidate, delta: undefined } : candidate));
  const snap = snapshot(ticks, 24010, supportStrike);

  const recs = calculateTradeRecommendations(snap, bullishPressure, bullishMarketBias(), [strikeMovementRow({ netScore: 5 })], noInterpretation);
  const setup = recs.find((candidate) => candidate.id === "bullish-bias")!.tradeSetup!;

  // No delta and no impliedVolatility on this tick, so buildTradeSetup
  // should fall back to a model delta computed from DEFAULT_IMPLIED_VOLATILITY
  // - independently recomputed here rather than hardcoded, so this test
  // actually verifies the fallback wiring rather than just a magic number.
  const yearsToExpiry = getYearsToExpiry(snap.expiry, Date.parse(snap.snapshotTime));
  const expectedDelta = Math.abs(blackScholesDelta("CE", snap.spotPrice, supportStrike, yearsToExpiry, DEFAULT_RISK_FREE_RATE, DEFAULT_IMPLIED_VOLATILITY));
  const expectedStopDistance = Math.min(100 * 0.3, Math.max(100 * 0.1, expectedDelta * 50));

  assert.ok(Math.abs(setup.stopLoss - (100 - expectedStopDistance)) < 0.05, `expected stopLoss ~${100 - expectedStopDistance}, got ${setup.stopLoss}`);
  assert.ok(Math.abs(setup.target - (100 + expectedStopDistance * 2)) < 0.05, `expected target ~${100 + expectedStopDistance * 2}, got ${setup.target}`);
});

test("recommendation omits tradeSetup (without throwing) when the strike has no live premium", () => {
  const ticks = chainTicks.map((candidate) => (candidate.optionType === "CE" && candidate.strikePrice === supportStrike ? { ...candidate, lastPrice: undefined } : candidate));

  const recs = calculateTradeRecommendations(snapshot(ticks, 24010, supportStrike), bullishPressure, bullishMarketBias(), [strikeMovementRow({ netScore: 5 })], noInterpretation);

  const rec = recs.find((candidate) => candidate.id === "bullish-bias");
  assert.ok(rec, "the recommendation itself should still fire");
  assert.equal(rec!.tradeSetup, undefined);
});

test("near-resistance recommendation includes a PE trade setup anchored to the resistance strike", () => {
  const recs = calculateTradeRecommendations(
    snapshot(chainTicks, 24190, supportStrike),
    bullishPressure,
    bullishMarketBias({ bias: "Bearish" }),
    [strikeMovementRow({ netScore: 5 })],
    noInterpretation
  );

  const rec = recs.find((candidate) => candidate.id === "near-resistance");
  assert.ok(rec, "expected a near-resistance recommendation to fire when spot is close to the resistance zone");
  assert.ok(rec!.tradeSetup);
  assert.equal(rec!.tradeSetup!.optionType, "PE");
  assert.equal(rec!.tradeSetup!.strike, 24200);
  assert.equal(rec!.tradeSetup!.entryPrice, 150);
});

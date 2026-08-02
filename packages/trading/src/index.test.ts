import { test } from "node:test";
import assert from "node:assert/strict";
import type { AtmStraddleExpectedMove, MarketBiasSummary, OptionChainSnapshot, OptionContractTick, PressureScore, StrikeMovementRow, TradeInterpretation } from "@option-decode/types";
import { buildSellerTradeSetup, calculateTradeRecommendations, inferSellerTimeframe } from "./index.ts";
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

test("stop-loss sizing uses the strike spacing near the traded strike, not the far-wing spacing", () => {
  // Reproduces the exact live BANKNIFTY shape: tight spacing near the
  // money (50 here, matching chainTicks), but a much wider gap out in the
  // wing (1000 here, vs live BANKNIFTY's 500 wing gap against a 100
  // near-ATM gap). The traded strike (supportStrike, 24000) is right next
  // to the tight cluster - scanning from the bottom of the chain for the
  // first positive gap would hit the wide 23000->24000 gap first and
  // inflate the stop-loss distance well past what "one level against you"
  // near this specific strike actually means.
  const ticks = [...chainTicks, tick({ optionType: "CE", strikePrice: 23000, lastPrice: 200 }), tick({ optionType: "PE", strikePrice: 23000, lastPrice: 5 })];

  const recs = calculateTradeRecommendations(snapshot(ticks, 24010, supportStrike), bullishPressure, bullishMarketBias(), [strikeMovementRow({ netScore: 5 })], noInterpretation);

  const setup = recs.find((candidate) => candidate.id === "bullish-bias")!.tradeSetup!;
  // Same result as the near-ATM-only chain above (50-point interval) -
  // adding a far, wide-spaced strike must not change the stop/target
  // computed for a strike nowhere near it. Before the fix this would have
  // used the 1000-point wing gap instead: delta 0.5 * 1000 = 500, clamped
  // to the 30% ceiling (30) instead of the correct 25, giving stopLoss 70
  // / target 160.
  assert.equal(setup.stopLoss, 75);
  assert.equal(setup.target, 150);
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

test("max-pain recommendations never fire on a contract far from expiry, even when spot sits exactly at max pain", () => {
  // Reproduces the exact live shape (BANKNIFTY): a monthly-horizon
  // contract (default snapshot() expiry is ~30 calendar days out) can
  // still show spot pinned at max pain, but the "writers push spot toward
  // max pain" thesis only holds meaningfully near expiry.
  const recs = calculateTradeRecommendations(
    snapshot(chainTicks, 24000, 24000),
    { ...bullishPressure, maxPain: 24000 },
    bullishMarketBias({ bias: "Balanced" }),
    [strikeMovementRow({ netScore: 0 })],
    noInterpretation
  );
  assert.equal(recs.find((rec) => rec.id === "at-max-pain"), undefined);
  assert.equal(recs.find((rec) => rec.id === "near-max-pain"), undefined);
});

test("max-pain recommendations fire once the contract is within the weekly days-to-expiry window", () => {
  const nearExpirySnapshot: OptionChainSnapshot = { ...snapshot(chainTicks, 24000, 24000), expiry: "2026-07-03" }; // ~2 days out from the default snapshotTime
  const recs = calculateTradeRecommendations(
    nearExpirySnapshot,
    { ...bullishPressure, maxPain: 24000 },
    bullishMarketBias({ bias: "Balanced" }),
    [strikeMovementRow({ netScore: 0 })],
    noInterpretation
  );
  assert.ok(recs.some((rec) => rec.id === "at-max-pain"), "expected at-max-pain to fire close to expiry");
});

// ---------------------------------------------------------------------
// Seller-side setup builder (buildSellerTradeSetup / inferSellerTimeframe)
// ---------------------------------------------------------------------

test("inferSellerTimeframe classifies purely by calendar days to expiry, not any per-symbol weekday", () => {
  assert.equal(inferSellerTimeframe(0), "intraday");
  assert.equal(inferSellerTimeframe(1), "intraday");
  assert.equal(inferSellerTimeframe(1.5), "weekly");
  assert.equal(inferSellerTimeframe(8), "weekly");
  assert.equal(inferSellerTimeframe(8.5), "monthly");
  assert.equal(inferSellerTimeframe(29), "monthly");
});

test("buildSellerTradeSetup picks the OTM strike closest to the timeframe's target delta and sizes SL/target off collected premium", () => {
  const ticks = [
    tick({ optionType: "CE", strikePrice: 25150, delta: 0.13, lastPrice: 22 }),
    tick({ optionType: "CE", strikePrice: 25300, delta: 0.1, lastPrice: 12 }),
    tick({ optionType: "PE", strikePrice: 24850, delta: 0.13, lastPrice: 24 }),
    tick({ optionType: "PE", strikePrice: 24700, delta: 0.1, lastPrice: 14 })
  ];
  const snap = snapshot(ticks, 25000, 25000);

  // Weekly band is 0.10-0.15, target 0.125 - 25150 (delta 0.13, |diff|=0.005)
  // beats 25300 (delta 0.10, |diff|=0.025).
  const ceSetup = buildSellerTradeSetup(snap, "CE", "weekly");
  assert.ok(ceSetup);
  assert.equal(ceSetup!.strike, 25150);
  assert.equal(ceSetup!.entryPrice, 22);
  assert.equal(ceSetup!.stopLoss, 38.5); // 22 * 1.75x
  assert.equal(ceSetup!.target, 11); // 22 * 50%
  assert.equal(ceSetup!.breakevenAtExpiry, 25172); // 25150 + 22
  assert.equal(ceSetup!.timeframe, "weekly");
  assert.equal(ceSetup!.targetDelta, 0.125);

  const peSetup = buildSellerTradeSetup(snap, "PE", "weekly");
  assert.ok(peSetup);
  assert.equal(peSetup!.strike, 24850);
  assert.equal(peSetup!.breakevenAtExpiry, 24826); // 24850 - 24
});

test("buildSellerTradeSetup prefers a strike beyond a supplied expected-move boundary over a closer-to-target-delta strike", () => {
  const ticks = [
    tick({ optionType: "CE", strikePrice: 25150, delta: 0.13, lastPrice: 22 }),
    tick({ optionType: "CE", strikePrice: 25300, delta: 0.1, lastPrice: 12 })
  ];
  const snap = snapshot(ticks, 25000, 25000);

  const withoutBoundary = buildSellerTradeSetup(snap, "CE", "weekly");
  assert.equal(withoutBoundary!.strike, 25150, "closer-to-target-delta strike wins with no boundary supplied");

  const withBoundary = buildSellerTradeSetup(snap, "CE", "weekly", 25200);
  assert.equal(withBoundary!.strike, 25300, "25150 sits inside the 25200 expected-move boundary, so the search should move to 25300");
});

test("buildSellerTradeSetup only considers OTM strikes (CE above spot, PE below) and returns undefined without any live premium", () => {
  const ticks = [tick({ optionType: "CE", strikePrice: 24900, delta: 0.6, lastPrice: 250 })]; // ITM, below spot for a CE
  const snap = snapshot(ticks, 25000, 25000);
  assert.equal(buildSellerTradeSetup(snap, "CE", "weekly"), undefined);
});

test("seller-safety recommendation carries concrete PE+CE sellSetups sized to the chain's own timeframe", () => {
  const ticks = [
    tick({ optionType: "PE", strikePrice: 24800, delta: 0.08, lastPrice: 20 }),
    tick({ optionType: "PE", strikePrice: 24700, delta: 0.04, lastPrice: 10 }),
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.08, lastPrice: 18 }),
    tick({ optionType: "CE", strikePrice: 25300, delta: 0.04, lastPrice: 9 })
  ];
  // Default snapshot() expiry (2026-07-31) is ~30 calendar days out from the
  // default snapshotTime (2026-07-01), so this reads as "monthly" (band
  // 0.05-0.10, target 0.075).
  const snap = snapshot(ticks, 25000, 25000);

  const recs = calculateTradeRecommendations(snap, bullishPressure, bullishMarketBias(), [strikeMovementRow()], { buyerScore: 0, sellerScore: 200 });
  const rec = recs.find((candidate) => candidate.id === "seller-safety");
  assert.ok(rec, "expected seller-safety recommendation to fire");
  assert.equal(rec!.sellSetups?.length, 2);

  // Monthly risk profile: stop at 2x entry, profit-take at 55% decay.
  const pe = rec!.sellSetups!.find((setup) => setup.optionType === "PE")!;
  assert.equal(pe.strike, 24800);
  assert.equal(pe.timeframe, "monthly");
  assert.equal(pe.stopLoss, 40);
  assert.equal(pe.target, 9);
  assert.equal(pe.breakevenAtExpiry, 24780);
  assert.equal(pe.probabilityOfProfit, 92); // 1 - |0.08|

  const ce = rec!.sellSetups!.find((setup) => setup.optionType === "CE")!;
  assert.equal(ce.strike, 25200);
  assert.equal(ce.stopLoss, 36);
  assert.equal(ce.target, 8.1);
  assert.equal(ce.breakevenAtExpiry, 25218);
  assert.equal(ce.probabilityOfProfit, 92);

  assert.match(rec!.action, /monthly delta-band setup/);
});

test("seller risk parameters vary by timeframe instead of one fixed multiplier for every setup", () => {
  // Same strike/premium/delta shape, only the chain's expiry differs, so
  // any difference in stop/target comes purely from the timeframe profile.
  const ticks = [tick({ optionType: "PE", strikePrice: 24800, delta: 0.12, lastPrice: 20 })];
  const intradaySetup = buildSellerTradeSetup({ ...snapshot(ticks, 25000, 25000), expiry: "2026-07-01" }, "PE", "intraday")!;
  const monthlySetup = buildSellerTradeSetup(snapshot(ticks, 25000, 25000), "PE", "monthly")!;

  assert.ok(
    intradaySetup.stopLossMultiplier < monthlySetup.stopLossMultiplier,
    "intraday sits closest to the money with the sharpest gamma risk, so it should take the tighter stop"
  );
  assert.ok(intradaySetup.stopLoss < monthlySetup.stopLoss);
  assert.ok(monthlySetup.target < intradaySetup.target, "monthly banks a deeper share of the premium per the IV-crush rule");
});

test("probabilityOfProfit is derived from the strike actually picked, and rises as the delta band deepens", () => {
  const nearTheMoney = [tick({ optionType: "PE", strikePrice: 24800, delta: 0.2, lastPrice: 20 })];
  const deepOtm = [tick({ optionType: "PE", strikePrice: 24800, delta: 0.05, lastPrice: 20 })];

  const nearSetup = buildSellerTradeSetup(snapshot(nearTheMoney, 25000, 25000), "PE", "intraday")!;
  const deepSetup = buildSellerTradeSetup(snapshot(deepOtm, 25000, 25000), "PE", "monthly")!;

  assert.equal(nearSetup.probabilityOfProfit, 80); // 1 - |0.20|
  assert.equal(deepSetup.probabilityOfProfit, 95); // 1 - |0.05|
  assert.ok(
    deepSetup.probabilityOfProfit > nearSetup.probabilityOfProfit && deepSetup.riskRewardRatio < nearSetup.riskRewardRatio,
    "premium selling trades payoff for probability - the deeper-OTM write should show higher POP against a nominally worse R:R"
  );
});

test("buyer-momentum fires on a strongly negative buyerScore too - genuine PE-buying momentum, not just CE", () => {
  // buyerScore is a net directional sum (CE activity positive, PE activity
  // negative - see getBuyerMomentumScore in @option-decode/analytics), not
  // a naturally-positive magnitude. A bare >= gate previously meant this
  // recommendation could never fire on real PE-buying momentum at all.
  const snap = snapshot([tick({ optionType: "PE", strikePrice: 24800, delta: 0.18, lastPrice: 20 })], 25000, 25000);
  const recs = calculateTradeRecommendations(snap, bullishPressure, bullishMarketBias({ bias: "Bearish" }), [strikeMovementRow()], {
    buyerScore: -200,
    sellerScore: 0
  });
  const rec = recs.find((candidate) => candidate.id === "buyer-momentum");
  assert.ok(rec, "expected buyer-momentum to fire on a strongly negative buyerScore");
  assert.match(rec!.explanation, /PE-side long buildup/);
});

test("seller-safety fires on a strongly negative sellerScore too - genuine CE-writing safety, not just PE", () => {
  const snap = snapshot(
    [
      tick({ optionType: "CE", strikePrice: 25200, delta: 0.08, lastPrice: 18 }),
      tick({ optionType: "CE", strikePrice: 25300, delta: 0.04, lastPrice: 9 })
    ],
    25000,
    25000
  );
  const recs = calculateTradeRecommendations(snap, bullishPressure, bullishMarketBias({ bias: "Balanced" }), [strikeMovementRow()], {
    buyerScore: 0,
    sellerScore: -200
  });
  const rec = recs.find((candidate) => candidate.id === "seller-safety");
  assert.ok(rec, "expected seller-safety to fire on a strongly negative sellerScore");
  assert.match(rec!.explanation, /CE-side writing/);
});

test("balanced-market recommendation carries a two-leg sellSetups strangle instead of only text guidance", () => {
  const ticks = [
    tick({ optionType: "PE", strikePrice: 24800, delta: 0.08, lastPrice: 20 }),
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.08, lastPrice: 18 })
  ];
  const snap = snapshot(ticks, 25000, 25000);
  const balancedPressure: PressureScore = { bullishPressure: 50, bearishPressure: 50, supportZones: [], resistanceZones: [], pcr: 1.0, maxPain: undefined };

  const recs = calculateTradeRecommendations(snap, balancedPressure, bullishMarketBias({ bias: "Balanced" }), [strikeMovementRow({ netScore: 0 })], noInterpretation);
  const rec = recs.find((candidate) => candidate.id === "balanced-market");
  assert.ok(rec, "expected balanced-market recommendation to fire");
  assert.equal(rec!.sellSetups?.length, 2);
});

test("calculateTradeRecommendations biases seller-safety strikes beyond a supplied weekly ATM-straddle boundary", () => {
  const ticks = [
    tick({ optionType: "CE", strikePrice: 25150, delta: 0.13, lastPrice: 22 }),
    tick({ optionType: "CE", strikePrice: 25300, delta: 0.1, lastPrice: 12 }),
    tick({ optionType: "PE", strikePrice: 24850, delta: 0.13, lastPrice: 24 }),
    tick({ optionType: "PE", strikePrice: 24700, delta: 0.1, lastPrice: 14 })
  ];
  // ~2 days to expiry from the default snapshotTime -> "weekly" timeframe.
  const snap: OptionChainSnapshot = { ...snapshot(ticks, 25000, 25000), expiry: "2026-07-03" };
  const atmStraddle: AtmStraddleExpectedMove = {
    atmStrike: 25000,
    atmCallPrice: 100,
    atmPutPrice: 100,
    atmStraddlePrice: 200,
    expectedUpperBoundary: 25200,
    expectedLowerBoundary: 24800
  };

  const recs = calculateTradeRecommendations(snap, bullishPressure, bullishMarketBias(), [strikeMovementRow()], { buyerScore: 0, sellerScore: 200 }, atmStraddle);
  const rec = recs.find((candidate) => candidate.id === "seller-safety")!;
  const ce = rec.sellSetups!.find((setup) => setup.optionType === "CE")!;
  const pe = rec.sellSetups!.find((setup) => setup.optionType === "PE")!;

  assert.equal(ce.strike, 25300, "25150 sits inside the 25200 expected-move edge, so the boundary should push selection to 25300");
  assert.equal(pe.strike, 24700, "24850 sits inside the 24800 expected-move edge, so the boundary should push selection to 24700");
});

test("near-support and near-resistance never ship together - a directional bias picks the matching side", () => {
  // Reproduces the exact live shape (NIFTY): spot sits within 80pts of
  // BOTH a support and a resistance zone at once, and both proximity
  // conditions fire independently with no cross-exclusivity.
  const ticks = [
    tick({ optionType: "CE", strikePrice: 24000, lastPrice: 100, delta: 0.55 }),
    tick({ optionType: "PE", strikePrice: 24000, lastPrice: 40 }),
    tick({ optionType: "CE", strikePrice: 24140, lastPrice: 30 }),
    tick({ optionType: "PE", strikePrice: 24140, lastPrice: 90, delta: -0.45 })
  ];
  const pressure: PressureScore = {
    bullishPressure: 60,
    bearishPressure: 40,
    supportZones: [{ strikePrice: 24000, score: 100, reason: "PE support pressure" }],
    resistanceZones: [{ strikePrice: 24140, score: 80, reason: "CE resistance pressure" }],
    pcr: 1.2,
    maxPain: undefined
  };

  const recs = calculateTradeRecommendations(snapshot(ticks, 24075, 24000), pressure, bullishMarketBias(), [strikeMovementRow({ netScore: 5 })], noInterpretation);
  assert.ok(recs.some((rec) => rec.id === "near-support"), "Bullish bias should keep the near-support (buy CE) recommendation");
  assert.equal(
    recs.find((rec) => rec.id === "near-resistance"),
    undefined,
    "Bullish bias should drop the contradictory near-resistance (buy PE) recommendation"
  );
});

test("near-support and near-resistance are both dropped when the market bias itself is Balanced", () => {
  const ticks = [
    tick({ optionType: "CE", strikePrice: 24000, lastPrice: 100, delta: 0.55 }),
    tick({ optionType: "PE", strikePrice: 24000, lastPrice: 40 }),
    tick({ optionType: "CE", strikePrice: 24140, lastPrice: 30 }),
    tick({ optionType: "PE", strikePrice: 24140, lastPrice: 90, delta: -0.45 })
  ];
  const pressure: PressureScore = {
    bullishPressure: 51,
    bearishPressure: 49,
    supportZones: [{ strikePrice: 24000, score: 100, reason: "PE support pressure" }],
    resistanceZones: [{ strikePrice: 24140, score: 80, reason: "CE resistance pressure" }],
    pcr: 1.0,
    maxPain: undefined
  };

  const recs = calculateTradeRecommendations(
    snapshot(ticks, 24075, 24000),
    pressure,
    bullishMarketBias({ bias: "Balanced" }),
    [strikeMovementRow({ netScore: 0 })],
    noInterpretation
  );
  assert.equal(recs.find((rec) => rec.id === "near-support"), undefined, "neither side is better justified with no directional bias");
  assert.equal(recs.find((rec) => rec.id === "near-resistance"), undefined, "neither side is better justified with no directional bias");
});

test("buyer-momentum and seller-safety never ship together - a directional bias favors buying, no bias favors selling", () => {
  const ticks = [
    tick({ optionType: "PE", strikePrice: 24800, delta: 0.08, lastPrice: 20 }),
    tick({ optionType: "CE", strikePrice: 25200, delta: 0.08, lastPrice: 18 })
  ];
  const snap = snapshot(ticks, 25000, 25000);
  const interpretation: TradeInterpretation = { buyerScore: 200, sellerScore: 200 };

  const directional = calculateTradeRecommendations(snap, bullishPressure, bullishMarketBias(), [strikeMovementRow()], interpretation);
  assert.ok(directional.some((rec) => rec.id === "buyer-momentum"), "a directional bias should keep buyer-momentum");
  assert.equal(
    directional.find((rec) => rec.id === "seller-safety"),
    undefined,
    "a directional bias should drop the contradictory seller-safety recommendation"
  );

  const balancedPressure: PressureScore = { bullishPressure: 50, bearishPressure: 50, supportZones: [], resistanceZones: [], pcr: 1.0, maxPain: undefined };
  const balanced = calculateTradeRecommendations(
    snap,
    balancedPressure,
    bullishMarketBias({ bias: "Balanced" }),
    [strikeMovementRow({ netScore: 0 })],
    interpretation
  );
  assert.ok(balanced.some((rec) => rec.id === "seller-safety"), "no directional bias should keep seller-safety");
  assert.equal(
    balanced.find((rec) => rec.id === "buyer-momentum"),
    undefined,
    "no directional bias should drop the contradictory buyer-momentum recommendation"
  );
});

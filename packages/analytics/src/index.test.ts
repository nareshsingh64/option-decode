import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketPulsePoint, OptionChainSnapshot, OptionContractTick, PressureScore } from "@option-decode/types";
import {
  calculateAtmStraddleExpectedMove,
  calculateChainStats,
  calculateMarketBias,
  calculateMarketPulse,
  calculatePressureScore,
  calculateStrikeMovement,
  calculateTradeInterpretation,
  classifyOptionActivity,
  generateMarketAlerts
} from "./index.ts";

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

// calculateMaxPain is an internal helper here (not exported) — it's
// exercised indirectly via calculatePressureScore().maxPain, which is how
// every caller actually consumes it.
test("calculatePressureScore.maxPain picks the strike that minimizes total option-writer payout", () => {
  const snap = snapshot(
    [
      tick({ optionType: "PE", strikePrice: 100, openInterest: 100 }),
      tick({ optionType: "CE", strikePrice: 200, openInterest: 50 }),
      tick({ optionType: "PE", strikePrice: 200, openInterest: 50 }),
      tick({ optionType: "CE", strikePrice: 300, openInterest: 100 })
    ],
    200,
    200
  );

  assert.equal(calculatePressureScore(snap).maxPain, 200);
});

test("calculatePressureScore: heavy PE writing skews bullish and PCR > 1", () => {
  const snap = snapshot(
    [
      tick({ optionType: "PE", strikePrice: 24800, openInterest: 5000, changeInOpenInterest: 800, lastPriceChange: -2, volume: 1000 }),
      tick({ optionType: "CE", strikePrice: 25200, openInterest: 1000, changeInOpenInterest: 100, lastPriceChange: 1, volume: 200 })
    ],
    25000,
    25000
  );

  const pressure = calculatePressureScore(snap);
  assert.ok(pressure.bullishPressure > pressure.bearishPressure, "PE-writing-dominated chain should be bullish-pressure-dominated");
  assert.ok(pressure.pcr !== undefined && pressure.pcr > 1, "heavier PE OI should push PCR above 1");
  assert.equal(pressure.supportZones[0]?.strikePrice, 24800);
  assert.equal(pressure.resistanceZones[0]?.strikePrice, 25200);
});

test("calculatePressureScore never divides by zero on an empty chain", () => {
  const snap = snapshot([], 25000, 25000);
  const pressure = calculatePressureScore(snap);
  assert.equal(pressure.bullishPressure, 0);
  assert.equal(pressure.bearishPressure, 0);
});

test("generateMarketAlerts fires a critical resistance alert on strong bearish pressure", () => {
  const snap = snapshot([], 25000, 25000);
  const pressure: PressureScore = {
    bullishPressure: 35,
    bearishPressure: 65,
    supportZones: [],
    resistanceZones: [{ strikePrice: 25100, score: 500, reason: "test" }],
    pcr: 0.8,
    maxPain: undefined
  };

  const alerts = generateMarketAlerts(snap, pressure, new Date("2026-07-01T09:30:00.000Z"));
  const resistanceAlert = alerts.find((alert) => alert.metric === "bearishPressure");
  assert.ok(resistanceAlert, "expected a bearishPressure alert");
  assert.equal(resistanceAlert?.severity, "critical");
});

test("generateMarketAlerts flags pinning risk when spot is within the proximity threshold of Max Pain", () => {
  const snap = snapshot([], 25000, 25000);
  const pressure: PressureScore = {
    bullishPressure: 50,
    bearishPressure: 50,
    supportZones: [],
    resistanceZones: [],
    pcr: 1,
    maxPain: 25010
  };

  const alerts = generateMarketAlerts(snap, pressure);
  const pinAlert = alerts.find((alert) => alert.metric === "maxPainDistance");
  assert.ok(pinAlert, "expected a maxPainDistance alert");
  assert.equal(pinAlert?.title, "CMP near max pain");
});

test("classifyOptionActivity reads the four OI/LTP combinations correctly", () => {
  const base = { optionType: "CE" as const, strikePrice: 25000 };
  assert.equal(classifyOptionActivity(tick({ ...base, changeInOpenInterest: 10, lastPriceChange: 1 })), "LONG_BUILDUP");
  assert.equal(classifyOptionActivity(tick({ ...base, changeInOpenInterest: 10, lastPriceChange: -1 })), "WRITING");
  assert.equal(classifyOptionActivity(tick({ ...base, changeInOpenInterest: -10, lastPriceChange: 1 })), "SHORT_COVERING");
  assert.equal(classifyOptionActivity(tick({ ...base, changeInOpenInterest: -10, lastPriceChange: -1 })), "LONG_UNWINDING");
  assert.equal(classifyOptionActivity(tick({ ...base, changeInOpenInterest: 0, lastPriceChange: 0 })), "NEUTRAL");
  assert.equal(classifyOptionActivity(undefined), "NEUTRAL");
});

test("calculateChainStats classifies OI breadth from total CE vs PE open interest", () => {
  const putSupport = snapshot(
    [
      tick({ optionType: "PE", strikePrice: 24800, openInterest: 8000 }),
      tick({ optionType: "CE", strikePrice: 25200, openInterest: 5000 })
    ],
    25000,
    25000
  );
  assert.equal(calculateChainStats(putSupport).breadth, "Put Support");

  const callResistance = snapshot(
    [
      tick({ optionType: "PE", strikePrice: 24800, openInterest: 4000 }),
      tick({ optionType: "CE", strikePrice: 25200, openInterest: 9000 })
    ],
    25000,
    25000
  );
  assert.equal(calculateChainStats(callResistance).breadth, "Call Resistance");
  assert.equal(calculateChainStats(callResistance).maxOiStrike, 25200);
  assert.equal(calculateChainStats(callResistance).maxOiOptionType, "CE");

  const balanced = snapshot(
    [
      tick({ optionType: "PE", strikePrice: 24800, openInterest: 5000 }),
      tick({ optionType: "CE", strikePrice: 25200, openInterest: 5000 })
    ],
    25000,
    25000
  );
  assert.equal(calculateChainStats(balanced).breadth, "Balanced");
});

test("calculateStrikeMovement windows to ATM +/-4 and reflects PE-support buildup as a positive net score", () => {
  const strikes = [24600, 24700, 24800, 24900, 25000, 25100, 25200, 25300, 25400];
  const ticks: OptionContractTick[] = [];
  for (const strike of strikes) {
    ticks.push(tick({ optionType: "PE", strikePrice: strike, openInterest: 4000, changeInOpenInterest: 600, lastPriceChange: -1, volume: 500 }));
    ticks.push(tick({ optionType: "CE", strikePrice: strike, openInterest: 1000, changeInOpenInterest: 50, lastPriceChange: 0.2, volume: 100 }));
  }
  const snap = snapshot(ticks, 25000, 25000);

  const rows = calculateStrikeMovement(snap);
  assert.equal(rows.length, 9, "should return the ATM +/-4 window");
  assert.ok(rows.every((row) => row.netScore > 0), "PE-dominated chain should show a positive net score across the window");
  const atmRow = rows.find((row) => row.isAtm);
  assert.ok(atmRow, "one row must be flagged as ATM");
  assert.equal(atmRow?.bias, "Up / support");

  const interpretation = calculateTradeInterpretation(rows);
  assert.equal(typeof interpretation.buyerScore, "number");
  assert.equal(typeof interpretation.sellerScore, "number");
});

test("calculateStrikeMovement returns an empty array when the ATM strike isn't in the chain", () => {
  const snap = snapshot([tick({ optionType: "CE", strikePrice: 100, openInterest: 10 })], 999, 999);
  assert.deepEqual(calculateStrikeMovement(snap), []);
});

test("calculateStrikeMovement matches a hand-computed worked example exactly", () => {
  // Every strike gets identical PE/CE data so the per-row math can be
  // verified: pressureValue(tick, averageVolume) includes a volume-surge
  // weighting term (weightedVolumeContribution) on top of OI/OI-change/LTP.
  // PE: oi=4000, oiChange=+600, ltpChange=-1 (writing), volume=500,
  // averageVolume across the 5 PE legs = 500 (no surge, 500 is not >
  // 2x itself) => volumeContribution = 500*0.5 = 250.
  // pressureValue = 4000 + 600*1.5 + 250 = 5150.
  // CE: oi=1000, oiChange=+50, ltpChange=+0.2 (long buildup), volume=100,
  // averageVolume = 100 => volumeContribution = 100*0.5 = 50.
  // pressureValue = 1000 + 50*0.4 + 50*0.5 = 1045.
  // These exact figures were verified by executing calculateStrikeMovement
  // directly against this fixture, not derived by hand alone.
  const strikes = [24800, 24900, 25000, 25100, 25200];
  const ticks: OptionContractTick[] = [];
  for (const strike of strikes) {
    // sessionOiChange/sessionPriceChangePercent (since today's market
    // open) are set here to the same figures changeInOpenInterest/
    // lastPriceChangePercent (vs previous day's close) used to carry,
    // purely so this worked example's numbers still line up -
    // calculateStrikeTrend reads the "session" pair now, not the
    // previous-day one (see its doc comment for why).
    ticks.push(tick({ optionType: "PE", strikePrice: strike, openInterest: 4000, changeInOpenInterest: 600, lastPriceChange: -1, lastPriceChangePercent: -1, sessionOiChange: 600, sessionPriceChangePercent: -1, volume: 500 }));
    ticks.push(tick({ optionType: "CE", strikePrice: strike, openInterest: 1000, changeInOpenInterest: 50, lastPriceChange: 0.2, lastPriceChangePercent: 0.5, sessionOiChange: 50, sessionPriceChangePercent: 0.5, volume: 100 }));
  }
  const snap = snapshot(ticks, 25000, 25000);
  const rows = calculateStrikeMovement(snap);
  const atmRow = rows.find((row) => row.isAtm)!;

  assert.equal(atmRow.peScore, 5150);
  assert.equal(atmRow.ceScore, 1045);
  assert.equal(atmRow.netScore, 4105);
  assert.equal(atmRow.netScorePercent, 66);
  assert.equal(atmRow.bias, "Up / support");

  // trendScore per strike = strikeTrend(pe) - strikeTrend(ce), built from
  // sessionOiChange/sessionPriceChangePercent (since today's open), not
  // the previous-day changeInOpenInterest/lastPriceChangePercent above:
  //   strikeTrend(pe) = 600 + (-1)*2 = 598, strikeTrend(ce) = 50 + 0.5*2 = 51
  //   trendScore = 547 for every strike, which exceeds the fixed
  // STRIKE_TREND_THRESHOLD, so a uniform chain-wide PE-writing move across
  // the whole ATM zone is correctly flagged as building everywhere — this
  // used to be misclassified as "Flat" when the threshold was the median of
  // this same window (a uniform move raised its own bar right along with it).
  assert.equal(atmRow.trendScore, 547);
  assert.equal(atmRow.trendDirection, 1);
  assert.equal(atmRow.trend, "Increasing support");
});

test("calculateStrikeMovement still calls small, noise-level moves Flat", () => {
  const strikes = [24800, 24900, 25000, 25100, 25200];
  const ticks: OptionContractTick[] = [];
  for (const strike of strikes) {
    // trendScore = strikeTrend(pe) - strikeTrend(ce) = (2 + 0) - (0 + 0) = 2, well under STRIKE_TREND_THRESHOLD.
    ticks.push(tick({ optionType: "PE", strikePrice: strike, openInterest: 1000, changeInOpenInterest: 2 }));
    ticks.push(tick({ optionType: "CE", strikePrice: strike, openInterest: 1000, changeInOpenInterest: 0 }));
  }
  const snap = snapshot(ticks, 25000, 25000);
  const rows = calculateStrikeMovement(snap);
  assert.ok(rows.every((row) => row.trend === "Flat" && row.trendDirection === 0));
});

test("calculateStrikeMovement mirrors correctly for a CE-dominated (bearish/resistance) chain", () => {
  const strikes = [24800, 24900, 25000, 25100, 25200];
  const ticks: OptionContractTick[] = [];
  for (const strike of strikes) {
    ticks.push(tick({ optionType: "CE", strikePrice: strike, openInterest: 5000, changeInOpenInterest: 700, lastPriceChange: -1.5, volume: 400 }));
    ticks.push(tick({ optionType: "PE", strikePrice: strike, openInterest: 900, changeInOpenInterest: 40, lastPriceChange: 0.1, volume: 80 }));
  }
  const snap = snapshot(ticks, 25000, 25000);
  const rows = calculateStrikeMovement(snap);

  assert.ok(rows.every((row) => row.netScore < 0), "CE-writing-dominated chain should show a negative net score across the window");
  const atmRow = rows.find((row) => row.isAtm)!;
  assert.equal(atmRow.bias, "Down / resistance");
});

test("calculateStrikeMovement degrades gracefully when ATM sits at the edge of the available strikes", () => {
  // Only strikes at and above ATM exist (e.g. a partial/stale data feed) —
  // the window should just be shorter, not throw or wrap around.
  const strikes = [25000, 25100, 25200];
  const ticks = strikes.flatMap((strike) => [
    tick({ optionType: "PE", strikePrice: strike, openInterest: 1000 }),
    tick({ optionType: "CE", strikePrice: strike, openInterest: 1000 })
  ]);
  const snap = snapshot(ticks, 25000, 25000);
  const rows = calculateStrikeMovement(snap);

  assert.equal(rows.length, 3, "window should be clipped, not padded or wrapped");
  assert.ok(rows.some((row) => row.isAtm));
});

test("calculateStrikeMovement treats a missing leg as zero pressure instead of crashing", () => {
  // Only a CE tick exists at this strike (e.g. a PE contract briefly absent
  // from the feed) — the PE side must score 0, not NaN/undefined.
  const strikes = [24800, 24900, 25000, 25100, 25200];
  const ticks: OptionContractTick[] = [];
  for (const strike of strikes) {
    ticks.push(tick({ optionType: "CE", strikePrice: strike, openInterest: 1000, changeInOpenInterest: 50, lastPriceChange: 0.2, volume: 100 }));
  }
  const snap = snapshot(ticks, 25000, 25000);
  const rows = calculateStrikeMovement(snap);
  const atmRow = rows.find((row) => row.isAtm)!;

  assert.equal(atmRow.peScore, 0);
  assert.equal(atmRow.peActivity, "NEUTRAL");
  assert.ok(Number.isFinite(atmRow.netScore));
});

test("calculateMarketBias: wide bullish pressure gap yields an actionable, high-conviction bullish read", () => {
  const snap = snapshot([], 25000, 25000);
  const pressure: PressureScore = {
    bullishPressure: 75,
    bearishPressure: 25,
    supportZones: [{ strikePrice: 24900, score: 1000, reason: "test" }],
    resistanceZones: [{ strikePrice: 25200, score: 400, reason: "test" }],
    pcr: 1.3,
    maxPain: 25000
  };

  const bias = calculateMarketBias(snap, pressure);
  assert.equal(bias.bias, "Bullish");
  assert.equal(bias.readiness, "Actionable");
  assert.equal(bias.conviction, "High");
  assert.equal(bias.pcrContext, "strong-put-support");
  assert.ok(bias.nearMaxPain);
  assert.equal(bias.setupQuality, "A+ Setup");
});

test("calculateMarketBias: near-even pressure yields a Balanced/Wait/Neutral read", () => {
  const snap = snapshot([], 25000, 25000);
  const pressure: PressureScore = {
    bullishPressure: 51,
    bearishPressure: 49,
    supportZones: [],
    resistanceZones: [],
    pcr: undefined,
    maxPain: undefined
  };

  const bias = calculateMarketBias(snap, pressure);
  assert.equal(bias.bias, "Balanced");
  assert.equal(bias.readiness, "Wait");
  assert.equal(bias.conviction, "Neutral");
  assert.equal(bias.setupQuality, "No Edge");
});

function pulsePoint(minutesFromBase: number, spotPrice: number, bullishPressure: number, bearishPressure: number, pcr?: number): MarketPulsePoint {
  const base = Date.parse("2026-07-01T09:15:00.000Z");
  return {
    scoreTime: new Date(base + minutesFromBase * 60_000).toISOString(),
    spotPrice,
    bullishPressure,
    bearishPressure,
    pcr
  };
}

test("calculateMarketPulse returns null with fewer than 2 samples", () => {
  assert.equal(calculateMarketPulse([]), null);
  assert.equal(calculateMarketPulse([pulsePoint(0, 25000, 50, 50)]), null);
});

test("calculateMarketPulse: a steady rise reads back its exact points/min slope and is classified 'up'", () => {
  const points = [0, 1, 2, 3, 4].map((minute) => pulsePoint(minute, 25000 + minute * 10, 50, 50));
  const pulse = calculateMarketPulse(points);
  assert.ok(pulse);
  assert.equal(pulse.sampleCount, 5);
  assert.equal(pulse.windowMinutes, 4);
  assert.equal(pulse.spotRatePerMin, 10);
  assert.ok(pulse.spotRatePercentPerMin && pulse.spotRatePercentPerMin > 0.01);
  assert.equal(pulse.direction, "up");
});

test("calculateMarketPulse: a steady fall is classified 'down'", () => {
  const points = [0, 1, 2, 3, 4].map((minute) => pulsePoint(minute, 25000 - minute * 10, 50, 50));
  const pulse = calculateMarketPulse(points);
  assert.ok(pulse);
  assert.equal(pulse.spotRatePerMin, -10);
  assert.equal(pulse.direction, "down");
});

test("calculateMarketPulse: sub-deadband movement is classified 'flat' instead of up/down", () => {
  // 0.006%/min is below the 0.01%/min flat threshold - shouldn't tip either way.
  const points = [0, 1, 2].map((minute) => pulsePoint(minute, 25000 + minute * 1.5, 50, 50));
  const pulse = calculateMarketPulse(points);
  assert.ok(pulse);
  assert.equal(pulse.direction, "flat");
});

test("calculateMarketPulse fits a trend line through the whole window, not just first-vs-last", () => {
  // Hand-computed OLS: x=[0,1,2], y=[25000,25001,25003] -> slope = 1.5.
  // A naive first-vs-last delta would give (25003-25000)/2 = 1.5 too here,
  // but net pressure below uses the same [0,1,3] shape to confirm the
  // regression math itself (not just this coincidental case).
  const points = [pulsePoint(0, 25000, 50, 50, 1.0), pulsePoint(1, 25001, 51, 50), pulsePoint(2, 25003, 53, 50, 1.3)];
  const pulse = calculateMarketPulse(points);
  assert.ok(pulse);
  assert.equal(pulse.spotRatePerMin, 1.5);
  assert.equal(pulse.pressureNetRatePerMin, 1.5);
  // Only 2 of the 3 samples have a PCR value (t=0 and t=2), 2 minutes apart.
  // Floating-point division (0.3 / 2) doesn't land on an exact binary
  // fraction, so compare within a tight tolerance rather than by equality.
  assert.ok(pulse.pcrRatePerMin !== undefined && Math.abs(pulse.pcrRatePerMin - 0.15) < 1e-9);
});

test("calculateMarketPulse normalizes by actual elapsed minutes, not sample count", () => {
  // Same 10 pts/min rate as the earlier 5-sample test, but expressed as
  // just 2 samples 5 minutes apart - confirms the rate is per elapsed
  // wall-clock time, unaffected by how many (or few) snapshots fall
  // inside that time, which matters since capture can gap under load.
  const points = [pulsePoint(0, 25000, 50, 50), pulsePoint(5, 25050, 50, 50)];
  const pulse = calculateMarketPulse(points);
  assert.ok(pulse);
  assert.equal(pulse.sampleCount, 2);
  assert.equal(pulse.windowMinutes, 5);
  assert.equal(pulse.spotRatePerMin, 10);
});

// ---------------------------------------------------------------------
// Breakeven cushion on support/resistance zones (PressureZone.trueZone)
// ---------------------------------------------------------------------

test("calculatePressureScore zones carry the premium-adjusted true breakeven line, not just the raw OI strike", () => {
  const snap = snapshot(
    [
      tick({ optionType: "PE", strikePrice: 24800, openInterest: 5000, lastPrice: 40 }),
      tick({ optionType: "CE", strikePrice: 25200, openInterest: 4000, lastPrice: 35 })
    ],
    25000,
    25000
  );

  const pressure = calculatePressureScore(snap);
  const support = pressure.supportZones[0];
  const resistance = pressure.resistanceZones[0];

  assert.equal(support.premium, 40);
  assert.equal(support.trueZone, 24760); // strike - premium collected
  assert.equal(resistance.premium, 35);
  assert.equal(resistance.trueZone, 25235); // strike + premium collected
});

test("calculatePressureScore leaves trueZone/premium undefined when the anchoring tick has no live premium", () => {
  const snap = snapshot([tick({ optionType: "PE", strikePrice: 24800, openInterest: 5000, lastPrice: undefined })], 25000, 25000);
  const support = calculatePressureScore(snap).supportZones[0];
  assert.equal(support.premium, undefined);
  assert.equal(support.trueZone, undefined);
});

// ---------------------------------------------------------------------
// ATM Straddle expected-move (the playbook's literal Weekly ATM Straddle Rule)
// ---------------------------------------------------------------------

test("calculateAtmStraddleExpectedMove sums ATM CE+PE premium into an expected-move band around spot", () => {
  const snap = snapshot(
    [
      tick({ optionType: "CE", strikePrice: 25000, lastPrice: 120 }),
      tick({ optionType: "PE", strikePrice: 25000, lastPrice: 100 })
    ],
    25050,
    25000
  );

  const move = calculateAtmStraddleExpectedMove(snap);
  assert.ok(move);
  assert.equal(move!.atmStraddlePrice, 220);
  assert.equal(move!.expectedUpperBoundary, 25270);
  assert.equal(move!.expectedLowerBoundary, 24830);
});

test("calculateAtmStraddleExpectedMove returns undefined when either ATM leg has no live premium", () => {
  const snap = snapshot([tick({ optionType: "CE", strikePrice: 25000, lastPrice: 120 })], 25050, 25000);
  assert.equal(calculateAtmStraddleExpectedMove(snap), undefined);
});

// ---------------------------------------------------------------------
// Gamma-risk alert (index-agnostic: driven by the snapshot's own expiry
// date, not a hardcoded per-symbol weekday)
// ---------------------------------------------------------------------

test("generateMarketAlerts fires a critical gamma-risk alert when expiry is imminent and spot is pinned against a written wall", () => {
  const snap: OptionChainSnapshot = { ...snapshot([], 25000, 25000), expiry: "2026-07-02" };
  const pressure: PressureScore = {
    bullishPressure: 50,
    bearishPressure: 50,
    supportZones: [],
    resistanceZones: [{ strikePrice: 25050, score: 500, reason: "test" }], // within 0.5% of 25000 spot (125 pts)
    pcr: 1,
    maxPain: undefined
  };

  // "Now" is same-day as expiry, well inside the gamma-risk window.
  const alerts = generateMarketAlerts(snap, pressure, new Date("2026-07-02T04:00:00.000Z"));
  const gammaAlert = alerts.find((alert) => alert.metric === "gammaRisk");
  assert.ok(gammaAlert, "expected a gammaRisk alert when expiry is imminent and spot is pinned to a wall");
  assert.equal(gammaAlert?.severity, "critical");
});

test("generateMarketAlerts does not fire gamma-risk when expiry is still far away, even if spot is pinned to a wall", () => {
  const snap: OptionChainSnapshot = { ...snapshot([], 25000, 25000), expiry: "2026-07-31" };
  const pressure: PressureScore = {
    bullishPressure: 50,
    bearishPressure: 50,
    supportZones: [],
    resistanceZones: [{ strikePrice: 25050, score: 500, reason: "test" }],
    pcr: 1,
    maxPain: undefined
  };

  const alerts = generateMarketAlerts(snap, pressure, new Date("2026-07-02T04:00:00.000Z"));
  assert.equal(
    alerts.find((alert) => alert.metric === "gammaRisk"),
    undefined
  );
});

test("generateMarketAlerts does not fire gamma-risk when expiry is imminent but spot is nowhere near a written wall", () => {
  const snap: OptionChainSnapshot = { ...snapshot([], 25000, 25000), expiry: "2026-07-02" };
  const pressure: PressureScore = {
    bullishPressure: 50,
    bearishPressure: 50,
    supportZones: [],
    resistanceZones: [{ strikePrice: 26000, score: 500, reason: "test" }], // 1000pts away, well outside 0.5%
    pcr: 1,
    maxPain: undefined
  };

  const alerts = generateMarketAlerts(snap, pressure, new Date("2026-07-02T04:00:00.000Z"));
  assert.equal(
    alerts.find((alert) => alert.metric === "gammaRisk"),
    undefined
  );
});

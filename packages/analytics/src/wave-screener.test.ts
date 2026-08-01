import { test } from "node:test";
import assert from "node:assert/strict";
import type { ElliottWaveAnalysis, SpotPricePoint } from "@option-decode/types";
import { calculateElliottWave } from "./elliott-wave.ts";
import { evaluateWaveScreener } from "./wave-screener.ts";

function series(prices: number[], startTime = "2026-08-01T03:45:00.000Z", stepMs = 60_000): SpotPricePoint[] {
  return prices.map((price, i) => ({ time: new Date(new Date(startTime).getTime() + i * stepMs).toISOString(), price }));
}

function baseAnalysis(overrides: Partial<ElliottWaveAnalysis>): ElliottWaveAnalysis {
  return {
    underlyingSymbol: "TEST",
    zigZagPercent: 1,
    pivots: [],
    currentStage: "Undetermined",
    direction: "Undetermined",
    invalidated: false,
    ruleChecks: [],
    fibonacciLevels: [],
    lastPrice: 100,
    lastUpdated: new Date().toISOString(),
    ...overrides
  };
}

test("evaluateWaveScreener: end-to-end, a provisional Wave 2 in the Fibonacci zone now fires WAVE2_REVERSAL (index, no volume data)", () => {
  // Reproduces the exact SENSEX/COPPER shape observed live in production
  // (2026-08-01) - before the fix, this analysis had an empty
  // fibonacciLevels array and could never produce a signal.
  const points = series([100, 130, 113]);
  const analysis = calculateElliottWave("SENSEX", points, 1);
  const signal = evaluateWaveScreener(analysis, /* rsi */ 45, /* rvol */ undefined);

  assert.ok(signal, "a provisional Wave 2 in the 50-61.8% zone with no volume data must alert");
  assert.equal(signal!.alertType, "WAVE2_REVERSAL");
  assert.equal(signal!.direction, "Bullish");
});

test("evaluateWaveScreener: a provisional Wave 2 outside the Fibonacci zone does not fire", () => {
  const points = series([100, 130, 124]); // only 20% retracement
  const analysis = calculateElliottWave("SENSEX", points, 1);
  const signal = evaluateWaveScreener(analysis, 45, undefined);
  assert.equal(signal, undefined);
});

test("evaluateWaveScreener: Wave 2 in zone is suppressed when volume is defined and NOT declining", () => {
  const points = series([100, 130, 113]);
  const analysis = calculateElliottWave("VEDL", points, 1);
  const signal = evaluateWaveScreener(analysis, 45, /* rvol */ 1.5); // >= 1.0 ceiling, not declining
  assert.equal(signal, undefined);
});

test("evaluateWaveScreener: WAVE3_IMPULSE now fires for an index (no volume data) on momentum alone", () => {
  // Reproduces the exact BANKNIFTY shape observed live in production
  // (2026-08-01): valid, non-invalidated Wave 3 Initiation, rvol always
  // undefined for an index - previously structurally unreachable.
  const analysis = baseAnalysis({ currentStage: "Wave 3 Initiation", direction: "Bullish" });
  const signal = evaluateWaveScreener(analysis, /* rsi */ 65, /* rvol */ undefined);

  assert.ok(signal, "strong bullish RSI momentum must be enough to alert when there is no volume data to confirm with");
  assert.equal(signal!.alertType, "WAVE3_IMPULSE");
});

test("evaluateWaveScreener: WAVE3_IMPULSE still requires momentum even with no volume data", () => {
  const analysis = baseAnalysis({ currentStage: "Wave 3 Initiation", direction: "Bullish" });
  const signal = evaluateWaveScreener(analysis, /* rsi */ 50, undefined); // below the 60 bullish threshold
  assert.equal(signal, undefined);
});

test("evaluateWaveScreener: WAVE3_IMPULSE is still blocked when volume IS defined but below threshold", () => {
  // Ensures the fix only bypasses the volume gate when there is genuinely no
  // reading (indices) - a real, weak reading (stocks) must still block.
  const analysis = baseAnalysis({ currentStage: "Wave 3 Initiation", direction: "Bullish" });
  const signal = evaluateWaveScreener(analysis, 65, /* rvol */ 1.2); // below 2.0 threshold
  assert.equal(signal, undefined);
});

test("evaluateWaveScreener: WAVE3_IMPULSE fires for a bearish index move on momentum alone", () => {
  const analysis = baseAnalysis({ currentStage: "Wave 3 Initiation", direction: "Bearish" });
  const signal = evaluateWaveScreener(analysis, /* rsi */ 30, undefined); // below the 40 bearish threshold
  assert.ok(signal);
  assert.equal(signal!.alertType, "WAVE3_IMPULSE");
  assert.equal(signal!.direction, "Bearish");
});

test("evaluateWaveScreener: an invalidated count never screens, regardless of stage", () => {
  const analysis = baseAnalysis({ currentStage: "Wave 3 Initiation", direction: "Bullish", invalidated: true });
  const signal = evaluateWaveScreener(analysis, 65, undefined);
  assert.equal(signal, undefined);
});

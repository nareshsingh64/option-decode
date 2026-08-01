import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpotPricePoint } from "@option-decode/types";
import { calculateElliottWave } from "./elliott-wave.ts";

function series(prices: number[], startTime = "2026-08-01T03:45:00.000Z", stepMs = 60_000): SpotPricePoint[] {
  return prices.map((price, i) => ({ time: new Date(new Date(startTime).getTime() + i * stepMs).toISOString(), price }));
}

// Bullish rally 100 -> 130 (Wave 1), pullback to 113 - a 56.7% retracement of
// Wave 1, squarely in the Wave 2 screener's 50%-61.8% zone - that HASN'T
// reversed back up yet, so it's still the provisional/current leg (no 4th
// point confirming a bounce). This is the exact shape that produced an
// empty fibonacciLevels array in production (SENSEX, COPPER, 2026-08-01)
// before the fix.
const WAVE2_IN_ZONE_PROVISIONAL = series([100, 130, 113]);

test("calculateElliottWave: a still-forming (provisional) Wave 2 gets a live Fibonacci retracement reading", () => {
  const analysis = calculateElliottWave("TEST", WAVE2_IN_ZONE_PROVISIONAL, 1);

  assert.equal(analysis.currentStage, "Wave 2 Turning");
  assert.equal(analysis.direction, "Bullish");
  assert.equal(analysis.invalidated, false);

  const wave2Fib = analysis.fibonacciLevels.find((level) => level.label === "Wave 2 Retracement");
  assert.ok(wave2Fib, "a Wave 2 Retracement level must exist while currentStage is 'Wave 2 Turning'");
  assert.ok(wave2Fib!.actualPercent !== undefined && Math.abs(wave2Fib!.actualPercent - 56.666666) < 0.01);
  assert.equal(wave2Fib!.provisional, true, "a still-forming Wave 2's retracement must be marked provisional");
});

test("calculateElliottWave: once Wave 2 confirms and Wave 3 starts, the retracement is no longer provisional", () => {
  // Same Wave 1/Wave 2 shape as above, but now a 4th point (145) confirms
  // the bounce off 113 (a rise of >1% from the 113 anchor), which reverses
  // the ZigZag trend and turns "2" into a CONFIRMED pivot with "3" as the
  // new provisional leg.
  const points = series([100, 130, 113, 145]);
  const analysis = calculateElliottWave("TEST", points, 1);

  assert.equal(analysis.currentStage, "Wave 3 Initiation");
  const wave2Fib = analysis.fibonacciLevels.find((level) => level.label === "Wave 2 Retracement");
  assert.ok(wave2Fib);
  assert.ok(Math.abs(wave2Fib!.actualPercent! - 56.666666) < 0.01, "the confirmed retracement must match what the provisional reading already showed");
  assert.equal(wave2Fib!.provisional, undefined, "a confirmed Wave 2 retracement must not be marked provisional");
});

test("calculateElliottWave: a provisional Wave 2 that hasn't retraced far enough yet reports a low, non-zone percentage", () => {
  // Pullback to only 124 (20% of the 30-point Wave 1) - nowhere near the
  // 50%-61.8% zone, but the level should still be present and provisional.
  const points = series([100, 130, 124]);
  const analysis = calculateElliottWave("TEST", points, 1);

  assert.equal(analysis.currentStage, "Wave 2 Turning");
  const wave2Fib = analysis.fibonacciLevels.find((level) => level.label === "Wave 2 Retracement");
  assert.ok(wave2Fib);
  assert.ok(Math.abs(wave2Fib!.actualPercent! - 20) < 0.01);
  assert.equal(wave2Fib!.provisional, true);
});

test("calculateElliottWave: a bearish Wave 2 pullback (rally) is also read provisionally", () => {
  // Bearish leg down 200 -> 170 (Wave 1, a drop of 30), bounce to 186.8 -
  // a 56% retracement of that drop (170 + 0.56 * 30).
  const points = series([200, 170, 186.8]);
  const analysis = calculateElliottWave("TEST", points, 1);

  assert.equal(analysis.currentStage, "Wave 2 Turning");
  assert.equal(analysis.direction, "Bearish");
  const wave2Fib = analysis.fibonacciLevels.find((level) => level.label === "Wave 2 Retracement");
  assert.ok(wave2Fib);
  assert.ok(wave2Fib!.actualPercent! >= 50 && wave2Fib!.actualPercent! <= 61.8);
  assert.equal(wave2Fib!.provisional, true);
});

test("calculateElliottWave: no Wave 2 Retracement level at all before Wave 1 even exists", () => {
  const points = series([100, 105]);
  const analysis = calculateElliottWave("TEST", points, 1);
  assert.equal(analysis.fibonacciLevels.find((level) => level.label === "Wave 2 Retracement"), undefined);
});

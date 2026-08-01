// Elliott Wave engine — see "DECODE OPTION & ELLIOTT WAVE KNOWLEDGE FILE"
// (docs/) and the elliott-wave-options-fno-skill skill for the source rules.
// Pure function over a spot-price time series, mirroring strike-matrix.ts's
// shape (compute-on-demand, no new table, no worker job): the caller supplies
// a price series (see @option-decode/db#getSpotPriceHistory, which reads it
// straight off the OptionChainSnapshot table already captured every ~30s -
// no new ingestion pipeline needed) and this module turns it into a wave
// count.
//
// Honest limitation: this labels the most recent alternating swing sequence
// as if it were a fresh 1-2-3-4-5-A-B-C cycle. It does not solve wave-degree
// nesting (is this Wave 3 of a larger Wave 1, etc.) - that's a genuinely
// open-ended problem even for human analysts. Treat `currentStage` as a
// best-effort read of the most recent swing structure, not a certified
// count; the rule checks exist specifically to catch when that best-effort
// read is structurally wrong so the UI can say so instead of presenting a
// confident-looking but broken count.

import type { ElliottWaveAnalysis, ElliottWaveStrategyRecommendation, SpotPricePoint, TradingHorizon, WaveDirection, WaveFibonacciLevel, WaveLabel, WavePivot, WaveRuleCheck, WaveStage } from "@option-decode/types";

// Reversal threshold (percent of price) required to confirm a ZigZag pivot,
// by timeframe - mirrors the Strike Matrix tab's per-horizon profile
// pattern. These are starting heuristics (not backtested against Nifty/Bank
// Nifty history yet): tight enough to catch intraday swings without
// drowning in bid/ask-scale noise, wide enough on weekly/monthly that a
// day's normal chop doesn't fake a reversal. Revisit once the replay/backtest
// tooling can score wave-count accuracy the way it already does for
// recommendations.
export const WAVE_ZIGZAG_PRESETS: Record<TradingHorizon, number> = {
  intraday: 0.3,
  weekly: 1.5,
  monthly: 4
};

const WAVE_LEG_LABELS: WaveLabel[] = ["1", "2", "3", "4", "5", "A", "B", "C"];
// start pivot + up to 8 labeled legs = one full 1-2-3-4-5-A-B-C cycle.
const MAX_WINDOW_SIZE = WAVE_LEG_LABELS.length + 1;

/**
 * Standard ZigZag: walks the series tracking a running extreme in the
 * current direction, and confirms a pivot once price reverses off that
 * extreme by more than `thresholdPercent`. The final entry in the returned
 * array is always PROVISIONAL - it's wherever price currently sits inside
 * the leg that hasn't reversed (and therefore hasn't been confirmed) yet.
 * Callers that need only confirmed structure should drop the last element.
 */
export function detectZigZagPivots(points: SpotPricePoint[], thresholdPercent: number): WavePivot[] {
  if (points.length < 2 || thresholdPercent <= 0) {
    return [];
  }

  const pivots: WavePivot[] = [];
  let trend: "up" | "down" | null = null;
  let anchor = points[0];
  let runningHigh = points[0];
  let runningLow = points[0];

  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    if (point.price > runningHigh.price) runningHigh = point;
    if (point.price < runningLow.price) runningLow = point;

    if (trend === null) {
      const upMovePercent = ((runningHigh.price - points[0].price) / points[0].price) * 100;
      const downMovePercent = ((points[0].price - runningLow.price) / points[0].price) * 100;
      if (upMovePercent >= thresholdPercent && upMovePercent >= downMovePercent) {
        pivots.push({ time: points[0].time, price: points[0].price, kind: "low" });
        trend = "up";
        anchor = runningHigh;
      } else if (downMovePercent >= thresholdPercent) {
        pivots.push({ time: points[0].time, price: points[0].price, kind: "high" });
        trend = "down";
        anchor = runningLow;
      }
      continue;
    }

    if (trend === "up") {
      if (point.price >= anchor.price) {
        anchor = point;
      } else {
        const retracePercent = ((anchor.price - point.price) / anchor.price) * 100;
        if (retracePercent >= thresholdPercent) {
          pivots.push({ time: anchor.time, price: anchor.price, kind: "high" });
          trend = "down";
          anchor = point;
        }
      }
    } else {
      if (point.price <= anchor.price) {
        anchor = point;
      } else {
        const bouncePercent = ((point.price - anchor.price) / anchor.price) * 100;
        if (bouncePercent >= thresholdPercent) {
          pivots.push({ time: anchor.time, price: anchor.price, kind: "low" });
          trend = "up";
          anchor = point;
        }
      }
    }
  }

  // Provisional "so far" point for the leg still in progress - omitted only
  // when the series never broke the threshold even once (trend still null).
  if (trend !== null) {
    pivots.push({ time: anchor.time, price: anchor.price, kind: trend === "up" ? "high" : "low" });
  }

  return pivots;
}

function stageForLabel(label: WaveLabel | undefined): WaveStage {
  switch (label) {
    case "2":
      return "Wave 2 Turning";
    case "3":
      return "Wave 3 Initiation";
    case "4":
      return "Wave 4 Range";
    case "5":
      return "Wave 5 Exhaustion";
    case "A":
    case "B":
    case "C":
      return "Corrective Phase";
    default:
      // "1" (the very first leg) has no entry in the strategy mapping
      // matrix - there's no prior wave to have turned off of yet.
      return "Undetermined";
  }
}

function recommendationForStage(stage: WaveStage, direction: WaveDirection): ElliottWaveStrategyRecommendation | undefined {
  const bullish = direction === "Bullish";
  switch (stage) {
    case "Wave 2 Turning":
      return {
        stage,
        context: "Low-to-high momentum pivot",
        strategy: bullish ? "Bull Put Spread" : "Bear Call Spread",
        primaryGreek: `Collect high IV premium (${bullish ? "+Delta" : "-Delta"})`,
        riskProfile: "Defined Risk"
      };
    case "Wave 3 Initiation":
      return {
        stage,
        context: "Explosive directional extension",
        strategy: bullish ? "Call Debit Spread or Futures Long" : "Put Debit Spread or Futures Short",
        primaryGreek: "Maximize Positive Delta (Δ) & Vega (v) expansion",
        riskProfile: "Defined Risk"
      };
    case "Wave 4 Range":
      return {
        stage,
        context: "Sideways consolidation / IV crush",
        strategy: "Iron Condor / Short Straddle",
        primaryGreek: "Maximize Theta (Θ) time decay",
        riskProfile: "Defined (Condor) / Undefined (Straddle)"
      };
    case "Wave 5 Exhaustion":
      return {
        stage,
        context: "Momentum divergence",
        strategy: "Ratio Spreads / Delta Neutral Hedging",
        primaryGreek: "Neutralize directional exposure (Δ ≈ 0)",
        riskProfile: "Dynamic / Hedged"
      };
    default:
      return undefined;
  }
}

function fibLevel(label: string, actualPercent: number | undefined, targetLow: number, targetHigh: number, hardCap: number, description: string, provisional = false): WaveFibonacciLevel {
  return {
    label,
    actualPercent,
    targetLow,
    targetHigh,
    withinTarget: actualPercent !== undefined && actualPercent <= hardCap,
    description,
    ...(provisional ? { provisional: true } : {})
  };
}

export function calculateElliottWave(underlyingSymbol: string, points: SpotPricePoint[], zigZagPercent: number): ElliottWaveAnalysis {
  const lastPrice = points.length ? points[points.length - 1].price : 0;
  const lastUpdated = points.length ? points[points.length - 1].time : new Date().toISOString();
  const allPivots = detectZigZagPivots(points, zigZagPercent);

  const base: ElliottWaveAnalysis = {
    underlyingSymbol,
    zigZagPercent,
    pivots: [],
    currentStage: "Undetermined",
    direction: "Undetermined",
    invalidated: false,
    ruleChecks: [],
    fibonacciLevels: [],
    lastPrice,
    lastUpdated
  };

  // Need at least a start point plus one confirmed leg (start, wave1,
  // wave2-provisional) before "Wave 2 Turning" - the first stage the
  // strategy matrix covers - can even apply.
  if (allPivots.length < 3) {
    return base;
  }

  const window = allPivots.slice(-MAX_WINDOW_SIZE);
  const labeledWindow: WavePivot[] = window.map((pivot, index) => (index === 0 ? { ...pivot } : { ...pivot, label: WAVE_LEG_LABELS[index - 1] }));

  // The window's last point is provisional (see detectZigZagPivots) - it
  // marks the leg CURRENTLY forming, which is what currentStage describes.
  // Rule/Fibonacci checks below only run against the CONFIRMED legs
  // (everything before it), since an in-progress leg hasn't reversed yet
  // and can't be judged against a rule that depends on where it ends.
  const currentLegLabel = labeledWindow[labeledWindow.length - 1].label;
  const currentStage = stageForLabel(currentLegLabel);
  const direction: WaveDirection = labeledWindow[0].kind === "low" ? "Bullish" : "Bearish";
  const bullish = direction === "Bullish";

  const confirmed = labeledWindow.slice(0, -1);
  const byLabel = new Map<string, WavePivot>();
  byLabel.set("start", confirmed[0]);
  for (const pivot of confirmed.slice(1)) {
    if (pivot.label) byLabel.set(pivot.label, pivot);
  }
  const start = byLabel.get("start");
  const w1 = byLabel.get("1");
  const w2 = byLabel.get("2");
  const w3 = byLabel.get("3");
  const w4 = byLabel.get("4");
  const w5 = byLabel.get("5");
  const wA = byLabel.get("A");
  const wB = byLabel.get("B");
  const wC = byLabel.get("C");

  const ruleChecks: WaveRuleCheck[] = [];
  let invalidationReason: string | undefined;

  // Rule 1 (Wave 2 Floor): Wave 2 can never retrace past the start of Wave 1.
  if (start && w1 && w2) {
    const passed = bullish ? w2.price > start.price : w2.price < start.price;
    ruleChecks.push({
      rule: "Rule 1 - Wave 2 Floor",
      description: "Wave 2 must not retrace beyond the start of Wave 1.",
      passed
    });
    if (!passed) invalidationReason ??= "Wave 2 breached the start of Wave 1 - this count is invalidated.";
  }

  // Rule 2 (Wave 3 Length): Wave 3 is never the shortest of Waves 1, 3, 5.
  if (start && w1 && w2 && w3 && w4 && w5) {
    const len1 = Math.abs(w1.price - start.price);
    const len3 = Math.abs(w3.price - w2.price);
    const len5 = Math.abs(w5.price - w4.price);
    const passed = len3 >= len1 || len3 >= len5;
    ruleChecks.push({
      rule: "Rule 2 - Wave 3 Length",
      description: "Wave 3 must not be the shortest wave among Waves 1, 3, and 5.",
      passed
    });
    if (!passed) invalidationReason ??= "Wave 3 is the shortest of Waves 1/3/5 - this count is invalidated.";
  }

  // Rule 3 (Wave 4 Territory): Wave 4 can never overlap into Wave 1's price range.
  if (start && w1 && w2 && w3 && w4) {
    const passed = bullish ? w4.price > w1.price : w4.price < w1.price;
    ruleChecks.push({
      rule: "Rule 3 - Wave 4 Territory",
      description: "Wave 4 must not overlap into Wave 1's price territory.",
      passed
    });
    if (!passed) invalidationReason ??= "Wave 4 overlapped into Wave 1's territory - this count is invalidated.";
  }

  const fibonacciLevels: WaveFibonacciLevel[] = [];
  if (start && w1 && w2) {
    const len1 = Math.abs(w1.price - start.price);
    const actual = len1 > 0 ? (Math.abs(w1.price - w2.price) / len1) * 100 : undefined;
    fibonacciLevels.push(fibLevel("Wave 2 Retracement", actual, 50, 61.8, 81.2, "Ideally 50%-61.8% of Wave 1; above 81.2% flags a high failure probability."));
  } else if (start && w1 && currentStage === "Wave 2 Turning") {
    // Wave 2 is the CURRENTLY forming (provisional) leg here - w2 is never
    // in `confirmed`/`byLabel` while currentStage is "Wave 2 Turning", by
    // construction (that's exactly the leg the window's last, unconfirmed
    // entry represents). Without this branch, "Wave 2 Retracement" could
    // only ever appear once the count has already moved on to Wave 3 -
    // making the Wave 2 Reversal screener's Fibonacci-zone check
    // unreachable at the one moment it's meant to fire. Reads the
    // provisional leg's running extreme (labeledWindow's last pivot) for a
    // live, still-moving retracement reading instead of waiting for
    // confirmation.
    const provisionalW2 = labeledWindow[labeledWindow.length - 1];
    const len1 = Math.abs(w1.price - start.price);
    const actual = len1 > 0 ? (Math.abs(w1.price - provisionalW2.price) / len1) * 100 : undefined;
    fibonacciLevels.push(
      fibLevel("Wave 2 Retracement", actual, 50, 61.8, 81.2, "Ideally 50%-61.8% of Wave 1; above 81.2% flags a high failure probability. Provisional - Wave 2 has not confirmed/reversed yet.", true)
    );
  }
  if (start && w1 && w2 && w3) {
    const len1 = Math.abs(w1.price - start.price);
    const actual = len1 > 0 ? (Math.abs(w3.price - w2.price) / len1) * 100 : undefined;
    fibonacciLevels.push(fibLevel("Wave 3 Projection", actual, 161.8, 261.8, 261.8, "161.8%-261.8% extension of Wave 1."));
  }
  if (w2 && w3 && w4) {
    const len3 = Math.abs(w3.price - w2.price);
    const actual = len3 > 0 ? (Math.abs(w3.price - w4.price) / len3) * 100 : undefined;
    fibonacciLevels.push(fibLevel("Wave 4 Retracement", actual, 23.6, 38.2, 50, "Shallow correction, typically 23.6%-38.2% of Wave 3."));
  }
  if (w5 && wA && wB && wC) {
    const lenA = Math.abs(wA.price - w5.price);
    const actual = lenA > 0 ? (Math.abs(wC.price - wB.price) / lenA) * 100 : undefined;
    fibonacciLevels.push(fibLevel("Wave C Extension", actual, 100, 161.8, 161.8, "Usually 100%-161.8% the length of Wave A."));
  }

  return {
    underlyingSymbol,
    zigZagPercent,
    pivots: labeledWindow,
    currentStage,
    direction,
    invalidated: invalidationReason !== undefined,
    invalidationReason,
    ruleChecks,
    fibonacciLevels,
    recommendation: invalidationReason ? undefined : recommendationForStage(currentStage, direction),
    lastPrice,
    lastUpdated
  };
}

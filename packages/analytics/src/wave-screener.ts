// Automated Wave Screener (Phase 2 of the Elliott Wave tab) - the "Wave 2
// Reversal Screener" and "Wave 3 Impulse Screener" from the
// elliott-wave-options-fno-skill doc, turned into pure, testable functions
// over an already-computed ElliottWaveAnalysis plus RSI/RVOL. The worker
// calls this once per underlying per scan cycle; a returned signal becomes a
// WaveScreenerAlert row (see @option-decode/db#recordWaveAlertIfNew).

import type { ElliottWaveAnalysis, SpotPricePoint, WaveScreenerSignal } from "@option-decode/types";

/**
 * Wilder's RSI over a closing-price series. Needs at least `period + 1`
 * prices; returns undefined otherwise (not enough history yet, e.g. right
 * after a symbol is newly added to the universe).
 */
export function calculateRsi(prices: number[], period = 14): number | undefined {
  if (prices.length < period + 1) {
    return undefined;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    // Wilder's smoothing, not a simple moving average.
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Constructed ONCE. This formatter used to be built inside istDateKey, so a
// new one was allocated on every call - and calculateRvol calls it twice per
// price point, which across the screener's ~216 symbols x ~740 points came to
// ~318,000 constructions per scan.
//
// That single line was the worker's memory spike. Intl.DateTimeFormat is
// backed by ICU, which allocates in C++ - invisible to process.memoryUsage(),
// which is why every earlier hunt looked at the V8 heap (flat at ~60MB) and
// at Prisma, and found nothing. Measured in isolation at the real call count,
// same loop otherwise: reused formatter peaks at 77MB, per-call construction
// at 4,278MB. On production the same change is worth the ~976MB that a
// controlled A/B (2026-08-19) attributed to "the analytics" over identical
// queries and identical row counts.
//
// A DateTimeFormat is stateless for formatting, so hoisting is safe and the
// options here never vary. Never construct one inside a per-row loop.
const IST_DATE_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

function istDateKey(iso: string): string {
  return IST_DATE_KEY_FORMAT.format(new Date(iso));
}

/**
 * Relative Volume: the most recent interval's traded-volume delta versus
 * the average of prior same-window deltas. `points` carry Dhan's CUMULATIVE
 * day volume at each sample, so this diffs consecutive samples itself -
 * skipping any pair that crosses a trading-day boundary (cumulative volume
 * resets at each new session, so that "delta" would be a false negative/
 * huge-negative artifact, not a real reading). Returns undefined when
 * there's no volume data at all (indices) or not enough same-day history to
 * form a baseline yet.
 */
export function calculateRvol(points: SpotPricePoint[], baselineWindow = 20): number | undefined {
  const withVolume = points.filter((point): point is SpotPricePoint & { volume: number } => point.volume !== undefined);
  if (withVolume.length < 3) {
    return undefined;
  }

  const deltas: number[] = [];
  // Each sample's date key is computed once and carried into the next
  // iteration as the previous one, rather than formatting both ends of every
  // pair - half the work for the same answer.
  let previousKey = istDateKey(withVolume[0].time);
  for (let i = 1; i < withVolume.length; i++) {
    const previous = withVolume[i - 1];
    const current = withVolume[i];
    const currentKey = istDateKey(current.time);
    const sameSession = currentKey === previousKey;
    previousKey = currentKey;
    if (!sameSession) {
      continue;
    }
    const delta = current.volume - previous.volume;
    if (delta >= 0) {
      deltas.push(delta);
    }
  }

  if (deltas.length < 2) {
    return undefined;
  }

  const latest = deltas[deltas.length - 1];
  const baseline = deltas.slice(0, -1).slice(-baselineWindow);
  if (!baseline.length) {
    return undefined;
  }
  const averageBaseline = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
  return averageBaseline > 0 ? latest / averageBaseline : undefined;
}

// Fibonacci hard-invalidation ceiling for Wave 2 (see elliott-wave.ts) -
// reused here as the screener's own zone check rather than importing a
// magic number twice.
const WAVE2_ZONE_LOW = 50;
const WAVE2_ZONE_HIGH = 61.8;
const WAVE3_RVOL_THRESHOLD = 2.0;
const WAVE3_RSI_BULLISH_THRESHOLD = 60;
const WAVE3_RSI_BEARISH_THRESHOLD = 40;
// "Declining volume" (doc: Wave 2 Reversal Screener) as an RVOL proxy: a
// pullback trading at or below average activity. When there's no volume
// data at all (indices), this condition is treated as satisfied rather than
// blocking the alert - see calculateRvol's doc comment on why indices never
// produce an RVOL reading.
const WAVE2_DECLINING_VOLUME_RVOL_CEILING = 1.0;

/**
 * Evaluates the two screener conditions against an already-computed wave
 * count. Returns at most one signal per call (an underlying can't be in two
 * stages at once). A structurally invalidated count never screens - see
 * elliott-wave.ts's Rule 1/2/3 checks.
 */
export function evaluateWaveScreener(analysis: ElliottWaveAnalysis, rsi: number | undefined, rvol: number | undefined): WaveScreenerSignal | undefined {
  if (analysis.invalidated) {
    return undefined;
  }
  const bullish = analysis.direction === "Bullish";

  if (analysis.currentStage === "Wave 2 Turning") {
    const wave2Fib = analysis.fibonacciLevels.find((level) => level.label === "Wave 2 Retracement");
    const inZone = wave2Fib?.actualPercent !== undefined && wave2Fib.actualPercent >= WAVE2_ZONE_LOW && wave2Fib.actualPercent <= WAVE2_ZONE_HIGH;
    const decliningVolume = rvol === undefined || rvol < WAVE2_DECLINING_VOLUME_RVOL_CEILING;
    if (inZone && decliningVolume) {
      return {
        alertType: "WAVE2_REVERSAL",
        stage: analysis.currentStage,
        direction: analysis.direction,
        message: `${analysis.underlyingSymbol}: Wave 2 pulled back into the ${wave2Fib!.actualPercent!.toFixed(1)}% Fibonacci zone${rvol !== undefined ? ` on below-average volume (RVOL ${rvol.toFixed(2)}x)` : ""} - potential ${bullish ? "Bull Put Spread" : "Bear Call Spread"} entry as Wave 3 sets up.`,
        triggeredPrice: analysis.lastPrice,
        fibRetracementPercent: wave2Fib!.actualPercent,
        rvol,
        rsi
      };
    }
    return undefined;
  }

  if (analysis.currentStage === "Wave 3 Initiation") {
    // Indices/commodities never produce an RVOL reading at all (no volume
    // data - see calculateRvol's doc comment), so requiring rvol > threshold
    // outright made WAVE3_IMPULSE structurally unreachable for every index
    // underlying, no matter how strong the actual breakout - confirmed on
    // live data (2026-08-01): BANKNIFTY sat in a valid, non-invalidated
    // "Wave 3 Initiation" and still couldn't alert. Treating a missing
    // reading as non-blocking (same "undefined doesn't block" convention
    // already used for Wave 2's decliningVolume above) means indices screen
    // on momentum (RSI) alone, same asymmetry already accepted there.
    const strongVolume = rvol === undefined || rvol > WAVE3_RVOL_THRESHOLD;
    const momentumConfirmed = rsi !== undefined && (bullish ? rsi > WAVE3_RSI_BULLISH_THRESHOLD : rsi < WAVE3_RSI_BEARISH_THRESHOLD);
    if (strongVolume && momentumConfirmed) {
      return {
        alertType: "WAVE3_IMPULSE",
        stage: analysis.currentStage,
        direction: analysis.direction,
        message: `${analysis.underlyingSymbol}: Wave 3 breakout confirmed - ${rvol !== undefined ? `RVOL ${rvol.toFixed(2)}x with ` : ""}RSI ${rsi!.toFixed(0)}, signaling an explosive ${bullish ? "upside" : "downside"} extension.`,
        triggeredPrice: analysis.lastPrice,
        rvol,
        rsi
      };
    }
    return undefined;
  }

  return undefined;
}

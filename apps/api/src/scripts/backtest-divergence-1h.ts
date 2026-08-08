/**
 * Backtest: RSI regular-divergence signals on synthesized 1-hour candles,
 * against the rule set in docs/divergence-trading-strategy.md section 2.
 *
 * That plan has FIVE items still explicitly marked "not yet decided"
 * (universe, entry timing, stop buffer, target rule, candle data source -
 * see its "Open questions before building" list). A backtest can't run
 * without picking something for each, so this script makes one concrete,
 * loudly-flagged choice per open question rather than waiting for all five
 * to be resolved first:
 *
 *   - Candle source: resampled from WavePricePoint (path 2 in the plan's
 *     "Data & infrastructure gap" section - no Dhan historical-candle
 *     integration exists yet, this is the only data available today).
 *   - Candles are session-anchored hourly buckets: 09:15-10:15, 10:15-11:15,
 *     11:15-12:15, 12:15-13:15, 13:15-14:15, 14:15-15:15, 15:15-15:30
 *     (7th bucket is a 15-minute partial). Open/close are the first/last
 *     tick in the bucket; high/low are the min/max tick seen - NOT true
 *     intrabar extremes, since capture is only 1 tick/minute.
 *   - Universe: BOTH the index-weight-threshold subset
 *     (getOptionChainTrackedStocks) and every symbol with WavePricePoint
 *     history are run and reported separately, since which one the plan
 *     ends up choosing is itself still open.
 *   - Entry: on confirmation (the earliest candle where a pivot leaves the
 *     ZigZag's provisional slot), entering at that candle's close. Computed
 *     via a genuine walk-forward replay (pivots recomputed on every prefix
 *     of the series) specifically so a signal can never see data from its
 *     own future - not just the whole-series-then-drop-the-last-pivot
 *     shortcut, which would let a later reversal leak into which candle
 *     "confirmed" a pivot.
 *   - Stop-loss: beyond the H2/L2 pivot, buffered by 0.25x ATR(14) on the
 *     hourly series (the plan's own 0.2-0.3x range, midpoint chosen).
 *   - Target: fixed R-multiple, default 2R (mid of the plan's 1.5R/2R
 *     candidates), overridable via CLI arg.
 *
 * Everything above is a backtest-only default to make a number possible,
 * not a decision the plan doc itself has made. Reused from real production
 * code rather than reimplemented: detectZigZagPivots
 * (@option-decode/analytics/elliott-wave), calculateRsi
 * (@option-decode/analytics/wave-screener), same as any other backtest in
 * this directory - so results can't drift from what the live detector would
 * have said, once one exists.
 *
 * Read-only. Does not persist anything (BacktestRun in the schema is dead,
 * unused code - not touched by this script).
 *
 * Usage:
 *   pnpm --filter @option-decode/api exec tsx src/scripts/backtest-divergence-1h.ts [RSI_PERIOD] [ZIGZAG_PCT] [R_MULTIPLE]
 * Defaults: RSI period 14, ZigZag 1.5% (WAVE_ZIGZAG_PRESETS.weekly), target 2R.
 */
import { prisma } from "@option-decode/db";
import { calculateRsi, detectZigZagPivots, WAVE_ZIGZAG_PRESETS } from "@option-decode/analytics";
import type { SpotPricePoint } from "@option-decode/types";

const RSI_PERIOD = process.argv[2] ? Number(process.argv[2]) : 14;
const ZIGZAG_PCT = process.argv[3] ? Number(process.argv[3]) : WAVE_ZIGZAG_PRESETS.weekly;
const R_MULTIPLE = process.argv[4] ? Number(process.argv[4]) : 2;
// MODE lets one run cover just the weighted subset, just a slice of the
// full universe, or (default) both in one process. Slicing exists because
// running all ~209 symbols in a single long-lived process against this
// production host's Prisma/mariadb driver adapter was observed to grow
// resident memory into the gigabytes over the course of the run and get
// OOM-killed by the kernel (host is a memory-tight 3.8GB box already
// running api/worker/web) - root cause not isolated, but per-process
// memory is fully released back to the OS on exit, so running the full
// universe as several small batches (separate process invocations) sidesteps
// it without needing to find the actual leak first.
const MODE = (process.argv[5] as "both" | "weighted" | "full" | undefined) ?? "both";
const BATCH_START = process.argv[6] ? Number(process.argv[6]) : 0;
const BATCH_SIZE = process.argv[7] ? Number(process.argv[7]) : Infinity;
const STOP_ATR_MULTIPLE = 0.25;
const ATR_PERIOD = 14;
const CUMULATIVE_WEIGHT_THRESHOLD = 70;
const MAX_WEIGHTED_STOCKS = 50;

interface Candle {
  time: string; // bucket start, ISO
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Signal {
  symbol: string;
  direction: "short" | "long";
  entryTime: string;
  entryPrice: number;
  stop: number;
  target: number;
  pivot1: { time: string; price: number; rsi: number };
  pivot2: { time: string; price: number; rsi: number };
}

type TradeOutcome = "target" | "stop" | "open-at-data-end";

interface ScoredSignal extends Signal {
  outcome: TradeOutcome;
  exitTime: string;
  exitPrice: number;
  rMultipleAchieved: number;
}

// --- Session-anchored hourly bucketing --------------------------------------
// NSE cash/F&O session is 09:15-15:30 IST (isMarketSessionOpen in
// @option-decode/utils). Buckets anchor to session open, not the wall clock,
// so the first bucket is a full hour (09:15-10:15) rather than a 45-minute
// stub - the convention most NSE charting tools use for "1-hour candles".
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;

function istMinutesSinceMidnight(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function istDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

/** Bucket index within the session, or undefined if outside 09:15-15:30 IST. */
function sessionBucketIndex(date: Date): number | undefined {
  const minutes = istMinutesSinceMidnight(date);
  if (minutes < SESSION_OPEN_MINUTES || minutes > SESSION_CLOSE_MINUTES) return undefined;
  return Math.floor((minutes - SESSION_OPEN_MINUTES) / 60);
}

function resampleToHourlyCandles(ticks: { time: Date; price: number }[]): Candle[] {
  const buckets = new Map<string, { time: Date; price: number }[]>();

  for (const tick of ticks) {
    const bucketIdx = sessionBucketIndex(tick.time);
    if (bucketIdx === undefined) continue;
    const key = `${istDateKey(tick.time)}#${bucketIdx}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(tick);
  }

  const candles: Candle[] = [];
  for (const [, points] of buckets) {
    points.sort((a, b) => a.time.getTime() - b.time.getTime());
    const prices = points.map((p) => p.price);
    candles.push({
      time: points[0].time.toISOString(),
      open: prices[0],
      close: prices[prices.length - 1],
      high: Math.max(...prices),
      low: Math.min(...prices)
    });
  }
  candles.sort((a, b) => a.time.localeCompare(b.time));
  return candles;
}

function wilderAtr(candles: Candle[], period: number): (number | undefined)[] {
  const trueRanges: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trueRanges.push(candles[i].high - candles[i].low);
      continue;
    }
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - prevClose), Math.abs(candles[i].low - prevClose)));
  }

  const atr: (number | undefined)[] = new Array(candles.length).fill(undefined);
  if (trueRanges.length < period) return atr;

  let running = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atr[period - 1] = running;
  for (let i = period; i < trueRanges.length; i++) {
    running = (running * (period - 1) + trueRanges[i]) / period;
    atr[i] = running;
  }
  return atr;
}

// --- Walk-forward divergence detection --------------------------------------
// Recomputes ZigZag pivots on every prefix of the candle series so a pivot
// only counts as "confirmed" the instant it would have been confirmed live -
// never earlier. This is what makes "entry on confirmation" meaningful
// rather than an artifact of looking at the whole series at once.
function findSignals(symbol: string, candles: Candle[]): Signal[] {
  const closes = candles.map((c) => c.close);
  const spotPoints: SpotPricePoint[] = candles.map((c) => ({ time: c.time, price: c.close }));
  const atrSeries = wilderAtr(candles, ATR_PERIOD);
  const signals: Signal[] = [];

  let lastConfirmedCount = 0;
  // Most recent confirmed pivot of each kind, for pairing H1/H2 or L1/L2.
  let lastHigh: { time: string; price: number; index: number } | undefined;
  let lastLow: { time: string; price: number; index: number } | undefined;

  for (let t = 1; t < candles.length; t++) {
    const pivots = detectZigZagPivots(spotPoints.slice(0, t + 1), ZIGZAG_PCT);
    const confirmed = pivots.slice(0, -1); // drop the always-provisional last entry
    if (confirmed.length <= lastConfirmedCount) continue;
    lastConfirmedCount = confirmed.length;

    const newPivot = confirmed[confirmed.length - 1];
    const pivotIndex = closes.findIndex((_, i) => candles[i].time === newPivot.time);
    if (pivotIndex === -1) continue;
    const rsiSeries = calculateRsi(closes.slice(0, pivotIndex + 1), RSI_PERIOD);
    if (rsiSeries === undefined) {
      if (newPivot.kind === "high") lastHigh = { time: newPivot.time, price: newPivot.price, index: pivotIndex };
      else lastLow = { time: newPivot.time, price: newPivot.price, index: pivotIndex };
      continue;
    }

    const entryIndex = t; // candle at which this pivot left the provisional slot
    const entryPrice = candles[entryIndex].close;
    const atr = atrSeries[entryIndex];

    if (newPivot.kind === "high" && lastHigh) {
      const h1 = lastHigh;
      const h2 = { time: newPivot.time, price: newPivot.price, index: pivotIndex };
      const rsiH1 = calculateRsi(closes.slice(0, h1.index + 1), RSI_PERIOD);
      if (rsiH1 !== undefined && h2.price > h1.price && rsiSeries < rsiH1 && atr !== undefined) {
        const stop = h2.price + STOP_ATR_MULTIPLE * atr;
        const risk = stop - entryPrice;
        if (risk > 0) {
          signals.push({
            symbol,
            direction: "short",
            entryTime: candles[entryIndex].time,
            entryPrice,
            stop,
            target: entryPrice - R_MULTIPLE * risk,
            pivot1: { time: h1.time, price: h1.price, rsi: rsiH1 },
            pivot2: { time: h2.time, price: h2.price, rsi: rsiSeries }
          });
        }
      }
    } else if (newPivot.kind === "low" && lastLow) {
      const l1 = lastLow;
      const l2 = { time: newPivot.time, price: newPivot.price, index: pivotIndex };
      const rsiL1 = calculateRsi(closes.slice(0, l1.index + 1), RSI_PERIOD);
      if (rsiL1 !== undefined && l2.price < l1.price && rsiSeries > rsiL1 && atr !== undefined) {
        const stop = l2.price - STOP_ATR_MULTIPLE * atr;
        const risk = entryPrice - stop;
        if (risk > 0) {
          signals.push({
            symbol,
            direction: "long",
            entryTime: candles[entryIndex].time,
            entryPrice,
            stop,
            target: entryPrice + R_MULTIPLE * risk,
            pivot1: { time: l1.time, price: l1.price, rsi: rsiL1 },
            pivot2: { time: l2.time, price: l2.price, rsi: rsiSeries }
          });
        }
      }
    }

    if (newPivot.kind === "high") lastHigh = { time: newPivot.time, price: newPivot.price, index: pivotIndex };
    else lastLow = { time: newPivot.time, price: newPivot.price, index: pivotIndex };
  }

  return signals;
}

// First candle strictly after the signal's entry candle decides the trade:
// walk forward bar by bar, stop wins ties (conservative - a bar that touches
// both stop and target in one hour is scored as the loss, not the win).
function scoreSignal(signal: Signal, candles: Candle[]): ScoredSignal {
  const entryIdx = candles.findIndex((c) => c.time === signal.entryTime);
  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    if (signal.direction === "short") {
      const hitStop = c.high >= signal.stop;
      const hitTarget = c.low <= signal.target;
      if (hitStop && hitTarget) return { ...signal, outcome: "stop", exitTime: c.time, exitPrice: signal.stop, rMultipleAchieved: -1 };
      if (hitStop) return { ...signal, outcome: "stop", exitTime: c.time, exitPrice: signal.stop, rMultipleAchieved: -1 };
      if (hitTarget) return { ...signal, outcome: "target", exitTime: c.time, exitPrice: signal.target, rMultipleAchieved: R_MULTIPLE };
    } else {
      const hitStop = c.low <= signal.stop;
      const hitTarget = c.high >= signal.target;
      if (hitStop && hitTarget) return { ...signal, outcome: "stop", exitTime: c.time, exitPrice: signal.stop, rMultipleAchieved: -1 };
      if (hitStop) return { ...signal, outcome: "stop", exitTime: c.time, exitPrice: signal.stop, rMultipleAchieved: -1 };
      if (hitTarget) return { ...signal, outcome: "target", exitTime: c.time, exitPrice: signal.target, rMultipleAchieved: R_MULTIPLE };
    }
  }
  const last = candles[candles.length - 1];
  const openR =
    signal.direction === "short"
      ? (signal.entryPrice - last.close) / (signal.stop - signal.entryPrice)
      : (last.close - signal.entryPrice) / (signal.entryPrice - signal.stop);
  return { ...signal, outcome: "open-at-data-end", exitTime: last.time, exitPrice: last.close, rMultipleAchieved: openR };
}

// Queried one symbol at a time rather than one findMany across the whole
// universe. The production host runs api/worker/web on a memory-tight 3.8GB
// box (confirmed by an OOM kill during development of this script - see the
// backtest report) with little headroom for an ad-hoc script to bulk-load
// ~690k rows at once. Per-symbol batches cap this script's own footprint to
// one symbol's ticks (a few thousand rows) at a time.
async function loadTicksForSymbol(symbol: string): Promise<{ time: Date; price: number }[]> {
  const rows = await prisma.wavePricePoint.findMany({
    where: { underlyingSymbol: symbol },
    orderBy: { time: "asc" },
    select: { time: true, price: true }
  });
  return rows.map((row) => ({ time: row.time, price: row.price.toNumber() }));
}

interface UniverseResult {
  label: string;
  symbolCount: number;
  candleCount: number;
  signals: ScoredSignal[];
}

async function runUniverse(label: string, symbols: string[]): Promise<UniverseResult> {
  const allSignals: ScoredSignal[] = [];
  let totalCandles = 0;

  for (const symbol of symbols) {
    const ticks = await loadTicksForSymbol(symbol);
    if (ticks.length === 0) continue;
    const candles = resampleToHourlyCandles(ticks);
    totalCandles += candles.length;
    const signals = findSignals(symbol, candles);
    for (const signal of signals) {
      allSignals.push(scoreSignal(signal, candles));
    }
  }

  return { label, symbolCount: symbols.length, candleCount: totalCandles, signals: allSignals };
}

function printReport(result: UniverseResult) {
  console.log(`\n=== ${result.label} ===`);
  console.log(`Symbols: ${result.symbolCount}, hourly candles built: ${result.candleCount}, signals fired: ${result.signals.length}`);

  if (result.signals.length === 0) {
    console.log("No divergence signals fired in this universe over the available window.");
    return;
  }

  const wins = result.signals.filter((s) => s.outcome === "target").length;
  const losses = result.signals.filter((s) => s.outcome === "stop").length;
  const open = result.signals.filter((s) => s.outcome === "open-at-data-end").length;
  const decisive = wins + losses;
  const winRate = decisive > 0 ? ((wins / decisive) * 100).toFixed(0) : "n/a";
  const closedR = result.signals.filter((s) => s.outcome !== "open-at-data-end").reduce((sum, s) => sum + s.rMultipleAchieved, 0);
  const expectancyR = decisive > 0 ? (closedR / decisive).toFixed(2) : "n/a";

  console.log(`Target hit: ${wins}, Stop hit: ${losses}, Still open at end of data: ${open}`);
  console.log(`Win rate (target vs stop, excludes still-open): ${winRate}%`);
  console.log(`Expectancy per closed trade: ${expectancyR}R  (target fixed at +${R_MULTIPLE}R, stop always -1R by construction)`);

  console.log("\nsymbol".padEnd(14) + "dir".padEnd(7) + "entryTime".padEnd(22) + "entry".padEnd(10) + "stop".padEnd(10) + "target".padEnd(10) + "outcome".padEnd(10) + "R");
  console.log("-".repeat(100));
  for (const s of result.signals.sort((a, b) => a.entryTime.localeCompare(b.entryTime))) {
    console.log(
      s.symbol.padEnd(14) +
        s.direction.padEnd(7) +
        s.entryTime.padEnd(22) +
        s.entryPrice.toFixed(2).padEnd(10) +
        s.stop.toFixed(2).padEnd(10) +
        s.target.toFixed(2).padEnd(10) +
        s.outcome.padEnd(10) +
        s.rMultipleAchieved.toFixed(2)
    );
  }

  // Full pivot detail per signal - printed separately from the summary table
  // above (verification needs the two pivots the divergence was measured
  // between, not just the entry candle) so results can be checked against a
  // real chart: exact IST wall-clock time, price, and RSI at each pivot.
  console.log("\n--- Signal detail, for manual verification against a chart ---");
  for (const s of result.signals.sort((a, b) => a.entryTime.localeCompare(b.entryTime))) {
    const pivotLabel = s.direction === "short" ? "H" : "L";
    console.log(`\n${s.symbol} (${s.direction}):`);
    console.log(`  ${pivotLabel}1: ${istLabel(s.pivot1.time)}  price=${s.pivot1.price.toFixed(2)}  RSI=${s.pivot1.rsi.toFixed(1)}`);
    console.log(`  ${pivotLabel}2: ${istLabel(s.pivot2.time)}  price=${s.pivot2.price.toFixed(2)}  RSI=${s.pivot2.rsi.toFixed(1)}`);
    console.log(`  Entry (on confirmation): ${istLabel(s.entryTime)}  close=${s.entryPrice.toFixed(2)}`);
    console.log(`  Exit: ${istLabel(s.exitTime)}  price=${s.exitPrice.toFixed(2)}  outcome=${s.outcome}`);
  }
}

function istLabel(isoUtc: string): string {
  const date = new Date(isoUtc);
  const ist = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .format(date)
    .replace(",", "");
  return `${ist} IST  (${isoUtc} UTC)`;
}

async function main() {
  console.log(`Divergence backtest - RSI period ${RSI_PERIOD}, ZigZag ${ZIGZAG_PCT}%, target ${R_MULTIPLE}R, stop buffer ${STOP_ATR_MULTIPLE}x ATR(${ATR_PERIOD}).`);
  console.log("Candles: synthesized from WavePricePoint 1-min ticks (no real OHLC exists - see plan doc's 'Data & infrastructure gap').\n");

  if (MODE === "both" || MODE === "weighted") {
    const weighted = await prisma.fnoStock.findMany({
      where: { active: true, securityId: { not: null }, indexWeightPercent: { not: null } },
      orderBy: { indexWeightPercent: "desc" },
      take: MAX_WEIGHTED_STOCKS,
      select: { symbol: true, indexWeightPercent: true }
    });
    const weightedSymbols: string[] = [];
    let cumulative = 0;
    for (const stock of weighted) {
      if (cumulative >= CUMULATIVE_WEIGHT_THRESHOLD) break;
      weightedSymbols.push(stock.symbol);
      cumulative += stock.indexWeightPercent?.toNumber() ?? 0;
    }
    const weightedResult = await runUniverse(`Weighted subset (index weight -> ${CUMULATIVE_WEIGHT_THRESHOLD}% cumulative, ${weightedSymbols.length} stocks)`, weightedSymbols);
    printReport(weightedResult);
  }

  if (MODE === "both" || MODE === "full") {
    const allWithData = await prisma.wavePricePoint.findMany({
      distinct: ["underlyingSymbol"],
      select: { underlyingSymbol: true }
    });
    const allSymbols = allWithData.map((r) => r.underlyingSymbol).sort();
    const batch = allSymbols.slice(BATCH_START, BATCH_START + BATCH_SIZE);

    const fullResult = await runUniverse(
      `Full universe with captured data (${allSymbols.length} symbols total, this run: [${BATCH_START}, ${BATCH_START + batch.length}))`,
      batch
    );
    printReport(fullResult);
  }

  console.log("\n--- Caveats (read before trusting any number above) ---");
  console.log("- Data window is ~9 trading days. That is not a statistically reliable sample for a strategy that needs");
  console.log("  at least 2 confirmed same-direction pivots before it can even fire once. Treat every number above as");
  console.log("  directional, not conclusive - this project's own standing rule against over-claiming from a short window applies here.");
  console.log("- Candles are resampled from 1-minute LTP ticks, not real exchange OHLC - high/low are approximate.");
  console.log("- Entry timing, stop buffer, and target rule are all still open questions in the plan doc; this run picked");
  console.log("  one concrete default for each so a number could be produced. A different choice would score differently.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

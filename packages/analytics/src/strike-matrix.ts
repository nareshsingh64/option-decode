// Strike Matrix engine — the "Strikes Movement Design and Decision Matrix"
// framework (see docs/New Dashboard ver 1.0). Anchors option-writing
// decisions to live chain dynamics instead of fixed strike offsets:
//
//   WCI(i)  = OIC(i) / Volume(i)      — writing conviction (institutional vs
//                                       retail churn) at a strike
//   DRC(i)  = OIC(i) × Delta(i)       — signed directional risk being added
//                                       or removed at a strike
//   DRCR    = Σ|DRC| puts / Σ|DRC| calls — net market bias of writer flow
//
// The three horizon profiles (delta band, WCI threshold, target delta,
// decision matrix, mandatory risk rule) mirror the Unified Analyst's
// Decision Matrix exactly; changing a number here changes what the Strike
// Matrix tab recommends, so keep them in sync with the doc.

import type {
  OptionChainSnapshot,
  OptionContractTick,
  StrikeMatrixAnalysis,
  StrikeMatrixBias,
  StrikeMatrixRecommendation,
  StrikeMatrixRow,
  StrikeMatrixWall,
  TradingHorizon
} from "@option-decode/types";

interface HorizonProfile {
  deltaMin: number;
  deltaMax: number;
  wciThreshold: number;
  targetDelta: number;
  riskRule: string;
  matrix: Record<Exclude<StrikeMatrixBias, "Transitional">, { structure: string; targetDelta: number; note: string; writesCall: boolean; writesPut: boolean }>;
}

const THEORETICAL_POP = 85;

// Liquidity floor for the EXECUTION strike a recommendation actually names
// (not for the WCI/DRC/DRCR universe itself, which needs the full delta
// band to read aggregate flow correctly). Without this, closestToTargetDelta
// could and did name a strike with zero open interest and zero volume next
// to a stamped "~85% POP" - confirmed live on BANKNIFTY, reproduced at three
// consecutive snapshots. Matches Sim's own MIN_OPEN_INTEREST liquidity gate
// (packages/db/src/sim-repository.ts) for consistency across the app.
const MIN_RECOMMENDATION_OPEN_INTEREST = 500;

export const STRIKE_MATRIX_HORIZONS: Record<TradingHorizon, HorizonProfile> = {
  intraday: {
    deltaMin: 0.15,
    deltaMax: 0.25,
    wciThreshold: 0.1,
    targetDelta: 0.18,
    riskRule: "2x Delta hard stop: if a short strike's |delta| doubles from entry, close or roll immediately. Never hold a breached intraday short overnight.",
    matrix: {
      Bullish: { structure: "Sell naked puts / put credit spreads", targetDelta: 0.18, note: "Tactical intraday support play.", writesCall: false, writesPut: true },
      Neutral: { structure: "Sell short strangle", targetDelta: 0.15, note: "Harvest fast intraday decay on both sides.", writesCall: true, writesPut: true },
      Bearish: { structure: "Sell naked calls / call credit spreads", targetDelta: 0.18, note: "Tactical intraday resistance play.", writesCall: true, writesPut: false }
    }
  },
  weekly: {
    deltaMin: 0.12,
    deltaMax: 0.2,
    wciThreshold: 0.2,
    targetDelta: 0.15,
    riskRule: "Weekend Decay window: deploy weekly positions only Friday afternoon or Monday morning to capture weekend theta without uncompensated gap risk.",
    matrix: {
      Bullish: { structure: "Sell bull put spreads", targetDelta: 0.15, note: "Leverage weekly institutional floors.", writesCall: false, writesPut: true },
      Neutral: { structure: "Sell iron condors / strangles", targetDelta: 0.12, note: "Capture weekly range-bound decay.", writesCall: true, writesPut: true },
      Bearish: { structure: "Sell bear call spreads", targetDelta: 0.15, note: "Capitalize on fading weekly momentum.", writesCall: true, writesPut: false }
    }
  },
  monthly: {
    deltaMin: 0.08,
    deltaMax: 0.15,
    wciThreshold: 0.2,
    targetDelta: 0.1,
    riskRule: "IV Rank gatekeeper: never sell monthly contracts while the underlying's IV Rank is below 30% — the premium collected won't compensate the vega risk.",
    matrix: {
      Bullish: { structure: "Sell naked puts / wide put spreads", targetDelta: 0.1, note: "Establish macro margin-of-safety floor.", writesCall: false, writesPut: true },
      Neutral: { structure: "Sell wide iron condors", targetDelta: 0.1, note: "Maximize probability of profit.", writesCall: true, writesPut: true },
      Bearish: { structure: "Sell conservative call spreads", targetDelta: 0.1, note: "Structural long-term systemic ceiling.", writesCall: true, writesPut: false }
    }
  }
};

export function isTradingHorizon(value: string | undefined): value is TradingHorizon {
  return value === "intraday" || value === "weekly" || value === "monthly";
}

function classifyDrcr(drcr: number | undefined): StrikeMatrixBias {
  if (drcr === undefined) {
    return "Transitional";
  }
  if (drcr > 1.5) {
    return "Bullish";
  }
  if (drcr < 0.6) {
    return "Bearish";
  }
  if (drcr >= 0.8 && drcr <= 1.2) {
    return "Neutral";
  }
  // 0.6–0.8 and 1.2–1.5 sit between the matrix's defined bands — surfaced
  // as Transitional rather than rounded into a tradable bias.
  return "Transitional";
}

function buildRow(tick: OptionContractTick): StrikeMatrixRow | null {
  if (tick.delta === undefined) {
    return null;
  }
  const volume = tick.volume ?? 0;
  const oiChange = tick.changeInOpenInterest ?? 0;
  return {
    optionType: tick.optionType,
    strikePrice: tick.strikePrice,
    lastPrice: tick.lastPrice,
    delta: tick.delta,
    volume,
    oiChange,
    openInterest: tick.openInterest ?? 0,
    // WCI is a pure ratio, so lot-size scaling cancels; guarded because a
    // zero-volume strike has no conviction reading, not an infinite one.
    wci: volume > 0 ? oiChange / volume : undefined,
    drc: oiChange * tick.delta
  };
}

function findWall(rows: StrikeMatrixRow[], optionType: "CE" | "PE", wciThreshold: number): StrikeMatrixWall | undefined {
  const candidates = rows.filter((row): row is StrikeMatrixRow & { wci: number } => row.optionType === optionType && row.wci !== undefined);
  if (!candidates.length) {
    return undefined;
  }

  // Prefer a strike that actually clears the conviction bar over one with a
  // larger raw magnitude that doesn't - previously the single highest-|WCI|
  // strike won outright regardless of sign, so a strongly negative
  // (unwinding) strike could bury a genuinely qualifying wall elsewhere on
  // the same side (confirmed live, BANKNIFTY: a reported -0.527 WCI wall
  // masked a real +0.323 WCI wall on 6.6x the volume, 500 points away).
  // Threshold itself uses the raw (signed) WCI: negative WCI means
  // positions are being unwound, which is never institutional backing.
  const qualifying = candidates.filter((row) => row.wci > wciThreshold);
  const pool = qualifying.length ? qualifying : candidates;

  let best = pool[0];
  for (const row of pool) {
    const better = qualifying.length ? row.wci > best.wci : Math.abs(row.wci) > Math.abs(best.wci);
    if (better) {
      best = row;
    }
  }

  return {
    optionType,
    strikePrice: best.strikePrice,
    wci: best.wci,
    meetsThreshold: best.wci > wciThreshold,
    delta: best.delta,
    oiChange: best.oiChange,
    volume: best.volume
  };
}

// WCI's typical magnitude varies enormously by how much day-volume a
// contract attracts relative to its OI change - not by how much genuine
// institutional conviction is behind a given strike. A front-week index
// contract can see far more day-trading volume relative to its OI change
// than a back-week/monthly contract, structurally pinning every strike's
// WCI lower - confirmed live against real NIFTY production data (same
// underlying, same instants, 2026-07-31): the front-week chain's
// aggregate turnover ratio (see chainWciBaseline below) ran 0.03-0.13
// across the day while the back-week chain's ran a tight 0.11-0.14 at the
// SAME moments, purely a function of which expiry was picked, not any
// real difference in writer conviction.
//
// A per-strike median (either within the narrow tradable delta band, or
// across the full chain) was tried first and rejected: the narrow band
// only has 3-10 strikes at any single instant, far too few for a stable
// median, and the full chain's median is dragged up by illiquid far
// strikes whose tiny volume denominators inflate their WCI - confirmed
// live, the full-chain median (0.05) sat well above the near-ATM wall
// itself (0.008) on the very snapshot the bug was reported on, so it
// would have changed nothing. Instead, chainWciBaseline sums raw OI
// change and volume across every strike with any volume before dividing
// once - a ratio of two large pooled sums is far less noisy per-instant
// than a median of many small per-strike ratios (confirmed live: the
// aggregate ratio moved smoothly across 30 sampled snapshots per expiry,
// vs. per-strike medians that swung wildly instant to instant).
//
// Each horizon keeps its own multiplier above that live baseline -
// preserving the doc's intent that weekly/monthly positions need more
// conviction to justify overnight/weekend gap risk - rather than one
// fixed number calibrated for whichever regime the horizon was originally
// tuned against. Calibrated against 30 sampled snapshots per expiry
// (2026-07-31, NIFTY front-week 2026-08-04 vs back-week 2026-08-11):
// intraday's pass rate rose from 10/30 (33%, the old fixed 0.10) to
// 19/30 (63%) while weekly/monthly's stayed comparable (20/30 old vs
// 17/30 new) - meaningfully more reachable on a front-week chain without
// making either horizon's bar trivial.
const WCI_BASELINE_MULTIPLIER: Record<TradingHorizon, number> = {
  intraday: 1.3,
  weekly: 1.75,
  monthly: 1.75
};

function chainWciBaseline(rows: StrikeMatrixRow[]): number | undefined {
  let sumAbsOiChange = 0;
  let sumVolume = 0;
  for (const row of rows) {
    if (row.volume > 0) {
      sumAbsOiChange += Math.abs(row.oiChange);
      sumVolume += row.volume;
    }
  }
  return sumVolume > 0 ? sumAbsOiChange / sumVolume : undefined;
}

function relativeWciThreshold(allRows: StrikeMatrixRow[], horizon: TradingHorizon): number {
  const baseline = chainWciBaseline(allRows);
  // No usable volume anywhere on the chain (e.g. a stale/empty snapshot) -
  // fall back to the horizon's static legacy threshold rather than 0.
  if (baseline === undefined) {
    return STRIKE_MATRIX_HORIZONS[horizon].wciThreshold;
  }
  return baseline * WCI_BASELINE_MULTIPLIER[horizon];
}

function closestToTargetDelta(rows: StrikeMatrixRow[], optionType: "CE" | "PE", targetDelta: number): StrikeMatrixRow | undefined {
  let best: StrikeMatrixRow | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.optionType !== optionType || row.openInterest < MIN_RECOMMENDATION_OPEN_INTEREST || row.volume <= 0) {
      continue;
    }
    const distance = Math.abs(Math.abs(row.delta) - targetDelta);
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

export function calculateStrikeMatrix(snapshot: OptionChainSnapshot, horizon: TradingHorizon): StrikeMatrixAnalysis {
  const profile = STRIKE_MATRIX_HORIZONS[horizon];

  // Every strike with usable volume/OI-change, chain-wide - not yet
  // narrowed to the horizon's delta band. chainWciBaseline needs the full
  // chain (hundreds of strikes) to read this contract's overall turnover
  // regime; the in-band universe alone is too few strikes for a stable
  // read (confirmed live, often just 2-7 rows).
  const allRows = snapshot.ticks.map(buildRow).filter((row): row is StrikeMatrixRow => row !== null);

  // Active universe S: every strike whose |delta| sits inside the horizon
  // band. Ticks without a delta can't participate in any of the three
  // metrics, so they're excluded rather than defaulted to 0 (a fake 0 delta
  // would silently zero its DRC and skew DRCR).
  const universe = allRows.filter((row) => Math.abs(row.delta) >= profile.deltaMin && Math.abs(row.delta) <= profile.deltaMax);

  let putDrcTotal = 0;
  let callDrcTotal = 0;
  for (const row of universe) {
    if (row.optionType === "PE") {
      putDrcTotal += Math.abs(row.drc);
    } else {
      callDrcTotal += Math.abs(row.drc);
    }
  }

  const drcr = callDrcTotal > 0 ? putDrcTotal / callDrcTotal : undefined;
  const bias = classifyDrcr(drcr);
  const effectiveWciThreshold = relativeWciThreshold(allRows, horizon);
  const callWall = findWall(universe, "CE", effectiveWciThreshold);
  const putWall = findWall(universe, "PE", effectiveWciThreshold);

  let recommendation: StrikeMatrixRecommendation | undefined;
  if (bias !== "Transitional") {
    const cell = profile.matrix[bias];
    const callPick = cell.writesCall ? closestToTargetDelta(universe, "CE", cell.targetDelta) : undefined;
    const putPick = cell.writesPut ? closestToTargetDelta(universe, "PE", cell.targetDelta) : undefined;
    // Only recommend when every side the structure writes actually has an
    // execution strike available in the universe.
    if ((!cell.writesCall || callPick) && (!cell.writesPut || putPick)) {
      recommendation = {
        structure: cell.structure,
        targetDelta: cell.targetDelta,
        callStrike: callPick?.strikePrice,
        callStrikeDelta: callPick?.delta,
        putStrike: putPick?.strikePrice,
        putStrikeDelta: putPick?.delta,
        theoreticalPop: THEORETICAL_POP,
        note: cell.note
      };
    }
  }

  return {
    horizon,
    deltaMin: profile.deltaMin,
    deltaMax: profile.deltaMax,
    // The bar actually applied above (may be lower than the horizon's base
    // threshold on a high-turnover contract - see relativeWciThreshold) so
    // the UI never shows a number that doesn't match what was checked.
    wciThreshold: effectiveWciThreshold,
    targetDelta: profile.targetDelta,
    universe,
    putDrcTotal,
    callDrcTotal,
    drcr,
    bias,
    callWall,
    putWall,
    recommendation,
    riskRule: profile.riskRule
  };
}

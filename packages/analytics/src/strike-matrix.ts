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
  let best: StrikeMatrixRow | undefined;
  for (const row of rows) {
    if (row.optionType !== optionType || row.wci === undefined) {
      continue;
    }
    if (!best || Math.abs(row.wci) > Math.abs(best.wci ?? 0)) {
      best = row;
    }
  }
  if (!best || best.wci === undefined) {
    return undefined;
  }
  return {
    optionType,
    strikePrice: best.strikePrice,
    wci: best.wci,
    // Threshold uses the raw (signed) WCI: negative WCI means positions are
    // being unwound, which is never institutional backing for a new short.
    meetsThreshold: best.wci > wciThreshold,
    delta: best.delta,
    oiChange: best.oiChange,
    volume: best.volume
  };
}

function closestToTargetDelta(rows: StrikeMatrixRow[], optionType: "CE" | "PE", targetDelta: number): StrikeMatrixRow | undefined {
  let best: StrikeMatrixRow | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.optionType !== optionType) {
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

  // Active universe S: every strike whose |delta| sits inside the horizon
  // band. Ticks without a delta can't participate in any of the three
  // metrics, so they're excluded rather than defaulted to 0 (a fake 0 delta
  // would silently zero its DRC and skew DRCR).
  const universe = snapshot.ticks
    .map(buildRow)
    .filter((row): row is StrikeMatrixRow => row !== null && Math.abs(row.delta) >= profile.deltaMin && Math.abs(row.delta) <= profile.deltaMax);

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
  const callWall = findWall(universe, "CE", profile.wciThreshold);
  const putWall = findWall(universe, "PE", profile.wciThreshold);

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
    wciThreshold: profile.wciThreshold,
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

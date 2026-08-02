// Strike Matrix engine — the "Strikes Movement Design and Decision Matrix"
// framework (see docs/New Dashboard ver 1.0). Anchors option-writing
// decisions to live chain dynamics instead of fixed strike offsets:
//
//   WCI(i)  = OIC(i) / Volume(i)      — writing conviction (institutional vs
//                                       retail churn) at a strike
//   DRC(i)  = OIC(i) × Delta(i)       — signed directional risk being added
//                                       or removed at a strike
//   DRCR    = avg|DRC| puts / avg|DRC| calls, opening OI only — net market
//                                       bias of writer flow
//
// The three horizon profiles (delta band, WCI threshold, target delta,
// decision matrix, mandatory risk rule) mirror the Unified Analyst's
// Decision Matrix exactly; changing a number here changes what the Strike
// Matrix tab recommends, so keep them in sync with the doc. DRCR is the one
// deliberate exception: the doc's literal Σ|DRC| formula (a raw sum over
// ALL activity, opening or closing) demonstrably misread live data - see
// classifyDrcr's call site below for the specifics and live evidence.

import type {
  OptionChainSnapshot,
  OptionContractTick,
  StrikeMatrixAnalysis,
  StrikeMatrixBias,
  StrikeMatrixInstitutionalUnwinding,
  StrikeMatrixRecommendation,
  StrikeMatrixRiskRuleStatus,
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

// Probability that every leg of the structure expires worthless, derived
// from the deltas of the strikes ACTUALLY picked. Delta approximates the
// risk-neutral probability of finishing ITM, so a single short leg is
// ~1 - |delta|; a two-legged structure (strangle/iron condor) needs BOTH
// legs to expire worthless, so the two tail probabilities subtract.
//
// Was previously a hardcoded 85 stamped on every recommendation regardless
// of which strike the engine chose - confirmed live, two-legged structures
// whose own deltas implied 67-76% still displayed "~85% POP" beside a
// trade button.
function theoreticalPop(callDelta: number | undefined, putDelta: number | undefined): number {
  const callTail = callDelta === undefined ? 0 : Math.abs(callDelta);
  const putTail = putDelta === undefined ? 0 : Math.abs(putDelta);
  return Math.round(Math.max(0, Math.min(1, 1 - callTail - putTail)) * 100);
}

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

// Turns the two sides' per-strike average |DRC| into a ratio plus a bias.
//
// The zero-guard used to be one-sided: zero CALL churn returned undefined
// ("no signal"), but zero PUT churn produced drcr = 0, which classifyDrcr
// reads as a confident "Bearish". The two one-sided cases are genuinely
// symmetric and both carry real information - calls being written while
// puts aren't IS bearish, and puts being written while calls aren't IS
// bullish - so the fix isn't to suppress both, which would throw away a
// real signal, but to read both the same way.
//
// drcr itself stays undefined in those cases because there is no finite
// ratio to report (the denominator is zero); the direction is still
// unambiguous, so bias is set directly rather than inferred from a
// fabricated number. Only genuinely-empty flow on BOTH sides reads as no
// signal at all.
function readWriterFlow(
  putCount: number,
  callCount: number,
  putAverage: number,
  callAverage: number
): { drcr: number | undefined; bias: StrikeMatrixBias } {
  if (putCount === 0 && callCount === 0) {
    return { drcr: undefined, bias: "Transitional" };
  }
  if (callCount === 0) {
    return { drcr: undefined, bias: "Bullish" };
  }
  if (putCount === 0) {
    return { drcr: undefined, bias: "Bearish" };
  }
  const drcr = putAverage / callAverage;
  return { drcr, bias: classifyDrcr(drcr) };
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
    lastPriceChange: tick.lastPriceChange,
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

// --- Mandatory risk rules ---------------------------------------------
// Each horizon's own rule (below) was previously footnote text only,
// never evaluated - confirmed live, none of the four (2x-delta stop,
// weekend-decay window, IV Rank gate, Institutional Unwinding) were ever
// checked against real data. Every rule here defaults to "can't be
// evaluated" (satisfied: undefined) rather than silently passing when the
// data needed to check it isn't available - an unevaluated rule must never
// look identical to a cleared one.

function evaluateIntradayRiskRule(): StrikeMatrixRiskRuleStatus {
  // The 2x-delta hard stop compares a short strike's CURRENT |delta|
  // against its |delta| AT ENTRY - which only exists once a position has
  // actually been placed. Strike Matrix is a pre-trade screen with no
  // entry to compare against, so there is nothing for this function to
  // evaluate here - but the rule itself is not unenforced: Sim's exit-rule
  // engine already auto-closes any open position whose |delta| doubles
  // from its entry delta (DELTA_2X_INTRADAY, packages/db/src/sim-
  // repository.ts), confirmed working in production. This status exists
  // so the UI can say so explicitly instead of implying the rule is
  // unchecked.
  return {
    satisfied: undefined,
    detail: "Applies after entry, not pre-trade - Sim auto-closes any open position whose |delta| doubles from its entry delta."
  };
}

// "Friday afternoon" starts 12:00 IST; "Monday morning" ends 11:00 IST the
// following Monday. Neither cutoff is independently documented anywhere in
// this repo - chosen as a reasonable starting boundary for "deploy weekly
// positions to capture weekend theta, not mid-week," not a backtested
// number. Revisit if real usage shows it's too tight or too loose.
const WEEKEND_DECAY_FRIDAY_START_HOUR_IST = 12;
const WEEKEND_DECAY_MONDAY_END_HOUR_IST = 11;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Calendar days from `now` to the chain's own expiry. NSE/BSE index options
// expire at market close (15:30 IST = 10:00 UTC), matching the convention
// getCalendarDaysToExpiry uses for the gamma-risk alert in this package.
function calendarDaysToExpiry(expiry: string, now: Date): number {
  const expiryMs = Date.parse(`${expiry}T10:00:00.000Z`);
  if (!Number.isFinite(expiryMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return (expiryMs - now.getTime()) / 86_400_000;
}

// The horizon toggle changes the analysis FRAMEWORK (delta band, WCI
// multiplier, mandatory risk rule) but never which contract is loaded -
// that's driven by the separately-chosen expiry. So a horizon can end up
// applied to a contract whose tenor it was never meant for: picking
// "Monthly" against NIFTY, which lists only weekly expiries, runs the
// monthly delta band and the IV-Rank gate against a 4-DTE chain, and
// BANKNIFTY's "Intraday" tab does the reverse against a 25-DTE
// monthly-only chain. Both were confirmed live.
//
// Bounds mirror the horizon's own intent rather than inventing new ones:
// intraday means expiry today/tomorrow, weekly means inside a week or so,
// monthly means genuinely multi-week. Returns undefined when the pairing
// is sensible, so callers can treat presence as "worth surfacing."
const HORIZON_TENOR_BOUNDS: Record<TradingHorizon, { maxDays?: number; minDays?: number; label: string }> = {
  intraday: { maxDays: 2, label: "expiry today or tomorrow" },
  weekly: { maxDays: 10, minDays: 1, label: "about a week to expiry" },
  monthly: { minDays: 10, label: "several weeks to expiry" }
};

function describeHorizonTenorMismatch(horizon: TradingHorizon, daysToExpiry: number): string | undefined {
  if (!Number.isFinite(daysToExpiry)) {
    return undefined;
  }
  const bounds = HORIZON_TENOR_BOUNDS[horizon];
  const rounded = Math.max(0, Math.round(daysToExpiry));
  const contractText = `${rounded} day${rounded === 1 ? "" : "s"} to expiry`;
  if (bounds.maxDays !== undefined && daysToExpiry > bounds.maxDays) {
    return `${horizon} assumes ${bounds.label}, but this contract has ${contractText} - the delta band and risk rule below are sized for a shorter-dated chain than the one selected.`;
  }
  if (bounds.minDays !== undefined && daysToExpiry < bounds.minDays) {
    return `${horizon} assumes ${bounds.label}, but this contract has ${contractText} - the delta band and risk rule below are sized for a longer-dated chain than the one selected.`;
  }
  return undefined;
}

function isWeekendDecayWindow(now: Date): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay(); // 0=Sun ... 5=Fri, 6=Sat
  const hour = ist.getUTCHours();
  if (day === 6 || day === 0) return true; // all weekend
  if (day === 5) return hour >= WEEKEND_DECAY_FRIDAY_START_HOUR_IST;
  if (day === 1) return hour < WEEKEND_DECAY_MONDAY_END_HOUR_IST;
  return false;
}

function evaluateWeeklyRiskRule(now: Date): StrikeMatrixRiskRuleStatus {
  const inWindow = isWeekendDecayWindow(now);
  return {
    satisfied: inWindow,
    detail: inWindow
      ? "Within the Friday-afternoon-to-Monday-morning window - safe to deploy for weekend theta."
      : "Outside the weekend-decay window (Fri 12:00 IST - Mon 11:00 IST) - a fresh weekly position now carries uncompensated gap risk."
  };
}

// IV Rank needs a real distribution of prior trading days' ATM IV to rank
// today's reading against - a percentile computed from fewer than ~20 days
// is mostly noise. This floor is deliberately conservative given this
// deployment currently has under 20 days of snapshot history at all
// (confirmed live, 2026-07-31) - the rule will genuinely start evaluating
// once enough days accumulate, rather than faking a rank from what's there.
const MIN_IV_RANK_HISTORY_DAYS = 20;
const IV_RANK_MINIMUM_PERCENT = 30;

function calculateIvRank(currentIv: number, history: number[]): number {
  const below = history.filter((iv) => iv <= currentIv).length;
  return (below / history.length) * 100;
}

function evaluateMonthlyRiskRule(snapshot: OptionChainSnapshot, ivHistory: number[] | undefined): StrikeMatrixRiskRuleStatus {
  // ATM CALL IV specifically - PE-side impliedVolatility is currently
  // unreliable in production (confirmed live: reads 0 on every recent PE
  // tick sampled while the CE tick at the same strike/instant has a real
  // value - flagged separately as its own data-pipeline bug, not
  // something this rule should paper over).
  const atmCall = snapshot.ticks.find((tick) => tick.optionType === "CE" && tick.strikePrice === snapshot.atmStrike);
  const currentIv = atmCall?.impliedVolatility;
  if (currentIv === undefined || !ivHistory || ivHistory.length < MIN_IV_RANK_HISTORY_DAYS) {
    return {
      satisfied: undefined,
      detail: `Not enough IV history to compute a rank yet (need ${MIN_IV_RANK_HISTORY_DAYS}+ trading days) - treat as unconfirmed, not cleared.`
    };
  }
  const rank = calculateIvRank(currentIv, ivHistory);
  const satisfied = rank >= IV_RANK_MINIMUM_PERCENT;
  return {
    satisfied,
    detail: satisfied
      ? `IV Rank ${rank.toFixed(0)}% clears the ${IV_RANK_MINIMUM_PERCENT}% floor - premium compensates the vega risk.`
      : `IV Rank ${rank.toFixed(0)}% is below the ${IV_RANK_MINIMUM_PERCENT}% floor - the premium collected won't compensate the vega risk.`
  };
}

// Institutional Unwinding: call WRITERS covering (buying back short
// calls) in the ATM/near-OTM band - the exit signal for a short-call-
// oriented structure. Needs a wider delta band than any horizon's own
// tradable universe (0.35-0.65 vs every horizon's <=0.25 cap), since
// covering typically starts near the money, not in the far wings this
// engine otherwise trades - confirmed live, BANKNIFTY had 5 calls with
// negative OI change in this exact band, none inside any horizon's own
// universe. Requires the SHORT_COVERING signature specifically (OI
// falling AND price rising) rather than any OI decrease, since OI falling
// with price ALSO falling is LONG_UNWINDING (buyers giving up), not
// writers covering.
const INSTITUTIONAL_UNWINDING_DELTA_MIN = 0.35;
const INSTITUTIONAL_UNWINDING_DELTA_MAX = 0.65;

function detectInstitutionalUnwinding(allRows: StrikeMatrixRow[]): StrikeMatrixInstitutionalUnwinding | undefined {
  const candidates = allRows.filter(
    (row) =>
      row.optionType === "CE" &&
      Math.abs(row.delta) >= INSTITUTIONAL_UNWINDING_DELTA_MIN &&
      Math.abs(row.delta) <= INSTITUTIONAL_UNWINDING_DELTA_MAX &&
      row.oiChange < 0 &&
      (row.lastPriceChange ?? 0) > 0
  );
  if (!candidates.length) {
    return undefined;
  }
  let best = candidates[0];
  for (const row of candidates) {
    if (Math.abs(row.oiChange) > Math.abs(best.oiChange)) {
      best = row;
    }
  }
  return { strikePrice: best.strikePrice, delta: best.delta, oiChange: best.oiChange };
}

export function calculateStrikeMatrix(
  snapshot: OptionChainSnapshot,
  horizon: TradingHorizon,
  now: Date = new Date(),
  // Prior trading days' ATM CALL implied volatility, oldest-to-newest -
  // supplied by the caller (this package has no DB access of its own).
  // Only consulted for the monthly horizon's IV Rank gate.
  ivHistory?: number[]
): StrikeMatrixAnalysis {
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
  let putDrcCount = 0;
  let callDrcTotal = 0;
  let callDrcCount = 0;
  for (const row of universe) {
    // Only OI that's genuinely OPENING counts as writer conviction being
    // built - a strike with OI closing (covering/unwinding) contributes
    // nothing here, however large its |DRC| magnitude, since that's
    // positions being unwound, not a wall being built. Confirmed live
    // (BANKNIFTY monthly, three consecutive snapshots): DRCR read 1.52-1.55
    // "Bullish" while the put side's net OI change was -2,880 (positions
    // closing) - the inverse of what DRCR is meant to measure. This
    // deliberately deviates from the reference doc's literal Σ|DRC|
    // formula (confirmed with the user) because that formula can't tell
    // writing from unwinding apart at all.
    if (row.oiChange <= 0) {
      continue;
    }
    if (row.optionType === "PE") {
      putDrcTotal += Math.abs(row.drc);
      putDrcCount += 1;
    } else {
      callDrcTotal += Math.abs(row.drc);
      callDrcCount += 1;
    }
  }

  // Averaged per qualifying strike, not the raw sum - a side with
  // structurally more in-band strikes shouldn't win the ratio purely by
  // strike count. Confirmed live: NIFTY's put skew means 3-4 PE strikes
  // typically qualify in-band against 2 CE strikes, independent of any
  // real flow difference - DRCR never once read "Bearish" for NIFTY
  // across 160 sampled snapshots under the un-normalized sum.
  const putDrcAverage = putDrcCount > 0 ? putDrcTotal / putDrcCount : 0;
  const callDrcAverage = callDrcCount > 0 ? callDrcTotal / callDrcCount : 0;
  const { drcr, bias } = readWriterFlow(putDrcCount, callDrcCount, putDrcAverage, callDrcAverage);
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
      // The walls above are what the whole framework treats as evidence of
      // institutional backing, but the recommendation never used to read
      // them - so a structure written against no qualifying wall on either
      // side rendered exactly like one backed on both. Record which
      // written side(s) lack a qualifying wall so the distinction survives
      // into the API response.
      const unbackedSides: ("CE" | "PE")[] = [];
      if (cell.writesCall && !callWall?.meetsThreshold) {
        unbackedSides.push("CE");
      }
      if (cell.writesPut && !putWall?.meetsThreshold) {
        unbackedSides.push("PE");
      }
      recommendation = {
        structure: cell.structure,
        targetDelta: cell.targetDelta,
        callStrike: callPick?.strikePrice,
        callStrikeDelta: callPick?.delta,
        putStrike: putPick?.strikePrice,
        putStrikeDelta: putPick?.delta,
        theoreticalPop: theoreticalPop(callPick?.delta, putPick?.delta),
        note: cell.note,
        wallBacked: unbackedSides.length === 0,
        unbackedSides
      };
    }
  }

  const riskRuleStatus: StrikeMatrixRiskRuleStatus =
    horizon === "intraday" ? evaluateIntradayRiskRule() : horizon === "weekly" ? evaluateWeeklyRiskRule(now) : evaluateMonthlyRiskRule(snapshot, ivHistory);
  const institutionalUnwinding = detectInstitutionalUnwinding(allRows);
  const daysToExpiry = calendarDaysToExpiry(snapshot.expiry, now);

  return {
    horizon,
    daysToExpiry,
    horizonTenorMismatch: describeHorizonTenorMismatch(horizon, daysToExpiry),
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
    riskRule: profile.riskRule,
    riskRuleStatus,
    institutionalUnwinding
  };
}

import type {
  AlertThresholdConfig,
  AtmStraddleExpectedMove,
  ChainStats,
  MarketAlert,
  MarketBiasSummary,
  MarketPulse,
  MarketPulsePoint,
  OptionActivityKind,
  OptionChainSnapshot,
  OptionContractTick,
  PressureScore,
  PressureZone,
  StrikeMovementRow,
  TradeInterpretation
} from "@option-decode/types";

function pressureValue(tick: OptionContractTick, averageVolume = 0): number {
  const oi = toLots(tick.openInterest, tick);
  const oiChange = toLots(tick.changeInOpenInterest, tick);
  const volume = toLots(tick.volume, tick);
  const volumeContribution = weightedVolumeContribution(volume, averageVolume);
  const ltpChange = tick.lastPriceChange ?? 0;

  if (oiChange > 0 && ltpChange < 0) {
    return oi + Math.abs(oiChange) * 1.5 + volumeContribution;
  }
  if (oiChange < 0 && ltpChange > 0) {
    return oi - Math.abs(oiChange) * 1.2 + volumeContribution * 0.5;
  }
  if (oiChange > 0 && ltpChange > 0) {
    return oi + Math.abs(oiChange) * 0.4 + volumeContribution * 0.5;
  }

  return oi + oiChange * 0.5 + volumeContribution * 0.5;
}

function topZones(ticks: OptionContractTick[], spotPrice: number, label: "support" | "resistance"): PressureZone[] {
  const directionalTicks = ticks.filter((tick) => (label === "support" ? tick.strikePrice <= spotPrice : tick.strikePrice >= spotPrice));
  const rankedTicks = directionalTicks.length ? directionalTicks : ticks;
  const averageVolume = averageLotsVolume(ticks);
  return rankedTicks
    .map((tick) => {
      // Breakeven cushion (the playbook's "true" defense line): a
      // resistance (CE) wall's real ceiling is the strike PLUS what writers
      // collected; a support (PE) floor's real ground is the strike MINUS
      // premium collected. Only computable when the anchoring tick has a
      // live premium — left undefined otherwise rather than guessed.
      const premium = tick.lastPrice && tick.lastPrice > 0 ? tick.lastPrice : undefined;
      const trueZone = premium === undefined ? undefined : label === "resistance" ? tick.strikePrice + premium : Math.max(0, tick.strikePrice - premium);
      return {
        strikePrice: tick.strikePrice,
        score: Math.round(pressureValue(tick, averageVolume)),
        reason: `${tick.optionType} ${label} pressure from OI, OI change, and volume in lots`,
        premium,
        trueZone
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

export function calculatePressureScore(snapshot: OptionChainSnapshot): PressureScore {
  const peTicks = snapshot.ticks.filter((tick) => tick.optionType === "PE");
  const ceTicks = snapshot.ticks.filter((tick) => tick.optionType === "CE");
  const peAverageVolume = averageLotsVolume(peTicks);
  const ceAverageVolume = averageLotsVolume(ceTicks);
  const pePressure = peTicks.reduce((total, tick) => total + pressureValue(tick, peAverageVolume), 0);
  const cePressure = ceTicks.reduce((total, tick) => total + pressureValue(tick, ceAverageVolume), 0);
  const displayPePressure = Math.max(0, pePressure);
  const displayCePressure = Math.max(0, cePressure);
  const total = Math.max(displayPePressure + displayCePressure, 1);
  const totalPeOi = peTicks.reduce((sum, tick) => sum + toLots(tick.openInterest, tick), 0);
  const totalCeOi = ceTicks.reduce((sum, tick) => sum + toLots(tick.openInterest, tick), 0);

  return {
    bullishPressure: Math.round((displayPePressure / total) * 100),
    bearishPressure: Math.round((displayCePressure / total) * 100),
    supportZones: topZones(peTicks, snapshot.spotPrice, "support"),
    resistanceZones: topZones(ceTicks, snapshot.spotPrice, "resistance"),
    pcr: totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(2)) : undefined,
    maxPain: calculateMaxPain(snapshot.ticks)
  };
}

function calculateMaxPain(ticks: OptionContractTick[]): number | undefined {
  const strikes = [...new Set(ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  if (!strikes.length) {
    return undefined;
  }

  let bestStrike = strikes[0];
  let lowestPain = Number.POSITIVE_INFINITY;
  for (const candidate of strikes) {
    const pain = ticks.reduce((sum, tick) => {
      const openInterestLots = toLots(tick.openInterest, tick);
      const intrinsic = tick.optionType === "CE" ? Math.max(0, candidate - tick.strikePrice) : Math.max(0, tick.strikePrice - candidate);
      return sum + openInterestLots * intrinsic;
    }, 0);
    if (pain < lowestPain) {
      lowestPain = pain;
      bestStrike = candidate;
    }
  }

  return bestStrike;
}

function toLots(value: number | undefined, tick: OptionContractTick): number {
  const lotSize = tick.lotSize && tick.lotSize > 0 ? tick.lotSize : 1;
  return (value ?? 0) / lotSize;
}

function averageLotsVolume(ticks: OptionContractTick[]): number {
  if (!ticks.length) {
    return 0;
  }

  return ticks.reduce((sum, tick) => sum + toLots(tick.volume, tick), 0) / ticks.length;
}

function weightedVolumeContribution(volume: number, averageVolume: number): number {
  const surgeMultiplier = averageVolume > 0 && volume > averageVolume * 2 ? 1.5 : 1;
  return volume * 0.5 * surgeMultiplier;
}

export function generateMarketAlerts(snapshot: OptionChainSnapshot, pressure: PressureScore, now = new Date(), thresholds?: AlertThresholdConfig): MarketAlert[] {
  const createdAt = now.toISOString();
  const alerts: MarketAlert[] = [];
  const nearestResistance = pressure.resistanceZones[0];
  const nearestSupport = pressure.supportZones[0];
  const resistanceDistance = nearestResistance ? Math.abs(nearestResistance.strikePrice - snapshot.spotPrice) : undefined;
  const supportDistance = nearestSupport ? Math.abs(snapshot.spotPrice - nearestSupport.strikePrice) : undefined;
  const proximityThreshold = thresholds?.proximityPoints ?? getProximityThreshold(snapshot.underlyingSymbol);
  const pressureWarning = thresholds?.pressureWarning ?? 55;
  const pressureCritical = thresholds?.pressureCritical ?? 62;
  const pcrUpper = thresholds?.pcrUpper ?? 1.15;
  const pcrLower = thresholds?.pcrLower ?? 0.85;
  const pcrCriticalUpper = pcrUpper + 0.1;
  const pcrCriticalLower = Math.max(0, pcrLower - 0.1);
  const maxPainDistance = pressure.maxPain !== undefined ? Math.abs(snapshot.spotPrice - pressure.maxPain) : undefined;

  if (pressure.bearishPressure >= pressureWarning && nearestResistance) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-bearish-pressure`,
      severity: pressure.bearishPressure >= pressureCritical ? "critical" : "warning",
      title: "Resistance pressure active",
      message: `CE pressure is ${pressure.bearishPressure}% with strongest resistance near ${formatStrike(nearestResistance.strikePrice)}.`,
      metric: "bearishPressure",
      createdAt
    });
  }

  if (pressure.bullishPressure >= pressureWarning && nearestSupport) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-bullish-pressure`,
      severity: pressure.bullishPressure >= pressureCritical ? "critical" : "warning",
      title: "Support pressure active",
      message: `PE support is ${pressure.bullishPressure}% with strongest support near ${formatStrike(nearestSupport.strikePrice)}.`,
      metric: "bullishPressure",
      createdAt
    });
  }

  if (pressure.pcr !== undefined && (pressure.pcr >= pcrUpper || pressure.pcr <= pcrLower)) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-pcr-bias`,
      severity: pressure.pcr >= pcrCriticalUpper || pressure.pcr <= pcrCriticalLower ? "critical" : "warning",
      title: "PCR bias detected",
      message: `PCR is ${pressure.pcr.toFixed(2)}, showing ${pressure.pcr > 1 ? "put-side support" : "call-side resistance"} bias.`,
      metric: "pcr",
      createdAt
    });
  }

  if (resistanceDistance !== undefined && resistanceDistance <= proximityThreshold && nearestResistance) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-near-resistance`,
      severity: "info",
      title: "CMP near resistance",
      message: `Spot is within ${formatStrike(resistanceDistance)} points of resistance at ${formatStrike(nearestResistance.strikePrice)}.`,
      metric: "resistanceDistance",
      createdAt
    });
  }

  if (supportDistance !== undefined && supportDistance <= proximityThreshold && nearestSupport) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-near-support`,
      severity: "info",
      title: "CMP near support",
      message: `Spot is within ${formatStrike(supportDistance)} points of support at ${formatStrike(nearestSupport.strikePrice)}.`,
      metric: "supportDistance",
      createdAt
    });
  }

  if (maxPainDistance !== undefined && pressure.maxPain !== undefined && maxPainDistance <= proximityThreshold) {
    alerts.push({
      id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-near-max-pain`,
      severity: "info",
      title: "CMP near max pain",
      message: `Spot is within ${formatStrike(maxPainDistance)} points of max pain at ${formatStrike(pressure.maxPain)}.`,
      metric: "maxPainDistance",
      createdAt
    });
  }

  const gammaRiskAlert = buildGammaRiskAlert(snapshot, now, nearestResistance, nearestSupport, resistanceDistance, supportDistance);
  if (gammaRiskAlert) {
    alerts.push(gammaRiskAlert);
  }

  return alerts.slice(0, 7);
}

// Fraction of spot price within which a written strike is considered "under
// gamma threat" on the eve of / on expiry itself — the playbook's 0.5% rule.
const GAMMA_RISK_PROXIMITY_PERCENT = 0.5;
// Gamma risk is flagged once the current expiry is this close (in calendar
// days) — 1 day covers "expiry is tomorrow" and 0 covers "expiry is today,"
// matching the playbook's "roll by the evening/morning before expiry" rule.
const GAMMA_RISK_DAYS_TO_EXPIRY = 1;

/**
 * Deliberately NOT keyed off a hardcoded weekday (e.g. "Wednesday/Thursday
 * for Nifty"). Since the September 2025 SEBI expiry-day rationalization,
 * Nifty 50 expires Tuesdays and Sensex expires Thursdays — and any exchange
 * holiday shifts the actual expiry date further. Deriving purely from
 * `snapshot.expiry` (the real expiry date already on the snapshot) is
 * correct for both indices and every holiday-shifted date, with no
 * per-symbol day-of-week table to keep in sync as expiry-day rules change
 * again in the future.
 */
function getCalendarDaysToExpiry(expiry: string, asOfMs: number): number {
  // NSE/BSE index options expire at market close (15:30 IST = 10:00 UTC).
  const expiryMs = Date.parse(`${expiry}T10:00:00.000Z`);
  if (!Number.isFinite(expiryMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return (expiryMs - asOfMs) / 86_400_000;
}

function buildGammaRiskAlert(
  snapshot: OptionChainSnapshot,
  now: Date,
  nearestResistance: PressureZone | undefined,
  nearestSupport: PressureZone | undefined,
  resistanceDistance: number | undefined,
  supportDistance: number | undefined
): MarketAlert | undefined {
  if (snapshot.spotPrice <= 0) {
    return undefined;
  }

  const daysToExpiry = getCalendarDaysToExpiry(snapshot.expiry, now.getTime());
  if (daysToExpiry > GAMMA_RISK_DAYS_TO_EXPIRY || daysToExpiry < -1) {
    return undefined;
  }

  const proximityPoints = snapshot.spotPrice * (GAMMA_RISK_PROXIMITY_PERCENT / 100);
  const threatenedZone =
    resistanceDistance !== undefined && resistanceDistance <= proximityPoints
      ? { zone: nearestResistance, type: "CE" as const }
      : supportDistance !== undefined && supportDistance <= proximityPoints
        ? { zone: nearestSupport, type: "PE" as const }
        : undefined;

  if (!threatenedZone?.zone) {
    return undefined;
  }

  return {
    id: `${snapshot.underlyingSymbol}-${snapshot.expiry}-gamma-risk`,
    severity: "critical",
    title: "Gamma risk — roll or close short strikes",
    message: `${snapshot.underlyingSymbol} expires in ${daysToExpiry <= 0 ? "hours" : "under a day"} and spot is within ${GAMMA_RISK_PROXIMITY_PERCENT}% of the ${threatenedZone.type} ${threatenedZone.type === "CE" ? "resistance" : "support"} wall at ${formatStrike(threatenedZone.zone.strikePrice)}. Premium on a short here can spike 300-500% on a small move — roll or buy back now rather than holding into the close.`,
    metric: "gammaRisk",
    createdAt: now.toISOString()
  };
}

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function getProximityThreshold(underlyingSymbol: string) {
  const thresholds: Record<string, number> = {
    NIFTY: 100,
    BANKNIFTY: 250,
    FINNIFTY: 100,
    MIDCPNIFTY: 75,
    NIFTYNXT50: 150,
    SENSEX: 250,
    BANKEX: 150,
    CRUDEOIL: 30,
    NATURALGAS: 5,
    COPPER: 10,
    SILVER: 150
  };

  return thresholds[underlyingSymbol.toUpperCase()] ?? 100;
}

/**
 * Classifies a leg's OI + LTP behaviour into the standard option-chain
 * "activity" read: long buildup, writing, short covering, or unwinding.
 * Previously lived only inside the web dashboard component — belongs here
 * so both the API and any future strategy/execution code can use it.
 */
export function classifyOptionActivity(tick?: OptionContractTick): OptionActivityKind {
  if (!tick) {
    return "NEUTRAL";
  }
  const oiChange = tick.changeInOpenInterest ?? 0;
  const ltpChange = tick.lastPriceChange ?? 0;
  if (oiChange > 0 && ltpChange > 0) return "LONG_BUILDUP";
  if (oiChange > 0 && ltpChange < 0) return "WRITING";
  if (oiChange < 0 && ltpChange > 0) return "SHORT_COVERING";
  if (oiChange < 0 && ltpChange < 0) return "LONG_UNWINDING";
  return "NEUTRAL";
}

function optionActivityWeight(tick?: OptionContractTick): number {
  if (!tick) return 0;
  return Math.round(Math.abs(toLots(tick.changeInOpenInterest, tick)) + Math.abs(toLots(tick.volume, tick)) * 0.05 + Math.abs(tick.lastPriceChangePercent ?? 0) * 2);
}

function getBuyerMomentumScore(tick?: OptionContractTick): number {
  const activity = classifyOptionActivity(tick);
  const weight = optionActivityWeight(tick);
  if (!tick || !weight) return 0;
  const direction = tick.optionType === "CE" ? 1 : -1;
  if (activity === "LONG_BUILDUP") return direction * weight;
  if (activity === "SHORT_COVERING") return direction * Math.round(weight * 0.5);
  if (activity === "WRITING") return -direction * Math.round(weight * 0.6);
  return 0;
}

function getSellerSafetyScore(tick?: OptionContractTick): number {
  const activity = classifyOptionActivity(tick);
  const weight = optionActivityWeight(tick);
  if (!tick || !weight) return 0;
  const supportDirection = tick.optionType === "PE" ? 1 : -1;
  if (activity === "WRITING") return supportDirection * weight;
  if (activity === "SHORT_COVERING") return -supportDirection * weight;
  if (activity === "LONG_BUILDUP") return -supportDirection * Math.round(weight * 0.5);
  return 0;
}

// Deliberately uses sessionOiChange/sessionPriceChangePercent (since
// TODAY's market open) rather than changeInOpenInterest/
// lastPriceChangePercent (both vs the PREVIOUS day's close). Two earlier
// approaches were tried and rejected: the day-level fields barely move
// within a session, so a trend arrow built from them stayed pointing one
// direction all day. A single-poll (~30s) or rolling 5min delta fixed
// that but was too short-horizon to read genuine day-basis direction -
// mostly bid/ask noise, flipping the whole ATM +/-4 window in lockstep on
// every poll with no real change in activity. Session-open keeps a fixed
// reference point for the whole day: this builds progressively as real
// activity accumulates, reads Flat at market open (correctly - there's
// nothing to report yet), and won't flicker on short-term noise. See
// OptionContractTick's doc comments in @option-decode/types for the full
// distinction between the field pairs.
function calculateStrikeTrend(tick?: OptionContractTick): number {
  if (!tick) return 0;
  const oiTrend = toLots(tick.sessionOiChange, tick);
  const ltpTrend = (tick.sessionPriceChangePercent ?? 0) * 2;
  return Math.round(oiTrend + ltpTrend);
}

/**
 * The playbook's ATM Straddle Rule: ATM Call LTP + ATM Put LTP is the
 * market's own priced-in expected move for the current expiry cycle.
 * Distinct from the India-VIX-derived expected-move band used elsewhere in
 * this codebase for chain-display range (spot * VIX% * sqrt(days/365)) —
 * that's a reasonable alternative but not what the playbook means by
 * "expected move," so both are kept as separate, independently-checkable
 * numbers rather than one replacing the other. Returns undefined when
 * either ATM leg has no live premium to anchor the calculation to (e.g. a
 * stale snapshot, or the ATM strike missing from this chain).
 */
export function calculateAtmStraddleExpectedMove(snapshot: OptionChainSnapshot): AtmStraddleExpectedMove | undefined {
  const atmCall = snapshot.ticks.find((tick) => tick.optionType === "CE" && tick.strikePrice === snapshot.atmStrike);
  const atmPut = snapshot.ticks.find((tick) => tick.optionType === "PE" && tick.strikePrice === snapshot.atmStrike);
  if (!atmCall?.lastPrice || atmCall.lastPrice <= 0 || !atmPut?.lastPrice || atmPut.lastPrice <= 0) {
    return undefined;
  }

  const atmStraddlePrice = atmCall.lastPrice + atmPut.lastPrice;
  return {
    atmStrike: snapshot.atmStrike,
    atmCallPrice: atmCall.lastPrice,
    atmPutPrice: atmPut.lastPrice,
    atmStraddlePrice,
    expectedUpperBoundary: snapshot.spotPrice + atmStraddlePrice,
    expectedLowerBoundary: Math.max(0, snapshot.spotPrice - atmStraddlePrice)
  };
}

/**
 * OI breadth: whether total PE OI or CE OI dominates across the whole
 * chain, plus the single strike carrying the most OI ("max OI magnet").
 * Referenced throughout the dashboard guide as the "OI Breadth" signal;
 * previously existed only as ad-hoc client-side math.
 */
export function calculateChainStats(snapshot: OptionChainSnapshot): ChainStats {
  const ceTicks = snapshot.ticks.filter((tick) => tick.optionType === "CE");
  const peTicks = snapshot.ticks.filter((tick) => tick.optionType === "PE");
  const totalCeOi = ceTicks.reduce((sum, tick) => sum + (tick.openInterest ?? 0), 0);
  const totalPeOi = peTicks.reduce((sum, tick) => sum + (tick.openInterest ?? 0), 0);
  const totalCeChange = ceTicks.reduce((sum, tick) => sum + (tick.changeInOpenInterest ?? 0), 0);
  const totalPeChange = peTicks.reduce((sum, tick) => sum + (tick.changeInOpenInterest ?? 0), 0);
  const maxOiTick = [...snapshot.ticks].sort((left, right) => (right.openInterest ?? 0) - (left.openInterest ?? 0))[0];
  const breadth: ChainStats["breadth"] = totalPeOi > totalCeOi * 1.05 ? "Put Support" : totalCeOi > totalPeOi * 1.05 ? "Call Resistance" : "Balanced";

  return {
    totalCeOi,
    totalPeOi,
    totalCeChange,
    totalPeChange,
    breadth,
    maxOiStrike: maxOiTick?.strikePrice,
    maxOiOptionType: maxOiTick?.optionType,
    maxOiValue: maxOiTick?.openInterest
  };
}

// Minimum |trendScore| (OI-change-in-lots + 2x LTP-change-%) required before
// a strike is called "building" rather than "Flat". This used to be (and
// still is, in the client-side strike-pressure-analytics.ts version of this
// same logic) the median trend strength of the same ATM +/-4 window being
// classified, which means a uniform move across every nearby strike (the
// clearest possible "building" signal) raises the bar right along with it
// and gets silently reclassified as Flat — the detector can only see a
// strike that stands out from its neighbors, never a level where the whole
// zone moves together. This fixed value is a reasonable starting heuristic,
// not a backtested number — revisit it once the backtest engine can
// calibrate it against real historical accuracy instead of a guess.
//
// trendScore is now built from sessionOiChange/sessionPriceChangePercent
// (since today's market open) rather than the old day-level
// changeInOpenInterest/lastPriceChangePercent (vs previous close) - see
// calculateStrikeTrend's doc comment. Magnitude-wise this sits between
// the two rejected in-between attempts (a single ~30s poll, and a 5min
// window) and the original day-level version: small right after market
// open, growing toward day-level scale as the session progresses. This
// number is a guess at a reasonable middle ground, not a calibrated one -
// watch it against real intraday behavior across a full session and
// adjust if it's too sticky early in the day (lower it) or too noisy
// later in the day (raise it).
const STRIKE_TREND_THRESHOLD = 5;

/**
 * ATM +/-4 strike movement score — the most important trend-reading panel
 * per the dashboard guide (section 3). Uses the same pressureValue
 * weighting as the main pressure score/zones so this panel can never
 * contradict the bullish/bearish % shown elsewhere on the same screen.
 */
export function calculateStrikeMovement(snapshot: OptionChainSnapshot): StrikeMovementRow[] {
  const strikes = [...new Set(snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === snapshot.atmStrike);
  if (atmIndex < 0) {
    return [];
  }

  const findTick = (strike: number, optionType: "CE" | "PE") => snapshot.ticks.find((tick) => tick.strikePrice === strike && tick.optionType === optionType);
  const window = strikes.slice(Math.max(0, atmIndex - 4), atmIndex + 5);
  const peAverageVolume = averageLotsVolume(snapshot.ticks.filter((tick) => tick.optionType === "PE"));
  const ceAverageVolume = averageLotsVolume(snapshot.ticks.filter((tick) => tick.optionType === "CE"));

  return window
    .map((strike): StrikeMovementRow => {
      const ce = findTick(strike, "CE");
      const pe = findTick(strike, "PE");
      const peScore = Math.round(Math.max(0, pressureValue(pe ?? emptyTick("PE", strike), peAverageVolume)));
      const ceScore = Math.round(Math.max(0, pressureValue(ce ?? emptyTick("CE", strike), ceAverageVolume)));
      const combinedScore = peScore + ceScore;
      const netScore = peScore - ceScore;
      const netScorePercent = combinedScore >= 10 ? Math.round((netScore / combinedScore) * 100) : 0;
      const trendScore = calculateStrikeTrend(pe) - calculateStrikeTrend(ce);
      const trendDirection: -1 | 0 | 1 = Math.abs(trendScore) >= STRIKE_TREND_THRESHOLD ? (Math.sign(trendScore) as -1 | 0 | 1) : 0;

      return {
        strike,
        isAtm: strike === snapshot.atmStrike,
        distance: strikes.indexOf(strike) - atmIndex,
        peScore,
        ceScore,
        netScore,
        netScorePercent,
        trendScore,
        trendDirection,
        bias: combinedScore < 10 ? "Balanced" : netScore > 0 ? "Up / support" : netScore < 0 ? "Down / resistance" : "Balanced",
        trend: trendDirection > 0 ? "Increasing support" : trendDirection < 0 ? "Increasing resistance" : "Flat",
        ceActivity: classifyOptionActivity(ce),
        peActivity: classifyOptionActivity(pe),
        buyerMomentumScore: getBuyerMomentumScore(ce) + getBuyerMomentumScore(pe),
        sellerSafetyScore: getSellerSafetyScore(ce) + getSellerSafetyScore(pe)
      };
    })
    .sort((left, right) => right.strike - left.strike);
}

function emptyTick(optionType: "CE" | "PE", strikePrice: number): OptionContractTick {
  return {
    tradingDate: "",
    tickTime: "",
    underlyingSymbol: "",
    expiry: "",
    optionType,
    strikePrice
  };
}

/** Aggregate buyer-momentum vs. seller-safety score across the ATM +/-4 window. */
export function calculateTradeInterpretation(rows: StrikeMovementRow[]): TradeInterpretation {
  return {
    buyerScore: rows.reduce((sum, row) => sum + row.buyerMomentumScore, 0),
    sellerScore: rows.reduce((sum, row) => sum + row.sellerSafetyScore, 0)
  };
}

/**
 * The core "predict market direction" read: combines the pressure gap,
 * PCR, proximity to Max Pain, and proximity to support/resistance into a
 * single bias/readiness/conviction/setup-quality verdict. Previously
 * computed only inside the React dashboard component and therefore
 * untestable and un-callable from anywhere else (including a future
 * strategy engine). Returns raw categorical/numeric fields only —
 * locale-formatted display strings are a presentation concern and belong
 * in the caller (web UI or API response formatter).
 */
export function calculateMarketBias(snapshot: OptionChainSnapshot, pressure: PressureScore): MarketBiasSummary {
  const pressureGap = pressure.bullishPressure - pressure.bearishPressure;
  const absGap = Math.abs(pressureGap);
  const support = pressure.supportZones[0];
  const resistance = pressure.resistanceZones[0];
  const supportDistance = support ? Math.abs(snapshot.spotPrice - support.strikePrice) : undefined;
  const resistanceDistance = resistance ? Math.abs(resistance.strikePrice - snapshot.spotPrice) : undefined;

  const bias: MarketBiasSummary["bias"] = pressureGap >= 6 ? "Bullish" : pressureGap <= -6 ? "Bearish" : "Balanced";
  const readiness: MarketBiasSummary["readiness"] = absGap >= 8 ? "Actionable" : absGap >= 4 ? "Watch" : "Wait";
  const conviction: MarketBiasSummary["conviction"] = absGap >= 20 ? "High" : absGap >= 10 ? "Moderate" : absGap >= 5 ? "Low" : "Neutral";

  const pcr = pressure.pcr;
  const pcrContext: MarketBiasSummary["pcrContext"] =
    pcr === undefined ? undefined : pcr >= 1.25 ? "strong-put-support" : pcr >= 1.05 ? "mild-put-support" : pcr <= 0.75 ? "strong-call-resistance" : pcr <= 0.95 ? "mild-call-resistance" : undefined;

  const maxPain = pressure.maxPain;
  const maxPainDistancePercent = maxPain !== undefined && snapshot.spotPrice > 0 ? (Math.abs(snapshot.spotPrice - maxPain) / snapshot.spotPrice) * 100 : undefined;
  const nearMaxPain = maxPainDistancePercent !== undefined && maxPainDistancePercent <= 1.0;

  let setupScore = 0;
  if (absGap >= 8) setupScore += 2;
  else if (absGap >= 4) setupScore += 1;
  if (pcr !== undefined && (pcr >= 1.1 || pcr <= 0.9)) setupScore += 1;
  if (nearMaxPain) setupScore += 1;
  if (supportDistance !== undefined && supportDistance <= 150) setupScore += 1;
  if (resistanceDistance !== undefined && resistanceDistance <= 150) setupScore += 1;

  const setupQuality: MarketBiasSummary["setupQuality"] =
    setupScore >= 5 ? "A+ Setup" : setupScore >= 4 ? "A Setup" : setupScore >= 3 ? "B Setup" : setupScore >= 2 ? "C Setup" : "No Edge";

  return {
    bias,
    pressureGap,
    absGap,
    readiness,
    conviction,
    setupScore,
    setupQuality,
    pcrContext,
    nearMaxPain,
    maxPainDistancePercent,
    supportDistance,
    resistanceDistance
  };
}

// Below this % move per minute in spot price, we call the market "flat"
// rather than nudging direction one way or the other from noise.
const MARKET_PULSE_FLAT_THRESHOLD_PERCENT_PER_MIN = 0.01;

/** Ordinary least-squares slope of y over x - "how fast y is changing per
 * unit of x" - fit through every point in the window rather than just
 * comparing the first and last sample. This matters here because capture
 * isn't perfectly smooth: a single noisy snapshot (a brief bid/ask jump)
 * would swing a first-vs-last comparison a lot more than it swings a line
 * fit through the whole window. Returns undefined if x has no spread
 * (e.g. every sample landed at the same elapsed-minutes value). */
function linearSlope(x: number[], y: number[]): number | undefined {
  const n = x.length;
  if (n < 2) return undefined;
  const xMean = x.reduce((sum, value) => sum + value, 0) / n;
  const yMean = y.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (x[i] - xMean) * (y[i] - yMean);
    denominator += (x[i] - xMean) ** 2;
  }
  return denominator === 0 ? undefined : numerator / denominator;
}

/**
 * "Market pulse": how fast the market is moving right now, not just where
 * it stands. Takes a chronological window of recent samples - typically
 * the last few minutes of already-captured snapshots, fetched via
 * @option-decode/db#listRecentPressureHistory - and fits a trend line
 * through spot price, net pressure (bullish - bearish), and PCR to get a
 * rate-of-change per minute for each.
 *
 * Deliberately reuses already-persisted PressureScore/snapshot history
 * instead of introducing a new capture cadence or table: the worker
 * already writes a row roughly every 30s, which is plenty of resolution
 * for a per-minute reading. The rate is computed over actual elapsed time
 * between samples (not a fixed assumption of "N samples per minute"),
 * since capture can gap by a few minutes under load.
 *
 * Returns null when there's not enough of a time spread in the window to
 * measure a rate from (fewer than 2 samples, or they all share a
 * timestamp).
 */
export function calculateMarketPulse(points: MarketPulsePoint[]): MarketPulse | null {
  if (points.length < 2) return null;

  const sorted = [...points].sort((left, right) => Date.parse(left.scoreTime) - Date.parse(right.scoreTime));
  const startMs = Date.parse(sorted[0].scoreTime);
  const endMs = Date.parse(sorted[sorted.length - 1].scoreTime);
  const windowMinutes = (endMs - startMs) / 60000;
  if (windowMinutes <= 0) return null;

  const minutesElapsed = sorted.map((point) => (Date.parse(point.scoreTime) - startMs) / 60000);

  const spotRatePerMin = linearSlope(
    minutesElapsed,
    sorted.map((point) => point.spotPrice)
  );
  const startSpot = sorted[0].spotPrice;
  const spotRatePercentPerMin = spotRatePerMin !== undefined && startSpot > 0 ? (spotRatePerMin / startSpot) * 100 : undefined;

  const pressureNetRatePerMin = linearSlope(
    minutesElapsed,
    sorted.map((point) => point.bullishPressure - point.bearishPressure)
  );

  const pcrSamples = sorted.filter((point) => point.pcr !== undefined);
  const pcrRatePerMin =
    pcrSamples.length >= 2
      ? linearSlope(
          pcrSamples.map((point) => (Date.parse(point.scoreTime) - startMs) / 60000),
          pcrSamples.map((point) => point.pcr as number)
        )
      : undefined;

  const direction: MarketPulse["direction"] =
    spotRatePercentPerMin === undefined || Math.abs(spotRatePercentPerMin) < MARKET_PULSE_FLAT_THRESHOLD_PERCENT_PER_MIN ? "flat" : spotRatePercentPerMin > 0 ? "up" : "down";

  return {
    windowMinutes: Math.round(windowMinutes * 10) / 10,
    sampleCount: sorted.length,
    spotRatePerMin,
    spotRatePercentPerMin,
    pressureNetRatePerMin,
    pcrRatePerMin,
    direction
  };
}

// Strike Matrix (WCI / DRC / DRCR) engine — see strike-matrix.ts
export { calculateStrikeMatrix, isTradingHorizon, STRIKE_MATRIX_HORIZONS } from "./strike-matrix.js";

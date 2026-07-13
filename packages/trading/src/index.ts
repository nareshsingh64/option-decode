import type {
  AtmStraddleExpectedMove,
  MarketBiasSummary,
  OptionChainSnapshot,
  OptionType,
  PaperOrderRequest,
  PressureScore,
  PressureZone,
  Recommendation,
  RecommendedSellSetup,
  RecommendedTradeSetup,
  StrikeMovementRow,
  TradeInterpretation,
  TradeTimeframe
} from "@option-decode/types";
import { randomUUID } from "node:crypto";
import { blackScholesDelta, DEFAULT_IMPLIED_VOLATILITY, DEFAULT_RISK_FREE_RATE, getYearsToExpiry, solveBreakevenSpot } from "./option-pricing.ts";

export interface PaperOrder extends PaperOrderRequest {
  id: string;
  status: "PENDING" | "FILLED" | "CANCELLED" | "REJECTED";
  createdAt: string;
}

export function createPaperOrder(request: PaperOrderRequest, now = new Date()): PaperOrder {
  return {
    ...request,
    id: randomUUID(),
    status: "PENDING",
    createdAt: now.toISOString()
  };
}

const CONVICTION_SCORE: Record<MarketBiasSummary["conviction"], number> = {
  High: 70,
  Moderate: 45,
  Low: 25,
  Neutral: 10
};

const SETUP_QUALITY_SCORE: Record<MarketBiasSummary["setupQuality"], number> = {
  "A+ Setup": 90,
  "A Setup": 75,
  "B Setup": 55,
  "C Setup": 40,
  "No Edge": 10
};

const PCR_CONTEXT_TEXT: Record<NonNullable<MarketBiasSummary["pcrContext"]>, string> = {
  "strong-put-support": "strong put support",
  "mild-put-support": "mild put support",
  "strong-call-resistance": "strong call resistance",
  "mild-call-resistance": "mild call resistance"
};

function strike(value: number): string {
  return value.toLocaleString("en-IN");
}

// Stop-loss distance (in premium terms) is clamped to this % band of entry
// premium. Delta-implied distance is only a linear approximation of how the
// premium moves, and gets unreliable at the extremes (deep ITM/OTM strikes,
// or very low-delta far strikes producing a near-zero stop) - the clamp
// keeps the suggested stop within a range that's actually usable as a real
// order price.
const STOP_LOSS_MIN_PERCENT = 0.1;
const STOP_LOSS_MAX_PERCENT = 0.3;
const REWARD_RISK_RATIO = 2;
// Used only when a tick is missing delta (shouldn't normally happen once a
// contract has any trading activity) - a moderate near-the-money default
// rather than skipping the trade setup entirely.
const DEFAULT_DELTA_FALLBACK = 0.4;

function roundToTick(value: number, tickSize = 0.05): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Number((Math.round(value / tickSize) * tickSize).toFixed(2));
}

// The distance between adjacent listed strikes - used as the "one level
// against you" distance for sizing a stop-loss. Falls back to 50 (the
// common NIFTY strike gap) if the chain doesn't have enough strikes to
// measure it, which should only happen with malformed/incomplete snapshot
// data.
function getStrikeInterval(ticks: { strikePrice: number }[]): number {
  const strikes = [...new Set(ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  for (let i = 1; i < strikes.length; i += 1) {
    const diff = strikes[i] - strikes[i - 1];
    if (diff > 0) {
      return diff;
    }
  }
  return 50;
}

/**
 * Turns a directional recommendation's chosen strike into a concrete,
 * tradable entry/stop-loss/target/breakeven - see the RecommendedTradeSetup
 * doc comment in @option-decode/types for the reasoning. Returns undefined
 * when the strike has no live premium to anchor an entry to (e.g. a
 * stale/incomplete snapshot), rather than fabricate a price.
 */
function buildTradeSetup(snapshot: OptionChainSnapshot, optionType: OptionType, strikePrice: number): RecommendedTradeSetup | undefined {
  const tick = snapshot.ticks.find((candidate) => candidate.strikePrice === strikePrice && candidate.optionType === optionType);
  if (!tick?.lastPrice || tick.lastPrice <= 0) {
    return undefined;
  }

  const entryPrice = tick.lastPrice;
  const asOfMs = Date.parse(snapshot.snapshotTime);
  const yearsToExpiry = getYearsToExpiry(snapshot.expiry, Number.isFinite(asOfMs) ? asOfMs : Date.now());
  const volatility = (tick.impliedVolatility ?? DEFAULT_IMPLIED_VOLATILITY * 100) / 100;

  // Prefer the broker feed's own delta; fall back to the Black-Scholes
  // value (computed from the tick's own IV) rather than a flat guess -
  // this only degrades to a flat guess in the very unlikely case that both
  // are unusable (e.g. a malformed spot/strike/vol produces a non-finite
  // result).
  const modelDelta = blackScholesDelta(optionType, snapshot.spotPrice, strikePrice, yearsToExpiry, DEFAULT_RISK_FREE_RATE, volatility);
  const rawDelta = tick.delta ?? modelDelta;
  const delta = Math.abs(Number.isFinite(rawDelta) ? rawDelta : DEFAULT_DELTA_FALLBACK) || DEFAULT_DELTA_FALLBACK;

  const strikeInterval = getStrikeInterval(snapshot.ticks);
  const rawStopDistance = delta * strikeInterval;
  const stopDistance = Math.min(entryPrice * STOP_LOSS_MAX_PERCENT, Math.max(entryPrice * STOP_LOSS_MIN_PERCENT, rawStopDistance));

  const breakevenAtExpiry = optionType === "CE" ? strikePrice + entryPrice : strikePrice - entryPrice;
  const solvedBreakevenToday = solveBreakevenSpot(optionType, strikePrice, entryPrice, yearsToExpiry, DEFAULT_RISK_FREE_RATE, volatility);

  return {
    optionType,
    strike: strikePrice,
    entryPrice: roundToTick(entryPrice),
    stopLoss: roundToTick(Math.max(0.05, entryPrice - stopDistance)),
    target: roundToTick(entryPrice + stopDistance * REWARD_RISK_RATIO),
    riskRewardRatio: REWARD_RISK_RATIO,
    breakevenAtExpiry: roundToTick(Math.max(0.05, breakevenAtExpiry)),
    // Falls back to the at-expiry number if the solver couldn't bracket a
    // root (extreme/degenerate inputs) rather than show nothing.
    breakevenToday: roundToTick(Math.max(0.05, solvedBreakevenToday ?? breakevenAtExpiry))
  };
}

// Per-timeframe delta bands from the Institutional Option Seller's
// Playbook: 0.15-0.20 delta intraday, 0.10-0.15 weekly, 0.05-0.10 (deep OTM)
// monthly. `target` is the band midpoint used to rank candidate strikes
// when several fall inside (or all fall outside) the band.
const SELLER_DELTA_BANDS: Record<TradeTimeframe, { min: number; max: number; target: number }> = {
  intraday: { min: 0.1, max: 0.2, target: 0.175 },
  weekly: { min: 0.1, max: 0.15, target: 0.125 },
  monthly: { min: 0.05, max: 0.1, target: 0.075 }
};

// The playbook's intraday system-stop rule (1.5x-2x premium collected)
// applied as a conservative uniform default across every timeframe, rather
// than a tighter number for weekly/monthly - a wider stop errs toward not
// getting shaken out by ordinary premium noise, which matters more the
// longer the trade is meant to be held.
const SELLER_STOP_LOSS_MULTIPLIER = 1.75;
// The playbook's monthly "IV crush lets you exit at 50-60% profit" rule,
// generalized as the default profit-take across timeframes: buy back once
// the premium has decayed to half of what was collected.
const SELLER_PROFIT_TARGET_PERCENT = 0.5;

// Below this many calendar days to expiry, a chain is read as "intraday"
// (expiry today/tomorrow); below this many days it's "weekly"; otherwise
// "monthly." Mirrors how a trader actually thinks about a given expiry
// cycle - not tied to any particular index's specific expiry weekday, which
// (per the September 2025 SEBI expiry-day rationalization) now differs by
// exchange (Nifty: Tuesday, Sensex: Thursday) and shifts further around
// holidays.
const INTRADAY_MAX_DAYS_TO_EXPIRY = 1;
const WEEKLY_MAX_DAYS_TO_EXPIRY = 8;

/** Classifies how far out a chain's own expiry is into the playbook's three
 * execution timeframes, purely from calendar days - see the constants above
 * for why this is index-agnostic rather than a per-symbol weekday table. */
export function inferSellerTimeframe(daysToExpiry: number): TradeTimeframe {
  if (daysToExpiry <= INTRADAY_MAX_DAYS_TO_EXPIRY) return "intraday";
  if (daysToExpiry <= WEEKLY_MAX_DAYS_TO_EXPIRY) return "weekly";
  return "monthly";
}

/**
 * Finds the OTM strike (CE above spot, PE below spot — writing an ITM
 * strike isn't "selling premium" in the playbook's sense) whose delta sits
 * closest to the given timeframe's target band. Prefers a strike that's
 * BOTH inside the delta band AND beyond `expectedMoveBoundary` when one is
 * supplied (the weekly ATM-straddle expected-move edge) — falling back to
 * delta-band-only, then to closest-available-delta, so the search degrades
 * gracefully on a thin/incomplete chain instead of returning nothing.
 */
function findStrikeByTargetDelta(
  snapshot: OptionChainSnapshot,
  optionType: OptionType,
  timeframe: TradeTimeframe,
  expectedMoveBoundary?: number
): { strike: number; delta: number } | undefined {
  const asOfMs = Date.parse(snapshot.snapshotTime);
  const yearsToExpiry = getYearsToExpiry(snapshot.expiry, Number.isFinite(asOfMs) ? asOfMs : Date.now());
  const band = SELLER_DELTA_BANDS[timeframe];

  const candidates = snapshot.ticks
    .filter((tick) => tick.optionType === optionType)
    .filter((tick) => (optionType === "CE" ? tick.strikePrice > snapshot.spotPrice : tick.strikePrice < snapshot.spotPrice))
    .filter((tick) => tick.lastPrice !== undefined && tick.lastPrice > 0)
    .map((tick) => {
      const volatility = (tick.impliedVolatility ?? DEFAULT_IMPLIED_VOLATILITY * 100) / 100;
      const modelDelta = blackScholesDelta(optionType, snapshot.spotPrice, tick.strikePrice, yearsToExpiry, DEFAULT_RISK_FREE_RATE, volatility);
      const rawDelta = tick.delta ?? modelDelta;
      const delta = Math.abs(Number.isFinite(rawDelta) ? rawDelta : modelDelta);
      return { strike: tick.strikePrice, delta };
    });

  if (!candidates.length) {
    return undefined;
  }

  const inBand = candidates.filter((candidate) => candidate.delta >= band.min && candidate.delta <= band.max);
  let pool = inBand.length ? inBand : candidates;

  if (expectedMoveBoundary !== undefined) {
    const beyondBoundary = pool.filter((candidate) => (optionType === "CE" ? candidate.strike >= expectedMoveBoundary : candidate.strike <= expectedMoveBoundary));
    if (beyondBoundary.length) {
      pool = beyondBoundary;
    }
  }

  return pool.reduce((closest, candidate) => (Math.abs(candidate.delta - band.target) < Math.abs(closest.delta - band.target) ? candidate : closest));
}

/**
 * Seller-side counterpart to buildTradeSetup(): turns a timeframe + option
 * side into a concrete premium-collection setup — strike picked by target
 * delta (optionally constrained beyond a weekly expected-move boundary),
 * stop-loss ABOVE entry at the playbook's 1.5x-2x multiple, and a profit
 * target BELOW entry at the playbook's ~50% decay rule. Mirrors
 * buildTradeSetup's "return undefined rather than fabricate a price" contract
 * when the chosen strike has no live premium.
 */
export function buildSellerTradeSetup(snapshot: OptionChainSnapshot, optionType: OptionType, timeframe: TradeTimeframe, expectedMoveBoundary?: number): RecommendedSellSetup | undefined {
  const match = findStrikeByTargetDelta(snapshot, optionType, timeframe, expectedMoveBoundary);
  if (!match) {
    return undefined;
  }

  const tick = snapshot.ticks.find((candidate) => candidate.strikePrice === match.strike && candidate.optionType === optionType);
  if (!tick?.lastPrice || tick.lastPrice <= 0) {
    return undefined;
  }

  const entryPrice = tick.lastPrice;
  const stopLoss = roundToTick(entryPrice * SELLER_STOP_LOSS_MULTIPLIER);
  const target = roundToTick(Math.max(0.05, entryPrice * (1 - SELLER_PROFIT_TARGET_PERCENT)));
  const riskPerUnit = stopLoss - entryPrice;
  const rewardPerUnit = entryPrice - target;
  const riskRewardRatio = riskPerUnit > 0 ? Number((rewardPerUnit / riskPerUnit).toFixed(2)) : 0;
  const breakevenAtExpiry = optionType === "CE" ? match.strike + entryPrice : match.strike - entryPrice;

  return {
    optionType,
    strike: match.strike,
    timeframe,
    targetDelta: SELLER_DELTA_BANDS[timeframe].target,
    actualDelta: Number(match.delta.toFixed(3)),
    entryPrice: roundToTick(entryPrice),
    stopLoss,
    stopLossMultiplier: SELLER_STOP_LOSS_MULTIPLIER,
    target,
    riskRewardRatio,
    breakevenAtExpiry: roundToTick(Math.max(0.05, breakevenAtExpiry))
  };
}

/** Short rationale clause built from the raw market-bias fields — the
 * server-side equivalent of the "Setup:" banner text the web dashboard
 * builds for display, reused here inside the "setup is actionable"
 * recommendation's explanation. */
function describeSetup(marketBias: MarketBiasSummary, support: PressureZone | undefined, resistance: PressureZone | undefined): string {
  const parts: string[] = [];
  if (marketBias.bias !== "Balanced") parts.push(`${marketBias.bias} pressure (${marketBias.absGap}pt gap)`);
  if (marketBias.pcrContext) parts.push(`PCR signals ${PCR_CONTEXT_TEXT[marketBias.pcrContext]}`);
  if (marketBias.nearMaxPain) parts.push("spot pinning near max pain");
  if (support && marketBias.supportDistance !== undefined && marketBias.supportDistance <= 150) parts.push(`strong support at ${strike(support.strikePrice)}`);
  if (resistance && marketBias.resistanceDistance !== undefined && marketBias.resistanceDistance <= 150) parts.push(`strong resistance at ${strike(resistance.strikePrice)}`);
  return parts.length ? parts.join(", ") : "no single dominant factor, but multiple signals align";
}

/**
 * The "best strategy" engine: turns the already-decoded signals (pressure,
 * market bias, ATM strike movement, buyer/seller interpretation) into a
 * ranked list of actionable trade recommendations. This used to be
 * recomputed client-side in the web dashboard from hand-rolled thresholds
 * with no test coverage — it now lives here so it's the same answer
 * everywhere it's shown, and so the thresholds can eventually be
 * calibrated/tested against real outcomes via the backtest engine.
 */
export function calculateTradeRecommendations(
  snapshot: OptionChainSnapshot,
  pressure: PressureScore,
  marketBias: MarketBiasSummary,
  strikeMovementRows: StrikeMovementRow[],
  tradeInterpretation: TradeInterpretation,
  // Optional: @option-decode/analytics#calculateAtmStraddleExpectedMove's
  // output for this same snapshot. Purely additive - every existing caller
  // that doesn't pass it (including the existing test suite) behaves
  // exactly as before. When supplied and the chain reads as a weekly
  // expiry, it's used to bias seller-side strike selection beyond the
  // market's own expected-move edge, per the playbook's weekly rule.
  atmStraddle?: AtmStraddleExpectedMove
): Recommendation[] {
  const recs: Recommendation[] = [];
  const spot = snapshot.spotPrice;
  const atm = snapshot.atmStrike;
  const maxPain = pressure.maxPain;
  const pcr = pressure.pcr;
  const support = pressure.supportZones[0];
  const resistance = pressure.resistanceZones[0];
  const supportDist = support ? Math.abs(spot - support.strikePrice) : undefined;
  const resistanceDist = resistance ? Math.abs(resistance.strikePrice - spot) : undefined;
  const maxPainDist = maxPain !== undefined ? spot - maxPain : undefined;
  const maxPainDistPct = maxPainDist !== undefined && spot > 0 ? (Math.abs(maxPainDist) / spot) * 100 : undefined;
  const atmRow = strikeMovementRows.find((row) => row.isAtm);
  const totalNetScore = strikeMovementRows.reduce((sum, row) => sum + row.netScore, 0);
  const convictionScore = CONVICTION_SCORE[marketBias.conviction];
  const setupQuality = SETUP_QUALITY_SCORE[marketBias.setupQuality];

  // Same timeframe classification used for every seller-side setup built
  // below, so a "sell here" idea always matches the delta band appropriate
  // to how many days are actually left on this chain's own expiry.
  const asOfMs = Date.parse(snapshot.snapshotTime);
  const daysToExpiry = getYearsToExpiry(snapshot.expiry, Number.isFinite(asOfMs) ? asOfMs : Date.now()) * 365;
  const sellerTimeframe = inferSellerTimeframe(daysToExpiry);
  const weeklyBoundary = sellerTimeframe === "weekly" && atmStraddle ? atmStraddle : undefined;
  const buildSellerLegs = () =>
    [
      buildSellerTradeSetup(snapshot, "PE", sellerTimeframe, weeklyBoundary?.expectedLowerBoundary),
      buildSellerTradeSetup(snapshot, "CE", sellerTimeframe, weeklyBoundary?.expectedUpperBoundary)
    ].filter((setup): setup is NonNullable<typeof setup> => setup !== undefined);

  // 1. DIRECTIONAL BIAS
  if (pressure.bullishPressure >= 55 && pcr !== undefined && pcr >= 1.05 && totalNetScore > 0 && convictionScore >= 45) {
    recs.push({
      id: "bullish-bias",
      category: "direction",
      priority: "high",
      title: "Bullish bias confirmed",
      explanation: `PE writers are defending the market (${pressure.bullishPressure}% support pressure). PCR of ${pcr.toFixed(2)} shows put writers outnumber call writers. ATM strike scores show net upward support of ${totalNetScore.toFixed(0)}.`,
      action: support
        ? `Consider buying CE at or above ${strike(support.strikePrice)} strike. Avoid selling PE below this support level.`
        : "Consider CE buying strategies on dips. Avoid short CE positions against this pressure.",
      confidence: Math.min(95, 55 + convictionScore / 2),
      tradeSetup: buildTradeSetup(snapshot, "CE", support?.strikePrice ?? atm)
    });
  }

  if (pressure.bearishPressure >= 55 && pcr !== undefined && pcr <= 0.95 && totalNetScore < 0 && convictionScore >= 45) {
    recs.push({
      id: "bearish-bias",
      category: "direction",
      priority: "high",
      title: "Bearish bias confirmed",
      explanation: `CE writers are capping the market (${pressure.bearishPressure}% resistance pressure). PCR of ${pcr.toFixed(2)} shows call writers outnumber put writers. ATM strike scores show net downward resistance of ${Math.abs(totalNetScore).toFixed(0)}.`,
      action: resistance
        ? `Consider buying PE at or below ${strike(resistance.strikePrice)} strike. Avoid selling CE above this resistance.`
        : "Consider PE buying strategies on rallies. Avoid short PE positions against this resistance.",
      confidence: Math.min(95, 55 + convictionScore / 2),
      tradeSetup: buildTradeSetup(snapshot, "PE", resistance?.strikePrice ?? atm)
    });
  }

  if (Math.abs(pressure.bullishPressure - pressure.bearishPressure) < 8 && (pcr === undefined || (pcr >= 0.9 && pcr <= 1.1))) {
    const sellSetups = buildSellerLegs();
    recs.push({
      id: "balanced-market",
      category: "direction",
      priority: "low",
      title: "Market is range-bound near ATM",
      explanation: `Bullish and bearish pressure are balanced (${pressure.bullishPressure}% vs ${pressure.bearishPressure}%). PCR of ${pcr?.toFixed(2) ?? "--"} shows no strong conviction either way.`,
      action: sellSetups.length
        ? `This is a good environment for option sellers. Consider a short strangle: ${sellSetups.map((setup) => `${setup.strike} ${setup.optionType} for ~${setup.entryPrice}`).join(" + ")} (${sellerTimeframe} delta band). Avoid directional long option trades until bias develops.`
        : "This is a good environment for option sellers. Consider selling straddles or strangles near ATM. Avoid directional long option trades until bias develops.",
      confidence: 65,
      sellSetups: sellSetups.length ? sellSetups : undefined
    });
  }

  // 2. MAX PAIN
  if (maxPainDist !== undefined && maxPainDistPct !== undefined && maxPain !== undefined) {
    if (maxPainDistPct <= 0.5) {
      recs.push({
        id: "at-max-pain",
        category: "strategy",
        priority: "high",
        title: "Spot is pinned at Max Pain",
        explanation: `Spot (${strike(spot)}) is within ${Math.abs(maxPainDist).toFixed(0)} pts of Max Pain (${strike(maxPain)}). Option writers have maximum incentive to keep spot here into expiry.`,
        action: "Avoid buying ATM options — time decay will hurt both CE and PE buyers. Option sellers can short straddle near Max Pain. If you must buy, go at least 1-2 strikes away from Max Pain.",
        confidence: 80
      });
    } else if (maxPainDistPct <= 1.5) {
      const direction = maxPainDist > 0 ? "downward" : "upward";
      recs.push({
        id: "near-max-pain",
        category: "strategy",
        priority: "medium",
        title: `Max Pain pull — expect ${direction} drift`,
        explanation: `Spot is ${Math.abs(maxPainDist).toFixed(0)} pts ${maxPainDist > 0 ? "above" : "below"} Max Pain (${strike(maxPain)}). Option writers typically push spot toward max pain into expiry.`,
        action: `Watch for ${direction} drift toward ${strike(maxPain)}. ${maxPainDist > 0 ? "Avoid long CE — consider PE buying or CE selling." : "Avoid long PE — consider CE buying or PE selling."}`,
        confidence: 65
      });
    }
  }

  // 3. SUPPORT / RESISTANCE
  if (supportDist !== undefined && support && supportDist <= 80) {
    recs.push({
      id: "near-support",
      category: "strategy",
      priority: "high",
      title: `Strong support at ${strike(support.strikePrice)}`,
      explanation: `Spot is only ${supportDist.toFixed(0)} pts above major PE support at ${strike(support.strikePrice)} (score: ${strike(support.score)} lots). PE writers are actively defending this level.`,
      action: `Buy CE at or near ${strike(support.strikePrice)} for a bounce trade. Stop loss below ${strike(support.strikePrice)}. Avoid shorting CE here.`,
      confidence: 75,
      tradeSetup: buildTradeSetup(snapshot, "CE", support.strikePrice)
    });
  }

  if (resistanceDist !== undefined && resistance && resistanceDist <= 80) {
    recs.push({
      id: "near-resistance",
      category: "strategy",
      priority: "high",
      title: `Strong resistance at ${strike(resistance.strikePrice)}`,
      explanation: `Spot is only ${resistanceDist.toFixed(0)} pts below major CE resistance at ${strike(resistance.strikePrice)} (score: ${strike(resistance.score)} lots). Heavy call writing is capping upside.`,
      action: `Buy PE near ${strike(resistance.strikePrice)} for a rejection trade. Stop loss above ${strike(resistance.strikePrice)}. Avoid buying CE unless resistance breaks on volume.`,
      confidence: 75,
      tradeSetup: buildTradeSetup(snapshot, "PE", resistance.strikePrice)
    });
  }

  // 4. BUYER vs SELLER
  if (tradeInterpretation.buyerScore >= 12) {
    recs.push({
      id: "buyer-momentum",
      category: "strategy",
      priority: "medium",
      title: "Option buyers have momentum",
      explanation: `Buyer momentum score is +${tradeInterpretation.buyerScore.toFixed(0)} across ATM strikes. Long buildup is outpacing writing near ATM.`,
      action: `Favour buying options over selling. ${marketBias.bias === "Bullish" ? "CE buying is the higher-probability trade." : marketBias.bias === "Bearish" ? "PE buying is the higher-probability trade." : "Wait for directional bias before buying."}`,
      confidence: 68
    });
  }

  if (tradeInterpretation.sellerScore >= 12) {
    const sellSetups = buildSellerLegs();
    const legsText = sellSetups.map((setup) => `${setup.strike} ${setup.optionType} @ ~${setup.entryPrice} (SL ${setup.stopLoss})`).join(" + ");
    recs.push({
      id: "seller-safety",
      category: "strategy",
      priority: "medium",
      title: "Safe environment for option sellers",
      explanation: `Seller safety score is +${tradeInterpretation.sellerScore.toFixed(0)} across ATM strikes. Writing dominates near ATM — sellers are well-positioned.`,
      action: sellSetups.length
        ? `Option selling strategies have better edge now. ${sellerTimeframe} delta-band setup: ${legsText}. ${support && resistance ? `OI range: ${strike(support.strikePrice)} PE to ${strike(resistance.strikePrice)} CE.` : ""}`
        : `Option selling strategies have better edge now. Consider short straddle, strangle, or credit spreads near ATM. ${support && resistance ? `Range: ${strike(support.strikePrice)} PE to ${strike(resistance.strikePrice)} CE.` : ""}`,
      confidence: 68,
      sellSetups: sellSetups.length ? sellSetups : undefined
    });
  }

  // 5. TIMING
  if (marketBias.readiness === "Wait" || setupQuality < 40) {
    recs.push({
      id: "wait-for-setup",
      category: "timing",
      priority: "medium",
      title: "No clean setup — wait for clarity",
      explanation: `Setup quality is ${marketBias.setupQuality} and market conviction is ${marketBias.conviction}. Entering now means accepting unnecessary uncertainty.`,
      action: "Wait for: (1) PCR moving clearly above 1.15 or below 0.85, (2) pressure bias of 60%+, or (3) spot approaching a clear support/resistance level. These are your entry triggers.",
      confidence: 70
    });
  }

  if (marketBias.readiness === "Actionable" && setupQuality >= 70) {
    recs.push({
      id: "setup-ready",
      category: "timing",
      priority: "high",
      title: "Setup is actionable — conditions aligned",
      explanation: `Setup quality is ${marketBias.setupQuality} with ${marketBias.conviction} conviction (${describeSetup(marketBias, support, resistance)}).`,
      action: "Good time to execute your planned trade. Size with defined risk — use support/resistance as stop loss reference. Don't chase — wait for your entry level.",
      confidence: 78
    });
  }

  // 6. AVOID
  if (atmRow && Math.abs(atmRow.netScore) < 5 && convictionScore < 30) {
    recs.push({
      id: "avoid-atm-options",
      category: "avoid",
      priority: "medium",
      title: "ATM options are dangerous to buy now",
      explanation: `ATM strike ${strike(atm)} shows very low net score (${atmRow.netScore.toFixed(0)}) and market conviction is ${marketBias.conviction}. Buying ATM in a low-conviction market means paying full premium for a coin-flip direction.`,
      action: "Use defined-risk spreads (bull call spread or bear put spread) instead of naked ATM options. This limits theta decay exposure.",
      confidence: 72
    });
  }

  return recs
    .sort((a, b) => {
      const order: Record<Recommendation["priority"], number> = { high: 0, medium: 1, low: 2 };
      return order[a.priority] !== order[b.priority] ? order[a.priority] - order[b.priority] : b.confidence - a.confidence;
    })
    .slice(0, 5);
}

export type OptionType = "CE" | "PE";

export type UnderlyingSymbol = "NIFTY" | "BANKNIFTY" | "SENSEX" | string;

export interface UnderlyingDefinition {
  key: string;
  symbol: UnderlyingSymbol;
  displayName: string;
  securityId: number;
  segment: string;
  lotSize: number;
  quoteSecurityId?: number;
  quoteSegment?: string;
}

export interface OptionContractTick {
  tradingDate: string;
  tickTime: string;
  underlyingSymbol: UnderlyingSymbol;
  expiry: string;
  optionType: OptionType;
  strikePrice: number;
  securityId?: string;
  lotSize?: number;
  lastPrice?: number;
  lastPriceChange?: number;
  lastPriceChangePercent?: number;
  bidPrice?: number;
  askPrice?: number;
  volume?: number;
  openInterest?: number;
  // Day-level change vs the previous trading day's close (as reported by
  // the exchange/broker feed) - the conventional "today's OI change"
  // figure. Barely moves poll to poll within a session, so it's the right
  // input for day-cumulative reads (support/resistance zone strength) but
  // the wrong one for anything meant to represent live movement.
  changeInOpenInterest?: number;
  // Change since TODAY's own market open (undefined only until the
  // session's first snapshot exists). Distinct from
  // changeInOpenInterest/lastPriceChangePercent above, which compare
  // against the PREVIOUS day's close - mixing that day-over-day figure
  // into a "movement" calculation made the Strike Movement trend arrow
  // stay pointing one way for most of a session. Also deliberately not a
  // short rolling window (single-poll or a few minutes) - both were tried
  // and were mostly bid/ask noise, flipping every strike in the ATM +/-4
  // window in lockstep with no real change in activity. Anchoring to
  // session open means the reference point never moves during the day, so
  // this reflects genuine day-so-far drift and builds progressively
  // through the session instead of flickering or staying static.
  sessionOiChange?: number;
  sessionPriceChangePercent?: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

export interface OptionChainSnapshot {
  tradingDate: string;
  snapshotTime: string;
  underlyingSymbol: UnderlyingSymbol;
  expiry: string;
  spotPrice: number;
  atmStrike: number;
  ticks: OptionContractTick[];
}

export interface PressureZone {
  strikePrice: number;
  score: number;
  reason: string;
  // Premium-adjusted "true" defense line, per the institutional playbook:
  // a writer's real breakeven isn't the bare strike, it's the strike offset
  // by the premium they collected. `premium` is the live LTP of the option
  // that anchors this zone (the same tick the zone's strike/score came
  // from); `trueZone` is strike + premium for a resistance (CE) zone, or
  // strike - premium for a support (PE) zone. Both are undefined when the
  // anchoring tick has no live premium to derive them from.
  premium?: number;
  trueZone?: number;
  // Alternative, more rigorous defense line: instead of `premium` (a single
  // point-in-time LTP), this is the open-interest-weighted average price
  // this strike's OI was actually written at, derived from historical
  // tick-by-tick OI buildup (Σ price × ΔOI at each buildup event ÷ ΣΔOI).
  // Deliberately kept alongside `premium`/`trueZone` rather than replacing
  // them - the two answer different questions ("what would it cost to
  // write this right now" vs "what did the open interest actually get
  // sold for, on average"). Undefined when there's no OI-buildup history
  // to derive it from (e.g. a freshly-listed contract). Doesn't account
  // for OI unwinds, since exchanges don't publish which price-level lots
  // got closed when open interest drops - a standard approximation shared
  // by essentially every tool doing this kind of calculation.
  avgSellPrice?: number;
  weightedTrueZone?: number;
  weightedSampleOi?: number;
}

export interface PressureScore {
  bullishPressure: number;
  bearishPressure: number;
  supportZones: PressureZone[];
  resistanceZones: PressureZone[];
  pcr?: number;
  maxPain?: number;
}

export type MarketAlertSeverity = "info" | "warning" | "critical";

export interface MarketAlert {
  id: string;
  severity: MarketAlertSeverity;
  title: string;
  message: string;
  metric: string;
  createdAt: string;
}

export interface AlertThresholdConfig {
  proximityPoints?: number;
  pcrUpper?: number;
  pcrLower?: number;
  pressureWarning?: number;
  pressureCritical?: number;
}

export type OptionActivityKind = "LONG_BUILDUP" | "WRITING" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL";

export type OiBreadth = "Put Support" | "Call Resistance" | "Balanced";

export interface ChainStats {
  totalCeOi: number;
  totalPeOi: number;
  totalCeChange: number;
  totalPeChange: number;
  breadth: OiBreadth;
  maxOiStrike?: number;
  maxOiOptionType?: OptionType;
  maxOiValue?: number;
}

export interface StrikeMovementRow {
  strike: number;
  isAtm: boolean;
  distance: number;
  peScore: number;
  ceScore: number;
  netScore: number;
  netScorePercent: number;
  trendScore: number;
  trendDirection: -1 | 0 | 1;
  bias: "Balanced" | "Up / support" | "Down / resistance";
  trend: "Increasing support" | "Increasing resistance" | "Flat";
  ceActivity: OptionActivityKind;
  peActivity: OptionActivityKind;
  buyerMomentumScore: number;
  sellerSafetyScore: number;
}

export interface TradeInterpretation {
  buyerScore: number;
  sellerScore: number;
}

export type MarketBias = "Bullish" | "Bearish" | "Balanced";
export type TradeReadiness = "Actionable" | "Watch" | "Wait";
export type MarketConviction = "High" | "Moderate" | "Low" | "Neutral";
export type SetupQuality = "A+ Setup" | "A Setup" | "B Setup" | "C Setup" | "No Edge";
export type PcrContext = "strong-put-support" | "mild-put-support" | "strong-call-resistance" | "mild-call-resistance";

export interface MarketBiasSummary {
  bias: MarketBias;
  pressureGap: number;
  absGap: number;
  readiness: TradeReadiness;
  conviction: MarketConviction;
  setupScore: number;
  setupQuality: SetupQuality;
  pcrContext?: PcrContext;
  nearMaxPain: boolean;
  maxPainDistancePercent?: number;
  supportDistance?: number;
  resistanceDistance?: number;
}

export type RecommendationCategory = "direction" | "strategy" | "timing" | "avoid";
export type RecommendationPriority = "high" | "medium" | "low";

// A concrete, tradable version of a recommendation's strike-level guidance:
// which instrument, at what premium, with a stop-loss and target already
// computed. See @option-decode/trading#buildTradeSetup for how these are
// derived (strike-width-through-delta stop distance, 2:1 reward:risk
// target) - it's a heuristic sized for a paper-trading dashboard, not a
// pricing model, so treat it as a starting point rather than gospel.
export interface RecommendedTradeSetup {
  optionType: OptionType;
  strike: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  riskRewardRatio: number;
  // Underlying spot level at which P&L = 0 if held to expiry: the textbook
  // strike ± premium number every broker quotes.
  breakevenAtExpiry: number;
  // Underlying spot level at which P&L = 0 RIGHT NOW, i.e. accounting for
  // the time value still left in the premium — computed via a Black-Scholes
  // model (see @option-decode/trading/option-pricing). Always a smaller
  // required move than breakevenAtExpiry while time remains, since time
  // value covers part of the distance; converges to breakevenAtExpiry as
  // expiry approaches.
  breakevenToday: number;
}

// Which execution timeframe a seller-side setup was sized for — determines
// which delta band (and therefore which strike) buildSellerTradeSetup picks.
// See the Institutional Option Seller's Playbook: 0.15-0.20 delta intraday,
// 0.10-0.15 delta weekly, 0.05-0.10 delta monthly.
export type TradeTimeframe = "intraday" | "weekly" | "monthly";

// The seller-side counterpart to RecommendedTradeSetup. Where the buy-side
// setup answers "what do I pay and where's my stop," this answers the
// mirror-image question for someone writing (selling) the option: what
// premium do I collect, and at what premium do I buy it back for a loss
// (stopLoss, ABOVE entry) or a profit (target, BELOW entry). See
// @option-decode/trading#buildSellerTradeSetup for the derivation — strike
// chosen by nearest-to-target delta for the given timeframe, stop-loss sized
// at the playbook's 1.5x-2x collected-premium multiple, target sized at the
// playbook's ~50% profit-take rule.
export interface RecommendedSellSetup {
  optionType: OptionType;
  strike: number;
  timeframe: TradeTimeframe;
  // The delta band's target value for this timeframe (e.g. 0.125 for
  // weekly) — what the strike search was aiming for.
  targetDelta: number;
  // The selected strike's actual |delta| (broker feed if present, else the
  // Black-Scholes fallback) — may differ from targetDelta when the chain's
  // strike spacing doesn't land exactly on the target.
  actualDelta: number;
  // Premium collected at entry (the option's LTP when written).
  entryPrice: number;
  // Buy-back price that closes the trade at a defined loss — always ABOVE
  // entryPrice for a short option, unlike the buy-side stopLoss which sits
  // below entry.
  stopLoss: number;
  // The multiple of entryPrice used to size stopLoss (1.5-2x per the
  // playbook's intraday system-stop rule, applied uniformly across
  // timeframes as a conservative default).
  stopLossMultiplier: number;
  // Buy-back price that closes the trade at a defined profit — BELOW
  // entryPrice, reflecting the playbook's "buy back at ~50% of collected
  // premium" theta-decay exit rule.
  target: number;
  riskRewardRatio: number;
  // Underlying spot level at which the short option is exactly break-even
  // at expiry: strike + premium collected for a CE, strike - premium for a
  // PE — the same "true zone" math as PressureZone.trueZone.
  breakevenAtExpiry: number;
}

export interface Recommendation {
  id: string;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  title: string;
  explanation: string;
  action: string;
  confidence: number;
  // Buy-side setup — unchanged, still populated exactly as before for every
  // recommendation that suggests buying a CE/PE.
  tradeSetup?: RecommendedTradeSetup;
  // Seller-side setup(s) — additive. One entry for a single-leg write
  // (e.g. "sell this PE"), two for a strangle-style two-leg recommendation
  // (one CE + one PE). Never populated on the same recommendation as
  // tradeSetup — a given recommendation is either a buy idea or a sell
  // idea, matching its own action text.
  sellSetups?: RecommendedSellSetup[];
}

export interface MarketPulsePoint {
  scoreTime: string;
  spotPrice: number;
  bullishPressure: number;
  bearishPressure: number;
  pcr?: number;
}

export type MarketPulseDirection = "up" | "down" | "flat";

export interface MarketPulse {
  windowMinutes: number;
  sampleCount: number;
  spotRatePerMin?: number;
  spotRatePercentPerMin?: number;
  pressureNetRatePerMin?: number;
  pcrRatePerMin?: number;
  direction: MarketPulseDirection;
}

// The playbook's literal "ATM Straddle Rule": ATM Call LTP + ATM Put LTP is
// the market's own expected move for the current expiry cycle. Distinct
// from the India-VIX-derived expected-move band already used elsewhere in
// this codebase (see apps/web's buildVixStrikeRange) — that's a legitimate
// alternative (annualized-IV-implied) calculation, but it isn't what the
// playbook means by "expected move," so it's kept as its own field rather
// than folded into or replacing the VIX band.
export interface AtmStraddleExpectedMove {
  atmStrike: number;
  atmCallPrice: number;
  atmPutPrice: number;
  atmStraddlePrice: number;
  expectedUpperBoundary: number;
  expectedLowerBoundary: number;
}

// --- Strike Matrix (Strikes Movement Design & Decision Matrix) ---
// WCI = OI Change / Volume; DRC = OI Change × Delta (signed);
// DRCR = Σ|DRC| puts / Σ|DRC| calls. See docs/New Dashboard ver 1.0.

export type TradingHorizon = "intraday" | "weekly" | "monthly";

// DRCR bands: Bullish > 1.5, Neutral 0.8–1.2, Bearish < 0.6. Readings in
// the gaps (0.6–0.8, 1.2–1.5) are deliberately "Transitional" rather than
// force-fitted into a tradable bias.
export type StrikeMatrixBias = "Bullish" | "Neutral" | "Bearish" | "Transitional";

export interface StrikeMatrixRow {
  optionType: OptionType;
  strikePrice: number;
  // undefined only if the tick genuinely has no last-traded price yet
  // (e.g. a strike that hasn't traded this session).
  lastPrice?: number;
  delta: number;
  volume: number;
  oiChange: number;
  openInterest: number;
  // undefined when the strike traded zero volume (WCI is a ratio over volume)
  wci?: number;
  drc: number;
}

export interface StrikeMatrixWall {
  optionType: OptionType;
  strikePrice: number;
  wci: number;
  meetsThreshold: boolean;
  delta: number;
  oiChange: number;
  volume: number;
}

export interface StrikeMatrixRecommendation {
  structure: string;
  targetDelta: number;
  // Execution strikes closest to ±targetDelta inside the active universe.
  // Only the side(s) the structure actually writes are populated.
  callStrike?: number;
  callStrikeDelta?: number;
  putStrike?: number;
  putStrikeDelta?: number;
  theoreticalPop: number;
  note: string;
}

export interface StrikeMatrixAnalysis {
  horizon: TradingHorizon;
  deltaMin: number;
  deltaMax: number;
  wciThreshold: number;
  targetDelta: number;
  // Active universe S: strikes whose |delta| falls inside the horizon band
  universe: StrikeMatrixRow[];
  putDrcTotal: number;
  callDrcTotal: number;
  // undefined when the call side has zero aggregate |DRC| (division guard)
  drcr?: number;
  bias: StrikeMatrixBias;
  callWall?: StrikeMatrixWall;
  putWall?: StrikeMatrixWall;
  recommendation?: StrikeMatrixRecommendation;
  riskRule: string;
}

export interface PaperOrderRequest {
  userId: string;
  underlyingSymbol: UnderlyingSymbol;
  expiry: string;
  action: "BUY" | "SELL";
  optionType: OptionType;
  strikePrice: number;
  quantity: number;
  requestedPrice: number;
  stopLoss: number;
  targetPrice: number;
  strategyName: string;
}

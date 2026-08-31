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
  // The multiple of entryPrice used to size stopLoss — varies by timeframe
  // (see SELLER_RISK_PROFILES in @option-decode/trading): tighter near
  // expiry where gamma risk is sharpest, wider on longer-dated writes that
  // need room to ride out ordinary premium noise.
  stopLossMultiplier: number;
  // Buy-back price that closes the trade at a defined profit — BELOW
  // entryPrice, reflecting the playbook's theta-decay exit rule.
  target: number;
  // Reward-to-risk on this setup. Deliberately below 1 for most
  // premium-selling setups — that is the structure of the strategy, not a
  // defect: a short option wins often and loses bigger occasionally. Read
  // it together with probabilityOfProfit below rather than against a
  // directional-buying R:R minimum.
  riskRewardRatio: number;
  // Approximate probability the short option expires worthless, derived
  // from the selected strike's own |delta| (delta approximates the
  // risk-neutral probability of finishing ITM, so POP ≈ 1 - |delta|).
  // Expressed 0-100.
  probabilityOfProfit: number;
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

// Where today's ATM implied volatility sits inside its own recent range -
// the first question before either selling or buying premium, and something
// the Option Chain tab had no way to answer.
//
// Deliberately a PERCENTILE (share of past days below today) rather than the
// more common IV Rank formula, (current - low) / (high - low). Rank is
// hostage to a single bad print: on real NIFTY history a stray 2.71% reading
// on 2026-07-14, against 8.19-11.65% on every other day, moved IV Rank from
// 2 to 62 while the percentile moved only 8 to 14. With a short, feed-quality
// -dependent history, the robust measure is the honest one.
export interface AtmIvPercentile {
  // 0-100. Share of the sampled days whose ATM call IV was below today's.
  percentile: number;
  current: number;
  low: number;
  high: number;
  // How many trading days actually contributed. Retention and feed gaps mean
  // this is routinely well short of the requested lookback - production held
  // 15 days against a 25-day request - so it is reported rather than implied.
  sampleDays: number;
  // False when too few days exist for the percentile to mean anything. The
  // UI shows the cell as unavailable instead of printing a confident number
  // derived from a handful of prints.
  sufficient: boolean;
}

// --- Strike Matrix (Strikes Movement Design & Decision Matrix) ---
// WCI = OI Change / Volume; DRC = OI Change × Delta (signed);
// DRCR = Σ|DRC| puts / Σ|DRC| calls. See docs/New Dashboard ver 1.0.

export type TradingHorizon = "intraday" | "weekly" | "monthly";

// DRCR bands: Bullish > 1.5, Neutral 0.8–1.2, Bearish < 0.6. Readings in
// the gaps (0.6–0.8, 1.2–1.5) are deliberately "Transitional" rather than
// force-fitted into a tradable bias.
export type StrikeMatrixBias = "Bullish" | "Neutral" | "Bearish" | "Transitional";

// The single definition of the DRCR bias-band boundaries. These were
// previously written out independently in three places - the Strike Matrix
// engine's classifyDrcr, the Sim scorecard's regime column, and the UI's
// band caption - with nothing keeping them in sync, so changing one
// silently diverged from the others.
//
// Lives here rather than in @option-decode/analytics because the web app
// needs the numbers for display text but cannot import that package:
// analytics uses .js-extension ESM specifiers that tsx resolves and
// webpack does not. This package is already a dependency of every
// consumer, and is a single file with no internal imports, so it bundles
// cleanly. Use classifyDrcr from @option-decode/analytics to CLASSIFY a
// value; these constants are for rendering the boundaries themselves.
// Market session windows, as IST minutes since midnight. Single source of
// truth for "is the market open" and for "when does a contract expire" -
// both were previously retyped in five places (isMarketSessionOpen in
// @option-decode/utils, getYearsToExpiry in @option-decode/trading,
// getCalendarDaysToExpiry in @option-decode/analytics, the option-chain
// builders in apps/web, and a log string in the worker), so a timing change
// could be applied to some and missed in others.
//
// NSE moved to **09:14-15:41 IST** (from 09:15-15:30); MCX is unchanged.
// Lives here rather than in @option-decode/utils because utils has no
// dependencies at all and apps/web already imports runtime constants from
// this package - see the DRCR_BANDS comment below for the same reasoning.
export const NSE_SESSION_OPEN_IST_MINUTES = 9 * 60 + 14;
export const NSE_SESSION_CLOSE_IST_MINUTES = 15 * 60 + 41;
export const MCX_SESSION_OPEN_IST_MINUTES = 9 * 60;
export const MCX_SESSION_CLOSE_IST_MINUTES = 23 * 60 + 30;

// The same NSE close expressed in UTC, for expiry-moment math: contracts
// expire at the close, not at midnight, and using midnight overstates time
// value by up to a full trading day on expiry day itself. IST is UTC+5:30,
// so 15:41 IST = 10:11 UTC. Note this is no longer a whole hour - anything
// building an expiry timestamp must carry the minutes too.
export const NSE_CLOSE_UTC_HOUR = 10;
export const NSE_CLOSE_UTC_MINUTE = 11;

/**
 * Underlyings that trade on MCX rather than NSE/BSE.
 *
 * Kept here beside the session constants because the only reason to know which
 * exchange a symbol belongs to is to pick the right session times, and a
 * separate copy of this list somewhere else would be a fact that can disagree
 * with itself.
 */
export const MCX_UNDERLYINGS: ReadonlySet<string> = new Set(["CRUDEOIL", "NATURALGAS", "COPPER", "SILVER"]);

/**
 * When this underlying's session ends, in IST minutes past midnight.
 *
 * The difference is not cosmetic: NSE closes 15:41 while MCX runs to 23:30,
 * nearly eight hours later. Anything that asks "has this contract finished
 * trading today" and assumes the NSE close will be wrong about every commodity
 * for most of the evening - which is exactly how two expired CRUDEOIL trades
 * sat OPEN for a day (see the settlement note in sim-repository).
 */
export function getSessionCloseIstMinutes(underlyingSymbol: string): number {
  return MCX_UNDERLYINGS.has(underlyingSymbol.toUpperCase())
    ? MCX_SESSION_CLOSE_IST_MINUTES
    : NSE_SESSION_CLOSE_IST_MINUTES;
}

/** IST is UTC+5:30. */
export const IST_OFFSET_MINUTES = 330;

/**
 * The instant a contract stops trading on its expiry day.
 *
 * `expiryDate` is a Prisma `@db.Date` (or a plain `YYYY-MM-DD` label), so it
 * arrives as UTC midnight of the expiry day. Adding the underlying's own
 * session close - NSE 15:41, MCX 23:30 - gives the moment the contract is
 * actually dead.
 *
 * This replaced `expiryDate + 24 hours`, which was wrong in both directions
 * and cost a full day of stale state. Because expiryDate is UTC midnight, that
 * rule did not come true until 00:00 UTC the day AFTER expiry - and the only
 * job that acts on it runs at 15:45 IST, so an expired position stayed OPEN,
 * with its margin still counted, for roughly 24 hours. A Friday expiry waited
 * until Monday, because the job is weekdays-only. Seen live: two CRUDEOIL
 * trades that expired 2026-08-17 settled at 15:45 on 2026-08-18, both ITM, so
 * a real loss sat unrealised the whole time.
 *
 * The 24 hours was a blunt guard against settling before the contract had
 * finished trading, and it existed because ONE NSE-shaped schedule was being
 * applied to MCX contracts too: the 15:45 IST job runs four minutes after the
 * NSE close but nearly eight hours before MCX's 23:30. Asking each contract
 * for its own session close is the honest version of that guard.
 *
 * Lives here rather than in a repository because it is not only settlement's
 * business: anything that asks Dhan for a chain needs the same answer, and a
 * second copy of this rule is a fact that can disagree with itself.
 */
export function expirySettlementMoment(expiryDate: Date | string, underlyingSymbol: string): Date | null {
  const expiryUtcMidnight = typeof expiryDate === "string" ? parseExpiryLabel(expiryDate) : expiryDate;
  if (!expiryUtcMidnight || Number.isNaN(expiryUtcMidnight.getTime())) {
    return null;
  }
  const closeIst = getSessionCloseIstMinutes(underlyingSymbol);
  return new Date(expiryUtcMidnight.getTime() + (closeIst - IST_OFFSET_MINUTES) * 60_000);
}

/**
 * True once the contract has finished trading on its expiry day.
 *
 * Fails OPEN - an unparseable expiry reads as "not expired". The callers here
 * either settle a position or stop fetching its live data, and both of those
 * are worse to do wrongly to a live contract than to skip on a dead one.
 */
export function hasContractExpired(expiryDate: Date | string, underlyingSymbol: string, asOf: Date = new Date()): boolean {
  const settlementMoment = expirySettlementMoment(expiryDate, underlyingSymbol);
  return settlementMoment !== null && asOf.getTime() >= settlementMoment.getTime();
}

/** `YYYY-MM-DD` (the `expiryLabel` shape) to UTC midnight; null if it isn't that shape. */
function parseExpiryLabel(label: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    return null;
  }
  const parsed = new Date(`${label}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const DRCR_BANDS = {
  bullishAbove: 1.5,
  bearishBelow: 0.6,
  neutralFrom: 0.8,
  neutralTo: 1.2
} as const;

/**
 * Contract lot sizes, used ONLY as a fallback when the real value is not
 * available from the feed tick or from `FnoLotSize`. Prefer the stored value
 * every time: exchanges revise lot sizes periodically, so a constant is a
 * snapshot with an expiry date on it.
 *
 * This table existed as SIX hand-maintained copies - three in packages/db
 * (market/paper/sim repositories) and three in apps/web (dashboard
 * formatters, strike-pressure analytics, option-chain builders) - carrying a
 * "keep in sync" comment and no mechanism to enforce it. They happened to
 * agree when this was consolidated; the point is that nothing made them.
 *
 * NIFTY IS 65 HERE, NOT 75. 75 is the number everyone reaches for and it is
 * wrong for this data - verified against `OptionContract.lotSize` (1,878
 * NIFTY rows, all 65) and `FnoLotSize` across four contract months. A wrong
 * lot size does not fail loudly; it silently rescales every rupee figure and
 * every rupees-to-points cost conversion.
 */
export const FALLBACK_LOT_SIZES: Readonly<Record<string, number>> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
  NIFTYNXT50: 25,
  SENSEX: 20,
  BANKEX: 30,
  CRUDEOIL: 100,
  NATURALGAS: 1250,
  COPPER: 2500,
  SILVER: 30
};

/**
 * Fallback lot size for an underlying, or 1 when it is unknown.
 *
 * The 1 is deliberate and load-bearing: it makes a miss show up as a position
 * sized at a single unit - every P&L rounding towards zero - rather than as a
 * plausible-looking figure computed from someone else's contract.
 */
export function getFallbackLotSize(underlyingSymbol: string | null | undefined): number {
  return FALLBACK_LOT_SIZES[String(underlyingSymbol ?? "").toUpperCase()] ?? 1;
}

/**
 * The `quantity` a Dhan order/margin request must carry for this underlying.
 *
 * NSE and BSE want CONTRACTS (lots x lot size). MCX wants LOTS. This is not a
 * guess - measured against the live margin calculator on 2026-08-30, linear
 * across three points on CRUDEOIL (lot 100):
 *
 *   quantity 1   -> Rs   2,49,675
 *   quantity 2   -> Rs   4,99,350
 *   quantity 100 -> Rs 2,49,67,500
 *
 * while BANKNIFTY quantity 30 priced as exactly one lot of 30 (leverage 9.78 x
 * Rs 1,78,392 = Rs 17.4L = 58,000 x 30).
 *
 * So the obvious formula - lots * lotSize, correct everywhere else in this repo
 * - sends an MCX order ONE HUNDRED TIMES too large. It does not error. It fills.
 * Dhan's own portfolio guidance hints at this ("use the multiplier, not lot
 * size, for MCX_COMM") and this is what that means at the order layer.
 *
 * Never compute an order quantity inline. Call this.
 */
export function toBrokerQuantity(underlyingSymbol: string, lots: number): number {
  if (!Number.isInteger(lots) || lots <= 0) {
    throw new Error(`toBrokerQuantity needs a positive whole number of lots, got ${lots}`);
  }
  if (MCX_UNDERLYINGS.has(String(underlyingSymbol ?? "").toUpperCase())) {
    return lots;
  }
  return lots * getFallbackLotSize(underlyingSymbol);
}

/**
 * Inverse of {@link toBrokerQuantity} - what a broker-reported quantity means
 * in lots. Needed when reconciling against Dhan's own position/order book,
 * which reports in whatever unit that exchange uses.
 */
export function fromBrokerQuantity(underlyingSymbol: string, quantity: number): number {
  if (MCX_UNDERLYINGS.has(String(underlyingSymbol ?? "").toUpperCase())) {
    return quantity;
  }
  const lotSize = getFallbackLotSize(underlyingSymbol);
  return lotSize > 0 ? quantity / lotSize : quantity;
}

/**
 * Short-option margin model. ONE definition, used by Paper Trade Pro's live
 * buying power and by the backtests, because the two disagreeing is precisely
 * how the bug below survived.
 *
 * WHAT WAS WRONG
 * Both sim call sites used the SEBI-style *prescribed minimum*:
 *
 *   max(0.20 * spot + premium - otmAmount, 0.10 * spot)
 *
 * That floor is calibrated for STOCK options. Applied to an index option it
 * lands 2.0-2.4x above what a broker actually blocks, because index margin is
 * far lower - an index is a diversified basket, so its worst-case scenario
 * move is much smaller than any single stock's. Worked example, NIFTY
 * 2026-08-14, spot 24,366, short 24,650 CE at 15.95, lot 65:
 *
 *   prescribed minimum : max(0.20*24366 + 15.95 - 284, 0.10*24366)
 *                        = 4,605 pts/unit x 65 = Rs 2,99,335  (18.9% of the
 *                          Rs 15.84L notional)
 *   what brokers block : Rs 1.25-1.5 lakh per lot for a naked NIFTY short
 *                        held overnight  =  7.9-9.5% of notional
 *
 * In Paper Trade Pro that halved usable buying power and rejected trades a
 * real account would have accepted.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * Real margin is SPAN + Exposure + ELM. SPAN is a scenario-based worst case
 * that the exchange revalues SIX times a trading day from its own risk arrays.
 * It cannot be reconstructed from stored option chains, and no curve-fitting
 * here would make it exact. Treat the output as +/-20%.
 *
 *   margin per unit = basePct * spot + max(0, amount the short is ITM)
 *
 * - The ITM term is the behaviour that actually matters: margin escalates hard
 *   as a short goes into the money, which is exactly when an account blows up.
 *   While the short is OTM the requirement is essentially flat in spot.
 * - Strike distance while OTM is deliberately NOT modelled. Real SPAN does
 *   charge less for further-OTM strikes, but the published figures
 *   (Rs 1.25-1.5 lakh naked, Rs 1.2-1.35 lakh ATM) overlap too heavily to
 *   support fitting that curve. A coefficient invented here would be false
 *   precision.
 *
 * Re-check when lot sizes or the margin regime change.
 */

/** Middle of the published 7.9-9.5%-of-notional range for a naked index short. */
export const MARGIN_BASE_PCT_INDEX = 0.085;
/** Reported alongside index figures so a point estimate is never read alone. */
export const MARGIN_PCT_INDEX_LOW = 0.079;
export const MARGIN_PCT_INDEX_HIGH = 0.095;

/**
 * Non-index (single stock) stays at the prescribed 20% minimum.
 *
 * This is NOT an oversight and should not be "corrected" to match the index
 * figure. The 20% floor was designed for single stocks and sits close to what
 * brokers actually block on them, which is why the 2x error only ever showed
 * up on indices. There is no equivalently well-sourced published range for
 * stock options in this repo, and substituting the index number would
 * UNDERSTATE stock margin by roughly the same factor it currently overstates
 * index margin - the same bug, pointed the other way and harder to notice
 * because it flatters the account.
 */
export const MARGIN_BASE_PCT_STOCK = 0.2;

const INDEX_MARGIN_UNDERLYINGS = new Set([
  "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX", "INDIAVIX"
]);

/** Base margin percentage of spot for one short leg on this underlying. */
export function marginBasePctFor(underlyingSymbol: string): number {
  return INDEX_MARGIN_UNDERLYINGS.has(underlyingSymbol.toUpperCase()) ? MARGIN_BASE_PCT_INDEX : MARGIN_BASE_PCT_STOCK;
}

/** How far a short leg is in the money, in points. Zero while OTM. */
export function shortLegItmAmount(spot: number, strike: number, optionType: OptionType): number {
  return optionType === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/**
 * Margin per unit (per share/index point of contract size) for ONE short leg.
 *
 * Multiply by lotSize * lots for the rupee figure. Legs are summed with no
 * offset credited between a short call and a short put: SPAN gives a strangle
 * only a small benefit because both legs cannot lose simultaneously, and
 * crediting a large one here would flatter return-on-margin.
 */
export function shortLegMarginPerUnit(underlyingSymbol: string, spot: number, strike: number, optionType: OptionType): number {
  return marginBasePctFor(underlyingSymbol) * spot + shortLegItmAmount(spot, strike, optionType);
}

export interface StrikeMatrixRow {
  optionType: OptionType;
  strikePrice: number;
  // undefined only if the tick genuinely has no last-traded price yet
  // (e.g. a strike that hasn't traded this session).
  lastPrice?: number;
  // Day-level LTP change vs previous close - used only to tell writing
  // (price falling) apart from covering (price rising) when OI is falling,
  // for the Institutional Unwinding trigger.
  lastPriceChange?: number;
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
  // Probability (0-100) that every leg of this structure expires
  // worthless, derived from the deltas of the strikes actually picked -
  // ~1 - |delta| for a single leg, with both tails subtracted for a
  // two-legged structure. Not a fixed constant.
  theoreticalPop: number;
  note: string;
  // Whether EVERY side this structure actually writes is backed by a wall
  // that cleared the horizon's conviction threshold. The engine computes
  // call/put walls and their meetsThreshold, but the recommendation used to
  // ignore them entirely - live, 100% of NIFTY's default-view
  // recommendations (and 30-65% elsewhere) shipped with neither wall
  // qualifying, presented identically to a fully-backed one. Recorded on
  // the recommendation itself, not just in the UI's trade-button gate, so
  // every consumer of the API sees the same distinction.
  wallBacked: boolean;
  // The side(s) the structure writes that lack a qualifying wall - empty
  // when wallBacked is true. Lets a caller say exactly which leg is
  // unsupported rather than only that something is.
  unbackedSides: ("CE" | "PE")[];
}

export interface StrikeMatrixRiskRuleStatus {
  // undefined when the rule genuinely can't be evaluated from data on hand
  // (e.g. IV Rank without enough trading-day history, or the 2x-delta stop
  // before any position exists to compare against) - never defaulted to
  // true/false, since a silent default would misrepresent an unevaluated
  // rule as a checked one.
  satisfied: boolean | undefined;
  detail: string;
}

export interface StrikeMatrixInstitutionalUnwinding {
  strikePrice: number;
  delta: number;
  oiChange: number;
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
  // How many strikes on each side actually CONTRIBUTED to drcr/bias, i.e.
  // survived both the delta band and the opening-OI (oiChange > 0) filter.
  // Always <= the per-side count in `universe`, and routinely far smaller:
  // measured live on NIFTY (2026-08-11, 462 ticks) the intraday band left
  // exactly ONE put and ONE call, so `bias` there was a ratio of two
  // strikes - while the Dashboard's own bias read all 462. Exposed so the
  // UI can show that sample size instead of presenting a two-strike read
  // with the same visual weight as a whole-chain one.
  putDrcCount: number;
  callDrcCount: number;
  // undefined when the call side has zero aggregate |DRC| (division guard)
  drcr?: number;
  bias: StrikeMatrixBias;
  callWall?: StrikeMatrixWall;
  putWall?: StrikeMatrixWall;
  recommendation?: StrikeMatrixRecommendation;
  riskRule: string;
  riskRuleStatus: StrikeMatrixRiskRuleStatus;
  // Institutional call-writer covering in the ATM/near-OTM band (|delta|
  // 0.35-0.65) - wider than any horizon's own tradable universe, since
  // covering typically starts near the money, not in the far wings this
  // engine otherwise trades. Cross-cutting: evaluated the same way
  // regardless of which horizon is selected, unlike the other three rules.
  institutionalUnwinding?: StrikeMatrixInstitutionalUnwinding;
  // Calendar days from the analysed snapshot to this chain's own expiry.
  daysToExpiry: number;
  // Set when the selected horizon's assumed tenor doesn't match the
  // contract actually being analysed - e.g. picking "Monthly" against
  // NIFTY's only-weekly expiries applies the monthly delta band and the
  // IV-Rank rule to a 4-DTE contract, and BANKNIFTY's "Intraday" tab does
  // the same against a 25-DTE monthly-only chain. The horizon toggle
  // changes the framework, never the contract, so this says plainly when
  // the two disagree rather than presenting the mismatch silently.
  // undefined when the horizon fits the contract.
  horizonTenorMismatch?: string;
}

// --- Elliott Wave Engine ---
// See docs/DECODE OPTION & ELLIOTT WAVE KNOWLEDGE FILE and the
// elliott-wave-options-fno-skill skill for the source rules. Built as a
// standalone tab (not folded into the Strike Matrix tab) since it answers a
// different question - structural wave stage vs. live writer-flow bias -
// off a different data source (spot price history vs. option chain ticks).

export interface SpotPricePoint {
  time: string;
  price: number;
  // Cumulative day volume at this instant, when the source has real traded
  // volume to report (F&O stocks via WavePricePoint). Undefined for indices/
  // commodities (OptionChainSnapshot-derived series) - they don't have
  // conventional traded volume, so RVOL simply can't be computed for them.
  volume?: number;
}

// A confirmed ZigZag swing point. `label` is only set once the pivot has
// been assigned a place in the most recent wave count - unlabeled pivots
// exist in the series but fall outside the count currently being displayed.
export type WaveLabel = "1" | "2" | "3" | "4" | "5" | "A" | "B" | "C";

export interface WavePivot {
  time: string;
  price: number;
  kind: "high" | "low";
  label?: WaveLabel;
}

export type WaveDirection = "Bullish" | "Bearish" | "Undetermined";

// What the market is CURRENTLY doing, i.e. the wave forming after the most
// recent confirmed pivot - not the wave that just finished. E.g. once Wave 1
// finishes (pivot confirmed), price is now inside Wave 2, so the stage reads
// "Wave 2 Turning".
export type WaveStage = "Wave 2 Turning" | "Wave 3 Initiation" | "Wave 4 Range" | "Wave 5 Exhaustion" | "Corrective Phase" | "Undetermined";

export interface WaveRuleCheck {
  rule: string;
  description: string;
  passed: boolean;
}

export interface WaveFibonacciLevel {
  label: string;
  // Actual measured ratio for the leg this level describes (e.g. Wave 2's
  // actual retracement of Wave 1) - undefined when the leg doesn't exist yet.
  actualPercent?: number;
  targetLow: number;
  targetHigh: number;
  withinTarget: boolean;
  description: string;
  // True when actualPercent is read off the leg's current, still-forming
  // extreme rather than its confirmed/reversed end point - it will keep
  // moving until the leg actually reverses. Only ever set on the "Wave 2
  // Retracement" level while currentStage is "Wave 2 Turning".
  provisional?: boolean;
}

export interface ElliottWaveStrategyRecommendation {
  stage: WaveStage;
  context: string;
  strategy: string;
  primaryGreek: string;
  riskProfile: string;
}

export type WaveScreenerAlertType = "WAVE2_REVERSAL" | "WAVE3_IMPULSE";

export interface WaveScreenerSignal {
  alertType: WaveScreenerAlertType;
  stage: WaveStage;
  direction: WaveDirection;
  message: string;
  triggeredPrice: number;
  fibRetracementPercent?: number;
  rvol?: number;
  rsi?: number;
}

export interface ElliottWaveAnalysis {
  underlyingSymbol: string;
  // ZigZag reversal threshold, as a percent of price, used to confirm pivots.
  zigZagPercent: number;
  pivots: WavePivot[];
  currentStage: WaveStage;
  direction: WaveDirection;
  invalidated: boolean;
  invalidationReason?: string;
  ruleChecks: WaveRuleCheck[];
  fibonacciLevels: WaveFibonacciLevel[];
  recommendation?: ElliottWaveStrategyRecommendation;
  lastPrice: number;
  lastUpdated: string;
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

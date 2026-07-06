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
  changeInOpenInterest?: number;
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
}

export interface Recommendation {
  id: string;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  title: string;
  explanation: string;
  action: string;
  confidence: number;
  tradeSetup?: RecommendedTradeSetup;
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

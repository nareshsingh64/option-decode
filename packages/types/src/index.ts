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

// Paper Trading Pro (seller strategy simulator) repository.
//
// Fully separate from paper-repository.ts (the original single-leg paper
// trading module) - nothing here reads or writes PaperOrder/PaperPosition/
// PaperTrade. It consumes market data (OptionContractTick /
// OptionChainSnapshot / Expiry) read-only and owns the Sim* tables.
//
// Realism rules implemented per the option-seller framework:
// - Liquidity filter: reject legs with OI below minimum or bid-ask spread
//   ratio above 15% of mid.
// - Slippage fill: SELL fills at mid - chi*(ask-bid), BUY at mid + chi*(ask-bid),
//   chi = 0.25 (0.50 in high-IV regimes).
// - Buying Power Effect: defined-risk = max loss; undefined-risk = exchange
//   style approximation (20% of underlying notional + premium - OTM amount).
// - Sizing guardrail: one trade may not consume more than the account's
//   maxTradeBpPct of total buying power.
// - Exit rules (EOD, Phase 1 = flag only): profit target (25-30% straddle,
//   50% defined-risk), hard stop at 3x credit, DTE <= 7 gamma flag,
//   expiry settlement (intrinsic value, EXPIRED status).

import type { OptionType } from "@option-decode/types";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { AuthUserDto } from "./auth-repository.js";
import { prisma } from "./index.js";
import { getStoredFnoLotSize } from "./lot-size-repository.js";

const DEFAULT_STARTING_CAPITAL = 1_000_000;
const MIN_OPEN_INTEREST = 500;
const MAX_SPREAD_RATIO = 0.15;
const SLIPPAGE_CHI_STANDARD = 0.25;
const SLIPPAGE_CHI_HIGH_IV = 0.5;
const HIGH_IV_THRESHOLD = 25;
const LOW_EDGE_IV_HV_RATIO = 1.1;
const HARD_STOP_MULTIPLE = 3;
const DTE_GAMMA_THRESHOLD_DAYS = 7;
const UNDEFINED_RISK_MARGIN_PCT = 0.2;
// Phase 3: expiry-week margin ramp for stock options carrying physical
// delivery obligations (NSE brokers ramp delivery margins through the last
// week; 1.5x is a deliberately simple stand-in for that schedule).
const DELIVERY_WEEK_MARGIN_MULTIPLIER = 1.5;
// Phase 3 partial fills: orders above this many lots, on strikes where the
// order would consume more than the volume share below of the day's traded
// volume, fill in tranches with escalating slippage per tranche.
const PARTIAL_FILL_LOT_THRESHOLD = 10;
const PARTIAL_FILL_VOLUME_SHARE = 0.1;
const PARTIAL_FILL_CHI_ESCALATION = 0.5;
const INDEX_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX", "INDIAVIX"]);

function isIndexUnderlying(underlyingSymbol: string): boolean {
  return INDEX_UNDERLYINGS.has(underlyingSymbol.toUpperCase());
}

export type SimStrategyTypeName = "SHORT_STRADDLE" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "IRON_CONDOR" | "NAKED_CALL" | "NAKED_PUT";
export type SimHorizonName = "INTRADAY" | "WEEKLY" | "MONTHLY";

export interface SimLegInput {
  side: "SELL" | "BUY";
  optionType: OptionType;
  strikePrice: number;
}

export interface SimTradeInput {
  underlyingSymbol: string;
  expiry: string;
  strategyType: SimStrategyTypeName;
  horizon: SimHorizonName;
  lots: number;
  legs: SimLegInput[];
  // Phase 2: set when the trade originates from a Strike Matrix
  // recommendation, so signal performance can be attributed later.
  entryWci?: number | null;
  entryDrcr?: number | null;
  signalRef?: string | null;
}

// Institutional-conviction gate for signal-originated trades: positions
// showing lower WCI lack the backing to justify the horizon's gap risk.
const WCI_THRESHOLD_INTRADAY = 0.1;
const WCI_THRESHOLD_POSITIONAL = 0.2;

export interface SimFillTranche {
  lots: number;
  price: number;
}

export interface SimQuotedLeg extends SimLegInput {
  bid: number;
  ask: number;
  mid: number;
  fillPrice: number;
  openInterest: number | null;
  volume: number | null;
  delta: number | null;
  iv: number | null;
  // Phase 3: set when the order was large relative to the strike's traded
  // volume - the fillPrice above is the volume-weighted average of these.
  tranches: SimFillTranche[] | null;
  rejectReason: string | null;
}

export interface SimQuote {
  ok: boolean;
  legs: SimQuotedLeg[];
  lotSize: number;
  slippageChi: number;
  netCreditPerUnit: number;
  netCreditTotal: number;
  maxLossTotal: number | null;
  bpe: number;
  popEstimate: number | null;
  ivAtEntry: number | null;
  hv20: number | null;
  ivHvRatio: number | null;
  lowEdgeFlag: boolean;
  spotPrice: number | null;
  rejectReason: string | null;
}

export interface SimAccountDto {
  id: string;
  name: string;
  startingCapital: number;
  cash: number;
  nlv: number;
  // Phase 3: dynamic maintenance margin (undefined-risk positions re-marked
  // at current spot/premium, delivery-week ramp for stocks).
  marginUsed: number;
  marginCall: boolean;
  buyingPower: number;
  buyingPowerUsedPct: number;
  maxTradeBpPct: number;
}

export interface SimTradeLegDto {
  id: string;
  side: "SELL" | "BUY";
  optionType: OptionType;
  strikePrice: number;
  fillPrice: number;
  closeFillPrice: number | null;
}

export interface SimTradeDto {
  id: string;
  strategyType: SimStrategyTypeName;
  underlyingSymbol: string;
  expiryLabel: string;
  expiryDate: string;
  horizon: SimHorizonName;
  lots: number;
  lotSize: number;
  status: "OPEN" | "CLOSED" | "EXPIRED" | "LIQUIDATED";
  netCredit: number;
  maxLoss: number | null;
  bpe: number;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  pnlPctOfMaxProfit: number | null;
  dte: number;
  // Phase 3: live maintenance margin for open trades (null once closed).
  maintenanceMargin: number | null;
  ivHvRatio: number | null;
  lowEdgeFlag: boolean;
  entryWci: number | null;
  entryDrcr: number | null;
  signalRef: string | null;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
  legs: SimTradeLegDto[];
  exitFlags: Array<{ rule: string; detail: string | null; triggeredAt: string }>;
}

export interface SimGreeksDto {
  netDelta: number | null;
  netGamma: number | null;
  netTheta: number | null;
  netVega: number | null;
}

export interface SimSignalScorecardRow {
  regime: "Bullish" | "Neutral" | "Bearish" | "Transitional";
  horizon: SimHorizonName;
  trades: number;
  wins: number;
  totalPnl: number;
}

export interface SimAnalyticsDto {
  totalTrades: number;
  wins: number;
  losses: number;
  expectancy: number | null;
  tailRiskRatio: number | null;
  thetaEfficiency: number | null;
  avgIvHvRatio: number | null;
  totalRealizedPnl: number;
  // Phase 2: closed signal-originated trades bucketed by the DRCR regime
  // they were entered under - "which matrix cells actually make money".
  signalScorecard: SimSignalScorecardRow[];
}

export interface SimSummary {
  account: SimAccountDto;
  openTrades: SimTradeDto[];
  closedTrades: SimTradeDto[];
  portfolioGreeks: SimGreeksDto;
  analytics: SimAnalyticsDto;
}

interface LatestLegTick {
  bid: number | null;
  ask: number | null;
  last: number | null;
  openInterest: number | null;
  volume: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function toNum(value: { toNumber(): number } | null | undefined): number | null {
  return value == null ? null : value.toNumber();
}

async function getSimLotSize(underlyingSymbol: string, expiry: string, client: PrismaClient): Promise<number> {
  const stored = await getStoredFnoLotSize(underlyingSymbol, expiry, client);
  if (stored) {
    return stored;
  }
  const fallback: Record<string, number> = {
    NIFTY: 65,
    BANKNIFTY: 30,
    FINNIFTY: 60,
    MIDCPNIFTY: 120,
    NIFTYNXT50: 25,
    SENSEX: 20,
    BANKEX: 30
  };
  return fallback[underlyingSymbol.toUpperCase()] ?? 1;
}

async function getLatestLegTick(underlyingSymbol: string, expiryLabel: string, optionType: OptionType, strikePrice: number, client: PrismaClient): Promise<LatestLegTick | null> {
  const tick = await client.optionContractTick.findFirst({
    where: { underlyingSymbol, expiryLabel, optionType, strikePrice },
    orderBy: { tickTime: "desc" }
  });
  if (!tick) {
    return null;
  }
  return {
    bid: toNum(tick.bidPrice),
    ask: toNum(tick.askPrice),
    last: toNum(tick.lastPrice),
    openInterest: toNum(tick.openInterest),
    volume: toNum(tick.volume),
    iv: toNum(tick.impliedVolatility),
    delta: toNum(tick.deltaValue),
    gamma: toNum(tick.gammaValue),
    theta: toNum(tick.thetaValue),
    vega: toNum(tick.vegaValue)
  };
}

async function getLatestSpot(underlyingSymbol: string, client: PrismaClient): Promise<number | null> {
  const snapshot = await client.optionChainSnapshot.findFirst({
    where: { underlyingSymbol },
    orderBy: { snapshotTime: "desc" },
    select: { spotPrice: true }
  });
  return snapshot ? snapshot.spotPrice.toNumber() : null;
}

// 20-day historical volatility (annualized, in %) from daily closing spot
// prices stored on OptionChainSnapshot. Returns null when there isn't
// enough history yet.
async function getHistoricalVolatility20(underlyingSymbol: string, client: PrismaClient): Promise<number | null> {
  const dates = await client.optionChainSnapshot.findMany({
    where: { underlyingSymbol },
    distinct: ["tradingDate"],
    orderBy: { tradingDate: "desc" },
    take: 21,
    select: { tradingDate: true }
  });
  if (dates.length < 21) {
    return null;
  }
  const closes: number[] = [];
  for (const { tradingDate } of dates) {
    const eod = await client.optionChainSnapshot.findFirst({
      where: { underlyingSymbol, tradingDate },
      orderBy: { snapshotTime: "desc" },
      select: { spotPrice: true }
    });
    if (eod) {
      closes.push(eod.spotPrice.toNumber());
    }
  }
  if (closes.length < 21) {
    return null;
  }
  closes.reverse();
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  if (returns.length < 2) {
    return null;
  }
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return round2(Math.sqrt(variance) * Math.sqrt(252) * 100);
}

async function resolveExpiryDate(underlyingSymbol: string, expiryLabel: string, client: PrismaClient): Promise<Date | null> {
  const expiry = await client.expiry.findFirst({
    where: { expiryLabel, underlying: { symbol: underlyingSymbol } },
    select: { expiryDate: true }
  });
  if (expiry) {
    return expiry.expiryDate;
  }
  const parsed = new Date(expiryLabel);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysToExpiry(expiryDate: Date, asOf = new Date()): number {
  const ms = expiryDate.getTime() - asOf.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function isDefinedRisk(strategyType: SimStrategyTypeName): boolean {
  return strategyType === "BULL_PUT_SPREAD" || strategyType === "BEAR_CALL_SPREAD" || strategyType === "IRON_CONDOR";
}

// Max loss per unit for defined-risk structures: widest wing width minus the
// net credit. Iron condors use the wider of the two spreads (only one side
// can be breached at expiry).
function computeDefinedRiskMaxLossPerUnit(legs: SimLegInput[], netCreditPerUnit: number): number | null {
  const widthOf = (optionType: OptionType): number | null => {
    const sell = legs.find((leg) => leg.side === "SELL" && leg.optionType === optionType);
    const buy = legs.find((leg) => leg.side === "BUY" && leg.optionType === optionType);
    if (!sell || !buy) {
      return null;
    }
    return Math.abs(sell.strikePrice - buy.strikePrice);
  };
  const widths = (["CE", "PE"] as OptionType[]).map(widthOf).filter((width): width is number => width !== null);
  if (widths.length === 0) {
    return null;
  }
  return Math.max(...widths) - netCreditPerUnit;
}

// Exchange-style approximation for undefined-risk short options:
// 20% of underlying + premium received - OTM amount, per short leg.
function computeUndefinedRiskBpePerUnit(legs: SimQuotedLeg[], spotPrice: number): number {
  let bpe = 0;
  for (const leg of legs) {
    if (leg.side !== "SELL") {
      continue;
    }
    const otmAmount = leg.optionType === "CE" ? Math.max(0, leg.strikePrice - spotPrice) : Math.max(0, spotPrice - leg.strikePrice);
    bpe += Math.max(UNDEFINED_RISK_MARGIN_PCT * spotPrice + leg.fillPrice - otmAmount, 0.1 * spotPrice);
  }
  return bpe;
}

export async function quoteSimTrade(input: SimTradeInput, client: PrismaClient = prisma): Promise<SimQuote> {
  const lotSize = await getSimLotSize(input.underlyingSymbol, input.expiry, client);
  const spotPrice = await getLatestSpot(input.underlyingSymbol, client);

  const quotedLegs: SimQuotedLeg[] = [];
  const ivValues: number[] = [];
  for (const leg of input.legs) {
    const tick = await getLatestLegTick(input.underlyingSymbol, input.expiry, leg.optionType, leg.strikePrice, client);
    let rejectReason: string | null = null;
    const bid = tick?.bid ?? null;
    const ask = tick?.ask ?? null;
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : tick?.last ?? null;
    if (!tick || mid === null || mid <= 0) {
      rejectReason = "No market data for this strike.";
    } else if (bid === null || ask === null || bid <= 0 || ask <= 0) {
      rejectReason = "No live bid/ask for this strike.";
    } else {
      const spreadRatio = (ask - bid) / mid;
      const oi = tick.openInterest ?? 0;
      if (oi < MIN_OPEN_INTEREST) {
        rejectReason = `Open interest ${Math.round(oi)} below minimum ${MIN_OPEN_INTEREST}.`;
      } else if (spreadRatio > MAX_SPREAD_RATIO) {
        rejectReason = `Bid-ask spread ${(spreadRatio * 100).toFixed(1)}% exceeds ${MAX_SPREAD_RATIO * 100}% limit.`;
      }
    }
    if (tick?.iv != null) {
      ivValues.push(tick.iv);
    }
    quotedLegs.push({
      ...leg,
      bid: bid ?? 0,
      ask: ask ?? 0,
      mid: mid !== null ? round2(mid) : 0,
      fillPrice: 0,
      openInterest: tick?.openInterest ?? null,
      volume: tick?.volume ?? null,
      delta: tick?.delta ?? null,
      iv: tick?.iv ?? null,
      tranches: null,
      rejectReason
    });
  }

  const avgIv = ivValues.length ? ivValues.reduce((sum, iv) => sum + iv, 0) / ivValues.length : null;
  const slippageChi = avgIv !== null && avgIv >= HIGH_IV_THRESHOLD ? SLIPPAGE_CHI_HIGH_IV : SLIPPAGE_CHI_STANDARD;

  for (const leg of quotedLegs) {
    if (leg.rejectReason) {
      continue;
    }
    const spread = leg.ask - leg.bid;
    const fillAt = (chi: number) => round2(leg.side === "SELL" ? Math.max(leg.mid - chi * spread, leg.bid) : Math.min(leg.mid + chi * spread, leg.ask));

    // Phase 3: partial-fill simulation. Orders above the tranche size on a
    // strike whose day volume is thin relative to the order get filled in
    // tranches with escalating slippage - teaching the real cost of size.
    const orderUnits = input.lots * lotSize;
    const dayVolume = leg.volume ?? 0;
    if (input.lots > PARTIAL_FILL_LOT_THRESHOLD && dayVolume > 0 && orderUnits > dayVolume * PARTIAL_FILL_VOLUME_SHARE) {
      const tranches: SimFillTranche[] = [];
      let remaining = input.lots;
      let trancheIndex = 0;
      let weighted = 0;
      while (remaining > 0) {
        const trancheLots = Math.min(PARTIAL_FILL_LOT_THRESHOLD, remaining);
        const tranchePrice = fillAt(slippageChi * (1 + PARTIAL_FILL_CHI_ESCALATION * trancheIndex));
        tranches.push({ lots: trancheLots, price: tranchePrice });
        weighted += trancheLots * tranchePrice;
        remaining -= trancheLots;
        trancheIndex += 1;
      }
      leg.tranches = tranches;
      leg.fillPrice = round2(weighted / input.lots);
    } else {
      leg.fillPrice = fillAt(slippageChi);
    }
  }

  const rejected = quotedLegs.find((leg) => leg.rejectReason);
  const netCreditPerUnit = round2(quotedLegs.reduce((sum, leg) => sum + (leg.side === "SELL" ? leg.fillPrice : -leg.fillPrice), 0));
  const unitMultiplier = lotSize * input.lots;
  const definedMaxLossPerUnit = isDefinedRisk(input.strategyType) ? computeDefinedRiskMaxLossPerUnit(input.legs, netCreditPerUnit) : null;

  let bpe = 0;
  if (definedMaxLossPerUnit !== null) {
    bpe = round2(definedMaxLossPerUnit * unitMultiplier);
  } else if (spotPrice !== null) {
    bpe = round2(computeUndefinedRiskBpePerUnit(quotedLegs, spotPrice) * unitMultiplier);
  }

  const shortDeltas = quotedLegs.filter((leg) => leg.side === "SELL" && leg.delta !== null).map((leg) => Math.abs(leg.delta as number));
  const popEstimate = shortDeltas.length ? round2((1 - shortDeltas.reduce((sum, d) => sum + d, 0) / shortDeltas.length) * 100) : null;

  const hv20 = await getHistoricalVolatility20(input.underlyingSymbol, client);
  const ivHvRatio = avgIv !== null && hv20 !== null && hv20 > 0 ? round2(avgIv / hv20) : null;

  let rejectReason: string | null = null;
  if (rejected) {
    rejectReason = `${rejected.optionType} ${rejected.strikePrice}: ${rejected.rejectReason}`;
  } else if (netCreditPerUnit <= 0) {
    rejectReason = "Structure does not produce a net credit - option selling requires collecting premium.";
  }

  return {
    ok: rejectReason === null,
    legs: quotedLegs,
    lotSize,
    slippageChi,
    netCreditPerUnit,
    netCreditTotal: round2(netCreditPerUnit * unitMultiplier),
    maxLossTotal: definedMaxLossPerUnit !== null ? round2(definedMaxLossPerUnit * unitMultiplier) : null,
    bpe,
    popEstimate,
    ivAtEntry: avgIv !== null ? round2(avgIv) : null,
    hv20,
    ivHvRatio,
    lowEdgeFlag: ivHvRatio !== null && ivHvRatio < LOW_EDGE_IV_HV_RATIO,
    spotPrice,
    rejectReason
  };
}

export async function getOrCreateSimAccount(user: AuthUserDto, client: PrismaClient = prisma) {
  const existing = await client.simAccount.findFirst({ where: { userId: user.id, isActive: true } });
  if (existing) {
    return existing;
  }
  return client.simAccount.create({
    data: {
      userId: user.id,
      startingCapital: DEFAULT_STARTING_CAPITAL,
      cash: DEFAULT_STARTING_CAPITAL
    }
  });
}

export async function resetSimAccount(user: AuthUserDto, startingCapital = DEFAULT_STARTING_CAPITAL, client: PrismaClient = prisma) {
  await client.simAccount.updateMany({
    where: { userId: user.id, isActive: true },
    data: { isActive: false, resetAt: new Date() }
  });
  return client.simAccount.create({
    data: {
      userId: user.id,
      startingCapital,
      cash: startingCapital
    }
  });
}

export async function placeSimTrade(input: SimTradeInput, user: AuthUserDto, client: PrismaClient = prisma): Promise<{ tradeId: string; quote: SimQuote }> {
  const quote = await quoteSimTrade(input, client);
  if (!quote.ok) {
    throw new SimOrderRejectedError(quote.rejectReason ?? "Order rejected.");
  }

  const account = await getOrCreateSimAccount(user, client);
  const openBpe = await sumOpenBpe(account.id, client);
  const totalBuyingPower = account.cash.toNumber();
  const availableBuyingPower = totalBuyingPower - openBpe;
  if (quote.bpe > availableBuyingPower) {
    throw new SimOrderRejectedError(`Insufficient buying power: trade needs ${quote.bpe.toFixed(0)} but only ${Math.max(availableBuyingPower, 0).toFixed(0)} is available.`);
  }
  const maxTradeBp = (account.maxTradeBpPct.toNumber() / 100) * totalBuyingPower;
  if (quote.bpe > maxTradeBp) {
    throw new SimOrderRejectedError(`Position sizing guardrail: trade needs ${quote.bpe.toFixed(0)} which exceeds ${account.maxTradeBpPct.toNumber()}% of buying power (${maxTradeBp.toFixed(0)}).`);
  }

  const expiryDate = await resolveExpiryDate(input.underlyingSymbol, input.expiry, client);
  if (!expiryDate) {
    throw new SimOrderRejectedError(`Unknown expiry "${input.expiry}" for ${input.underlyingSymbol}.`);
  }

  // Signal-originated trades must clear the WCI conviction threshold for
  // their horizon (manual trades are not gated - the trader is the signal).
  if (input.signalRef && input.entryWci != null) {
    const wciThreshold = input.horizon === "INTRADAY" ? WCI_THRESHOLD_INTRADAY : WCI_THRESHOLD_POSITIONAL;
    if (Math.abs(input.entryWci) <= wciThreshold) {
      throw new SimOrderRejectedError(`Signal WCI ${input.entryWci.toFixed(2)} is below the ${input.horizon.toLowerCase()} conviction threshold (${wciThreshold}); the wall lacks institutional backing.`);
    }
  }

  const trade = await client.simTrade.create({
    data: {
      accountId: account.id,
      strategyType: input.strategyType,
      underlyingSymbol: input.underlyingSymbol,
      expiryLabel: input.expiry,
      expiryDate,
      horizon: input.horizon,
      lotSize: quote.lotSize,
      lots: input.lots,
      netCredit: quote.netCreditTotal,
      maxLoss: quote.maxLossTotal,
      bpe: quote.bpe,
      underlyingAtEntry: quote.spotPrice ?? 0,
      ivAtEntry: quote.ivAtEntry,
      hv20AtEntry: quote.hv20,
      ivHvRatio: quote.ivHvRatio,
      lowEdgeFlag: quote.lowEdgeFlag,
      entryWci: input.entryWci ?? null,
      entryDrcr: input.entryDrcr ?? null,
      signalRef: input.signalRef ?? null,
      legs: {
        create: quote.legs.map((leg) => ({
          side: leg.side,
          optionType: leg.optionType,
          strikePrice: leg.strikePrice,
          midAtFill: leg.mid,
          bidAtFill: leg.bid,
          askAtFill: leg.ask,
          slippageChi: quote.slippageChi,
          fillPrice: leg.fillPrice,
          oiAtFill: leg.openInterest,
          deltaAtFill: leg.delta,
          ivAtFill: leg.iv,
          fillBreakdown: leg.tranches ? (leg.tranches as unknown as Prisma.InputJsonValue) : undefined
        }))
      }
    }
  });

  return { tradeId: trade.id, quote };
}

export class SimOrderRejectedError extends Error {}

async function sumOpenBpe(accountId: string, client: PrismaClient): Promise<number> {
  const result = await client.simTrade.aggregate({
    where: { accountId, status: "OPEN" },
    _sum: { bpe: true }
  });
  return result._sum.bpe?.toNumber() ?? 0;
}

interface TradeCloseCost {
  closeCostTotal: number;
  legCloseFills: Array<{ legId: string; closeFillPrice: number }>;
  greeks: SimGreeksDto;
}

// Total INR cost to close a trade right now, with slippage applied on the
// closing side (buy back short legs above mid, sell long legs below mid).
async function computeTradeCloseCost(trade: { id: string; underlyingSymbol: string; expiryLabel: string; lotSize: number; lots: number; legs: Array<{ id: string; side: string; optionType: OptionType; strikePrice: { toNumber(): number }; slippageChi: { toNumber(): number } }> }, client: PrismaClient): Promise<TradeCloseCost | null> {
  const unitMultiplier = trade.lotSize * trade.lots;
  let closeCostPerUnit = 0;
  let netDelta = 0;
  let netGamma = 0;
  let netTheta = 0;
  let netVega = 0;
  let greeksAvailable = false;
  const legCloseFills: Array<{ legId: string; closeFillPrice: number }> = [];

  for (const leg of trade.legs) {
    const tick = await getLatestLegTick(trade.underlyingSymbol, trade.expiryLabel, leg.optionType, leg.strikePrice.toNumber(), client);
    if (!tick) {
      return null;
    }
    const mid = tick.bid !== null && tick.ask !== null ? (tick.bid + tick.ask) / 2 : tick.last;
    if (mid === null || mid < 0) {
      return null;
    }
    const spread = tick.bid !== null && tick.ask !== null ? tick.ask - tick.bid : 0;
    const chi = leg.slippageChi.toNumber();
    // Closing a SELL leg means buying it back (pay above mid); closing a
    // BUY leg means selling it (receive below mid).
    const closeFill = round2(leg.side === "SELL" ? mid + chi * spread : Math.max(mid - chi * spread, 0));
    closeCostPerUnit += leg.side === "SELL" ? closeFill : -closeFill;
    legCloseFills.push({ legId: leg.id, closeFillPrice: closeFill });

    const sideSign = leg.side === "SELL" ? -1 : 1;
    if (tick.delta !== null) {
      netDelta += sideSign * tick.delta * unitMultiplier;
      greeksAvailable = true;
    }
    if (tick.gamma !== null) {
      netGamma += sideSign * tick.gamma * unitMultiplier;
    }
    if (tick.theta !== null) {
      netTheta += sideSign * tick.theta * unitMultiplier;
    }
    if (tick.vega !== null) {
      netVega += sideSign * tick.vega * unitMultiplier;
    }
  }

  return {
    closeCostTotal: round2(closeCostPerUnit * unitMultiplier),
    legCloseFills,
    greeks: {
      netDelta: greeksAvailable ? round2(netDelta) : null,
      netGamma: greeksAvailable ? Number(netGamma.toFixed(4)) : null,
      netTheta: greeksAvailable ? round2(netTheta) : null,
      netVega: greeksAvailable ? round2(netVega) : null
    }
  };
}

const simTradeInclude = {
  legs: true,
  exitEvents: { orderBy: { triggeredAt: "desc" as const }, take: 5 }
};

// ------------------------------------------------------------------
// Phase 3: dynamic (maintenance) margin.
// Defined-risk structures keep their static entry BPE - the wings cap the
// loss regardless of where the underlying goes. Undefined-risk structures
// are re-marked continuously: as a short option goes ITM the exchange-style
// formula (20% of underlying + current premium - OTM amount) scales the
// requirement up 5-10x, which is exactly the effect that blows up real
// margin accounts. Stock options additionally ramp inside expiry week for
// physical delivery obligations.
// ------------------------------------------------------------------

async function computeDynamicMarginForTrade(trade: { underlyingSymbol: string; expiryLabel: string; expiryDate: Date; lotSize: number; lots: number; maxLoss: { toNumber(): number } | null; bpe: { toNumber(): number }; legs: Array<{ side: string; optionType: OptionType; strikePrice: { toNumber(): number } }> }, client: PrismaClient, asOf = new Date()): Promise<number> {
  if (trade.maxLoss !== null) {
    return trade.bpe.toNumber();
  }
  const spot = await getLatestSpot(trade.underlyingSymbol, client);
  if (spot === null) {
    return trade.bpe.toNumber();
  }
  const unitMultiplier = trade.lotSize * trade.lots;
  let marginPerUnit = 0;
  for (const leg of trade.legs) {
    if (leg.side !== "SELL") {
      continue;
    }
    const strike = leg.strikePrice.toNumber();
    const tick = await getLatestLegTick(trade.underlyingSymbol, trade.expiryLabel, leg.optionType, strike, client);
    const mid = tick && tick.bid !== null && tick.ask !== null ? (tick.bid + tick.ask) / 2 : tick?.last ?? 0;
    const otmAmount = leg.optionType === "CE" ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
    marginPerUnit += Math.max(UNDEFINED_RISK_MARGIN_PCT * spot + mid - otmAmount, 0.1 * spot);
  }
  let margin = marginPerUnit * unitMultiplier;
  if (!isIndexUnderlying(trade.underlyingSymbol) && daysToExpiry(trade.expiryDate, asOf) <= DTE_GAMMA_THRESHOLD_DAYS) {
    margin *= DELIVERY_WEEK_MARGIN_MULTIPLIER;
  }
  return round2(margin);
}

export async function closeSimTrade(tradeId: string, user: AuthUserDto, exitReason = "MANUAL", client: PrismaClient = prisma): Promise<SimSummary> {
  const trade = await client.simTrade.findFirst({
    where: { id: tradeId, status: "OPEN", account: { userId: user.id, isActive: true } },
    include: { legs: true }
  });
  if (!trade) {
    throw new SimOrderRejectedError("Open trade not found.");
  }
  const closeCost = await computeTradeCloseCost(trade, client);
  if (!closeCost) {
    throw new SimOrderRejectedError("No market data available to price the close.");
  }
  await executeSimTradeClose(trade, closeCost, exitReason, client);

  return getSimSummary(user, client);
}

// Shared close transaction: used by the manual close endpoint and the
// Phase 2 automated exit engine. The conditional updateMany guards against
// the manual close and the worker racing to close the same trade.
async function executeSimTradeClose(trade: { id: string; accountId: string; netCredit: { toNumber(): number } }, closeCost: TradeCloseCost, exitReason: string, client: PrismaClient, status: "CLOSED" | "LIQUIDATED" = "CLOSED"): Promise<boolean> {
  const realizedPnl = round2(trade.netCredit.toNumber() - closeCost.closeCostTotal);
  const now = new Date();
  let didClose = false;

  await client.$transaction(async (tx) => {
    const updated = await tx.simTrade.updateMany({
      where: { id: trade.id, status: "OPEN" },
      data: { status, closedAt: now, exitReason, realizedPnl }
    });
    if (updated.count === 0) {
      return;
    }
    didClose = true;
    for (const fill of closeCost.legCloseFills) {
      await tx.simLeg.update({ where: { id: fill.legId }, data: { closeFillPrice: fill.closeFillPrice } });
    }
    await tx.simAccount.update({
      where: { id: trade.accountId },
      data: { cash: { increment: realizedPnl } }
    });
  });

  return didClose;
}

function mapTradeDto(trade: {
  id: string;
  strategyType: SimStrategyTypeName;
  underlyingSymbol: string;
  expiryLabel: string;
  expiryDate: Date;
  horizon: SimHorizonName;
  lots: number;
  lotSize: number;
  status: "OPEN" | "CLOSED" | "EXPIRED" | "LIQUIDATED";
  netCredit: { toNumber(): number };
  maxLoss: { toNumber(): number } | null;
  bpe: { toNumber(): number };
  realizedPnl: { toNumber(): number } | null;
  ivHvRatio: { toNumber(): number } | null;
  lowEdgeFlag: boolean;
  entryWci: { toNumber(): number } | null;
  entryDrcr: { toNumber(): number } | null;
  signalRef: string | null;
  exitReason: string | null;
  openedAt: Date;
  closedAt: Date | null;
  legs: Array<{ id: string; side: "SELL" | "BUY"; optionType: OptionType; strikePrice: { toNumber(): number }; fillPrice: { toNumber(): number }; closeFillPrice: { toNumber(): number } | null }>;
  exitEvents: Array<{ rule: string; detail: string | null; triggeredAt: Date }>;
}, unrealizedPnl: number | null, maintenanceMargin: number | null = null): SimTradeDto {
  const netCredit = trade.netCredit.toNumber();
  const pnl = trade.status === "OPEN" ? unrealizedPnl : trade.realizedPnl?.toNumber() ?? null;
  return {
    id: trade.id,
    strategyType: trade.strategyType,
    underlyingSymbol: trade.underlyingSymbol,
    expiryLabel: trade.expiryLabel,
    expiryDate: trade.expiryDate.toISOString().slice(0, 10),
    horizon: trade.horizon,
    lots: trade.lots,
    lotSize: trade.lotSize,
    status: trade.status,
    netCredit,
    maxLoss: trade.maxLoss ? trade.maxLoss.toNumber() : null,
    bpe: trade.bpe.toNumber(),
    unrealizedPnl: trade.status === "OPEN" ? unrealizedPnl : null,
    realizedPnl: trade.realizedPnl ? trade.realizedPnl.toNumber() : null,
    pnlPctOfMaxProfit: pnl !== null && netCredit > 0 ? round2((pnl / netCredit) * 100) : null,
    dte: daysToExpiry(trade.expiryDate),
    maintenanceMargin,
    ivHvRatio: trade.ivHvRatio ? trade.ivHvRatio.toNumber() : null,
    lowEdgeFlag: trade.lowEdgeFlag,
    entryWci: trade.entryWci ? trade.entryWci.toNumber() : null,
    entryDrcr: trade.entryDrcr ? trade.entryDrcr.toNumber() : null,
    signalRef: trade.signalRef,
    exitReason: trade.exitReason,
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt ? trade.closedAt.toISOString() : null,
    legs: trade.legs.map((leg) => ({
      id: leg.id,
      side: leg.side,
      optionType: leg.optionType,
      strikePrice: leg.strikePrice.toNumber(),
      fillPrice: leg.fillPrice.toNumber(),
      closeFillPrice: leg.closeFillPrice ? leg.closeFillPrice.toNumber() : null
    })),
    exitFlags: trade.exitEvents.map((event) => ({
      rule: event.rule,
      detail: event.detail,
      triggeredAt: event.triggeredAt.toISOString()
    }))
  };
}

export async function getSimSummary(user: AuthUserDto, client: PrismaClient = prisma): Promise<SimSummary> {
  const account = await getOrCreateSimAccount(user, client);

  const [openTrades, closedTrades] = await Promise.all([
    client.simTrade.findMany({
      where: { accountId: account.id, status: "OPEN" },
      include: simTradeInclude,
      orderBy: { openedAt: "desc" }
    }),
    client.simTrade.findMany({
      where: { accountId: account.id, status: { in: ["CLOSED", "EXPIRED", "LIQUIDATED"] } },
      include: simTradeInclude,
      orderBy: { closedAt: "desc" },
      take: 50
    })
  ]);

  let portfolioDelta = 0;
  let portfolioGamma = 0;
  let portfolioTheta = 0;
  let portfolioVega = 0;
  let greeksAvailable = false;
  let totalUnrealized = 0;
  let marginUsed = 0;

  const openDtos: SimTradeDto[] = [];
  for (const trade of openTrades) {
    const closeCost = await computeTradeCloseCost(trade, client);
    const unrealizedPnl = closeCost ? round2(trade.netCredit.toNumber() - closeCost.closeCostTotal) : null;
    if (unrealizedPnl !== null) {
      totalUnrealized += unrealizedPnl;
    }
    if (closeCost?.greeks.netDelta != null) {
      portfolioDelta += closeCost.greeks.netDelta;
      portfolioGamma += closeCost.greeks.netGamma ?? 0;
      portfolioTheta += closeCost.greeks.netTheta ?? 0;
      portfolioVega += closeCost.greeks.netVega ?? 0;
      greeksAvailable = true;
    }
    const maintenanceMargin = await computeDynamicMarginForTrade(trade, client);
    marginUsed += maintenanceMargin;
    openDtos.push(mapTradeDto(trade, unrealizedPnl, maintenanceMargin));
  }

  const closedDtos = closedTrades.map((trade) => mapTradeDto(trade, null));

  const cash = account.cash.toNumber();
  const nlv = round2(cash + totalUnrealized);
  const buyingPower = round2(Math.max(cash - marginUsed, 0));

  const realized = closedDtos.map((trade) => trade.realizedPnl ?? 0);
  const winValues = realized.filter((pnl) => pnl > 0);
  const lossValues = realized.filter((pnl) => pnl <= 0);
  const avgWin = winValues.length ? winValues.reduce((sum, pnl) => sum + pnl, 0) / winValues.length : 0;
  const avgLoss = lossValues.length ? Math.abs(lossValues.reduce((sum, pnl) => sum + pnl, 0) / lossValues.length) : 0;
  const winRate = realized.length ? winValues.length / realized.length : 0;
  const largestLoss = lossValues.length ? Math.abs(Math.min(...lossValues)) : 0;

  const thetaEfficiency = await computeThetaEfficiency(account.id, client);

  const ivHvValues = closedDtos.map((trade) => trade.ivHvRatio).filter((value): value is number => value !== null);

  // Signal scorecard: bucket closed signal trades by the DRCR regime at
  // entry (same bands the Strike Matrix uses) and by horizon.
  const scorecardBuckets = new Map<string, SimSignalScorecardRow>();
  for (const trade of closedDtos) {
    if (trade.entryDrcr === null) {
      continue;
    }
    const regime: SimSignalScorecardRow["regime"] = trade.entryDrcr > 1.5 ? "Bullish" : trade.entryDrcr < 0.6 ? "Bearish" : trade.entryDrcr >= 0.8 && trade.entryDrcr <= 1.2 ? "Neutral" : "Transitional";
    const key = `${regime}:${trade.horizon}`;
    const bucket = scorecardBuckets.get(key) ?? { regime, horizon: trade.horizon, trades: 0, wins: 0, totalPnl: 0 };
    bucket.trades += 1;
    if ((trade.realizedPnl ?? 0) > 0) {
      bucket.wins += 1;
    }
    bucket.totalPnl = round2(bucket.totalPnl + (trade.realizedPnl ?? 0));
    scorecardBuckets.set(key, bucket);
  }

  return {
    account: {
      id: account.id,
      name: account.name,
      startingCapital: account.startingCapital.toNumber(),
      cash: round2(cash),
      nlv,
      marginUsed: round2(marginUsed),
      marginCall: marginUsed > nlv,
      buyingPower,
      buyingPowerUsedPct: cash > 0 ? round2((marginUsed / cash) * 100) : 0,
      maxTradeBpPct: account.maxTradeBpPct.toNumber()
    },
    openTrades: openDtos,
    closedTrades: closedDtos,
    portfolioGreeks: {
      netDelta: greeksAvailable ? round2(portfolioDelta) : null,
      netGamma: greeksAvailable ? Number(portfolioGamma.toFixed(4)) : null,
      netTheta: greeksAvailable ? round2(portfolioTheta) : null,
      netVega: greeksAvailable ? round2(portfolioVega) : null
    },
    analytics: {
      totalTrades: realized.length,
      wins: winValues.length,
      losses: lossValues.length,
      expectancy: realized.length ? round2(winRate * avgWin - (1 - winRate) * avgLoss) : null,
      tailRiskRatio: avgWin > 0 && largestLoss > 0 ? round2(largestLoss / avgWin) : null,
      thetaEfficiency,
      avgIvHvRatio: ivHvValues.length ? round2(ivHvValues.reduce((sum, value) => sum + value, 0) / ivHvValues.length) : null,
      totalRealizedPnl: round2(realized.reduce((sum, pnl) => sum + pnl, 0)),
      signalScorecard: [...scorecardBuckets.values()].sort((a, b) => b.totalPnl - a.totalPnl)
    }
  };
}

// Theta efficiency: how much of the theoretical daily decay actually became
// realized P&L. Uses the MTM snapshot history of closed trades: sum of
// per-day theta collected vs total realized P&L. Null until enough history.
async function computeThetaEfficiency(accountId: string, client: PrismaClient): Promise<number | null> {
  const closed = await client.simTrade.findMany({
    where: { accountId, status: { in: ["CLOSED", "EXPIRED"] } },
    select: { id: true, realizedPnl: true }
  });
  if (closed.length === 0) {
    return null;
  }
  const thetaAgg = await client.simMtmSnapshot.aggregate({
    where: { tradeId: { in: closed.map((trade) => trade.id) } },
    _sum: { netTheta: true }
  });
  const thetaCollected = thetaAgg._sum.netTheta?.toNumber() ?? 0;
  if (thetaCollected <= 0) {
    return null;
  }
  const totalRealized = closed.reduce((sum, trade) => sum + (trade.realizedPnl?.toNumber() ?? 0), 0);
  return round2((totalRealized / thetaCollected) * 100);
}

// ------------------------------------------------------------------
// EOD mark-to-market + exit-rule engine (called by the worker).
// Phase 1: rules only FLAG; the user closes manually from the panel.
// ------------------------------------------------------------------

function profitTargetPct(strategyType: SimStrategyTypeName): number {
  return strategyType === "SHORT_STRADDLE" ? 30 : 50;
}

async function flagExitRuleOnce(tradeId: string, rule: "PROFIT_TARGET" | "HARD_STOP_3X" | "DTE_GAMMA" | "EXPIRY_ITM" | "DELIVERY_RISK", detail: string, client: PrismaClient): Promise<boolean> {
  const existing = await client.simExitEvent.findFirst({ where: { tradeId, rule } });
  if (existing) {
    return false;
  }
  await client.simExitEvent.create({
    data: { tradeId, rule, action: "FLAGGED", detail }
  });
  return true;
}

export interface SimEodResult {
  markedTrades: number;
  flaggedTrades: number;
  expiredTrades: number;
  skippedTrades: number;
}

export async function runSimEodMarkToMarket(asOf = new Date(), client: PrismaClient = prisma): Promise<SimEodResult> {
  const openTrades = await client.simTrade.findMany({
    where: { status: "OPEN" },
    include: { legs: true }
  });

  const result: SimEodResult = { markedTrades: 0, flaggedTrades: 0, expiredTrades: 0, skippedTrades: 0 };
  // Snapshot timestamps are normalized to the run date so the
  // (tradeId, ts) unique key makes re-runs idempotent per day.
  const ts = new Date(`${asOf.toISOString().slice(0, 10)}T00:00:00.000Z`);

  for (const trade of openTrades) {
    const expiryEnd = new Date(trade.expiryDate.getTime() + 86_400_000);
    if (asOf.getTime() >= expiryEnd.getTime()) {
      await settleExpiredSimTrade(trade, client);
      result.expiredTrades += 1;
      continue;
    }

    const closeCost = await computeTradeCloseCost(trade, client);
    if (!closeCost) {
      result.skippedTrades += 1;
      continue;
    }
    const netCredit = trade.netCredit.toNumber();
    const pnl = round2(netCredit - closeCost.closeCostTotal);

    await client.simMtmSnapshot.upsert({
      where: { tradeId_ts: { tradeId: trade.id, ts } },
      create: {
        tradeId: trade.id,
        ts,
        closeCost: closeCost.closeCostTotal,
        pnl,
        netDelta: closeCost.greeks.netDelta,
        netGamma: closeCost.greeks.netGamma,
        netTheta: closeCost.greeks.netTheta,
        netVega: closeCost.greeks.netVega,
        marginReq: trade.bpe
      },
      update: {
        closeCost: closeCost.closeCostTotal,
        pnl,
        netDelta: closeCost.greeks.netDelta,
        netGamma: closeCost.greeks.netGamma,
        netTheta: closeCost.greeks.netTheta,
        netVega: closeCost.greeks.netVega
      }
    });
    result.markedTrades += 1;

    let flagged = false;
    const targetPct = profitTargetPct(trade.strategyType);
    if (netCredit > 0 && pnl >= (targetPct / 100) * netCredit) {
      flagged = (await flagExitRuleOnce(trade.id, "PROFIT_TARGET", `P&L ${pnl.toFixed(0)} is ${((pnl / netCredit) * 100).toFixed(0)}% of max profit (target ${targetPct}%).`, client)) || flagged;
    }
    if (netCredit > 0 && closeCost.closeCostTotal >= HARD_STOP_MULTIPLE * netCredit) {
      flagged = (await flagExitRuleOnce(trade.id, "HARD_STOP_3X", `Cost to close ${closeCost.closeCostTotal.toFixed(0)} is ${(closeCost.closeCostTotal / netCredit).toFixed(1)}x the credit received.`, client)) || flagged;
    }
    const dte = daysToExpiry(trade.expiryDate, asOf);
    if (dte <= DTE_GAMMA_THRESHOLD_DAYS) {
      flagged = (await flagExitRuleOnce(trade.id, "DTE_GAMMA", `${dte} days to expiry - gamma risk window.`, client)) || flagged;
    }
    if (flagged) {
      result.flaggedTrades += 1;
    }
  }

  return result;
}

// ------------------------------------------------------------------
// Phase 3: stress grid ("what-if" view).
// Projects portfolio P&L and maintenance margin across spot +/-2% and
// IV +/-20% scenarios using per-leg greeks:
//   dPnL ~= delta*dS + 0.5*gamma*dS^2 + vega*dIV(vol points)
// Margin is re-derived with the shifted spot and a delta-adjusted premium,
// which is what makes short-strangle margin explode in the -2% cell.
// ------------------------------------------------------------------

export interface SimStressCell {
  spotShiftPct: number;
  ivShiftPct: number;
  pnlDelta: number;
  projectedMargin: number;
  marginCall: boolean;
}

export interface SimStressResult {
  nlv: number;
  currentMargin: number;
  cells: SimStressCell[];
}

const STRESS_SPOT_SHIFTS = [-2, 0, 2];
const STRESS_IV_SHIFTS = [-20, 0, 20];

export async function computeSimStress(user: AuthUserDto, client: PrismaClient = prisma): Promise<SimStressResult> {
  const account = await getOrCreateSimAccount(user, client);
  const openTrades = await client.simTrade.findMany({
    where: { accountId: account.id, status: "OPEN" },
    include: { legs: true }
  });

  interface StressLeg {
    sideSign: number;
    optionType: OptionType;
    strike: number;
    mid: number;
    delta: number;
    gamma: number;
    vega: number;
    iv: number | null;
    unitMultiplier: number;
    isShort: boolean;
  }
  interface StressTrade {
    definedRisk: boolean;
    staticBpe: number;
    deliveryRamp: boolean;
    spot: number;
    legs: StressLeg[];
  }

  const stressTrades: StressTrade[] = [];
  let totalUnrealized = 0;
  let currentMargin = 0;

  for (const trade of openTrades) {
    const spot = await getLatestSpot(trade.underlyingSymbol, client);
    const closeCost = await computeTradeCloseCost(trade, client);
    if (closeCost) {
      totalUnrealized += trade.netCredit.toNumber() - closeCost.closeCostTotal;
    }
    currentMargin += await computeDynamicMarginForTrade(trade, client);
    if (spot === null) {
      continue;
    }
    const unitMultiplier = trade.lotSize * trade.lots;
    const legs: StressLeg[] = [];
    for (const leg of trade.legs) {
      const tick = await getLatestLegTick(trade.underlyingSymbol, trade.expiryLabel, leg.optionType, leg.strikePrice.toNumber(), client);
      if (!tick) {
        continue;
      }
      const mid = tick.bid !== null && tick.ask !== null ? (tick.bid + tick.ask) / 2 : tick.last ?? 0;
      legs.push({
        sideSign: leg.side === "SELL" ? -1 : 1,
        optionType: leg.optionType,
        strike: leg.strikePrice.toNumber(),
        mid,
        delta: tick.delta ?? 0,
        gamma: tick.gamma ?? 0,
        vega: tick.vega ?? 0,
        iv: tick.iv,
        unitMultiplier,
        isShort: leg.side === "SELL"
      });
    }
    stressTrades.push({
      definedRisk: trade.maxLoss !== null,
      staticBpe: trade.bpe.toNumber(),
      deliveryRamp: !isIndexUnderlying(trade.underlyingSymbol) && daysToExpiry(trade.expiryDate) <= DTE_GAMMA_THRESHOLD_DAYS,
      spot,
      legs
    });
  }

  const nlv = round2(account.cash.toNumber() + totalUnrealized);

  const evaluateScenario = (spotShiftPct: number, ivShiftPct: number): { pnlDelta: number; projectedMargin: number } => {
    let pnlDelta = 0;
    let projectedMargin = 0;
    for (const trade of stressTrades) {
      const dS = trade.spot * (spotShiftPct / 100);
      let tradeMarginPerUnit = 0;
      for (const leg of trade.legs) {
        const dIvPoints = leg.iv !== null ? leg.iv * (ivShiftPct / 100) : 0;
        pnlDelta += leg.sideSign * (leg.delta * dS + 0.5 * leg.gamma * dS * dS + leg.vega * dIvPoints) * leg.unitMultiplier;
        if (!trade.definedRisk && leg.isShort) {
          const shiftedSpot = trade.spot + dS;
          const shiftedPremium = Math.max(leg.mid + leg.delta * dS + 0.5 * leg.gamma * dS * dS + leg.vega * dIvPoints, 0.05);
          const otmAmount = leg.optionType === "CE" ? Math.max(0, leg.strike - shiftedSpot) : Math.max(0, shiftedSpot - leg.strike);
          tradeMarginPerUnit += Math.max(UNDEFINED_RISK_MARGIN_PCT * shiftedSpot + shiftedPremium - otmAmount, 0.1 * shiftedSpot);
        }
      }
      if (trade.definedRisk) {
        projectedMargin += trade.staticBpe;
      } else {
        const unitMultiplier = trade.legs[0]?.unitMultiplier ?? 0;
        projectedMargin += tradeMarginPerUnit * unitMultiplier * (trade.deliveryRamp ? DELIVERY_WEEK_MARGIN_MULTIPLIER : 1);
      }
    }
    return { pnlDelta: round2(pnlDelta), projectedMargin: round2(projectedMargin) };
  };

  const cells: SimStressCell[] = [];
  for (const ivShiftPct of STRESS_IV_SHIFTS) {
    for (const spotShiftPct of STRESS_SPOT_SHIFTS) {
      const { pnlDelta, projectedMargin } = evaluateScenario(spotShiftPct, ivShiftPct);
      cells.push({
        spotShiftPct,
        ivShiftPct,
        pnlDelta,
        projectedMargin,
        marginCall: projectedMargin > nlv + pnlDelta
      });
    }
  }

  return { nlv, currentMargin: round2(currentMargin), cells };
}

// ------------------------------------------------------------------
// Phase 2: intraday engine - MTM sampling + automated exits.
// Runs every minute during market hours (worker schedules it). Unlike the
// EOD job it CLOSES positions instead of only flagging:
//   - profit target (30% straddle / 50% defined-risk)
//   - hard stop at 3x credit
//   - DTE <= 7 gamma trigger (MONTHLY horizon only - Indian weekly options
//     live their whole life inside 7 DTE, so auto-closing weeklies on this
//     rule would close every weekly trade at entry)
//   - 2x delta stop (INTRADAY horizon: any short leg whose |delta| doubles
//     from entry has moved structurally against the writer)
// ------------------------------------------------------------------

const INTRADAY_MTM_SAMPLE_MS = 5 * 60 * 1000;

export interface SimIntradayResult {
  evaluatedTrades: number;
  autoClosedTrades: number;
  sampledTrades: number;
  skippedTrades: number;
  liquidatedTrades: number;
}

async function autoCloseSimTrade(trade: { id: string; accountId: string; netCredit: { toNumber(): number } }, closeCost: TradeCloseCost, rule: "PROFIT_TARGET" | "HARD_STOP_3X" | "DTE_GAMMA" | "DELTA_2X_INTRADAY", detail: string, client: PrismaClient): Promise<boolean> {
  const didClose = await executeSimTradeClose(trade, closeCost, `AUTO_${rule}`, client);
  if (didClose) {
    await client.simExitEvent.create({
      data: { tradeId: trade.id, rule, action: "AUTO_CLOSED", detail }
    });
  }
  return didClose;
}

export async function runSimIntradayEngine(asOf = new Date(), client: PrismaClient = prisma): Promise<SimIntradayResult> {
  const openTrades = await client.simTrade.findMany({
    where: { status: "OPEN" },
    include: { legs: true }
  });

  const result: SimIntradayResult = { evaluatedTrades: 0, autoClosedTrades: 0, sampledTrades: 0, skippedTrades: 0, liquidatedTrades: 0 };

  for (const trade of openTrades) {
    // Trades past expiry are the EOD job's business (intrinsic settlement).
    if (asOf.getTime() >= trade.expiryDate.getTime() + 86_400_000) {
      continue;
    }
    const closeCost = await computeTradeCloseCost(trade, client);
    if (!closeCost) {
      result.skippedTrades += 1;
      continue;
    }
    result.evaluatedTrades += 1;
    const netCredit = trade.netCredit.toNumber();
    const pnl = round2(netCredit - closeCost.closeCostTotal);

    // --- Automated exits (first matching rule wins) ---
    let closed = false;
    const targetPct = profitTargetPct(trade.strategyType);
    if (netCredit > 0 && pnl >= (targetPct / 100) * netCredit) {
      closed = await autoCloseSimTrade(trade, closeCost, "PROFIT_TARGET", `Auto-closed at ${((pnl / netCredit) * 100).toFixed(0)}% of max profit (target ${targetPct}%).`, client);
    } else if (netCredit > 0 && closeCost.closeCostTotal >= HARD_STOP_MULTIPLE * netCredit) {
      closed = await autoCloseSimTrade(trade, closeCost, "HARD_STOP_3X", `Auto-closed: cost to close ${closeCost.closeCostTotal.toFixed(0)} reached ${(closeCost.closeCostTotal / netCredit).toFixed(1)}x credit.`, client);
    } else if (trade.horizon === "MONTHLY" && daysToExpiry(trade.expiryDate, asOf) <= DTE_GAMMA_THRESHOLD_DAYS) {
      closed = await autoCloseSimTrade(trade, closeCost, "DTE_GAMMA", `Auto-closed: ${daysToExpiry(trade.expiryDate, asOf)} DTE - exiting the gamma risk window.`, client);
    } else if (trade.horizon === "INTRADAY") {
      for (const leg of trade.legs) {
        if (leg.side !== "SELL" || !leg.deltaAtFill) {
          continue;
        }
        const entryDelta = Math.abs(leg.deltaAtFill.toNumber());
        if (entryDelta === 0) {
          continue;
        }
        const tick = await getLatestLegTick(trade.underlyingSymbol, trade.expiryLabel, leg.optionType, leg.strikePrice.toNumber(), client);
        if (tick?.delta != null && Math.abs(tick.delta) >= 2 * entryDelta) {
          closed = await autoCloseSimTrade(trade, closeCost, "DELTA_2X_INTRADAY", `Auto-closed: ${leg.optionType} ${leg.strikePrice.toNumber()} delta ${Math.abs(tick.delta).toFixed(2)} doubled from entry ${entryDelta.toFixed(2)}.`, client);
          break;
        }
      }
    }
    if (closed) {
      result.autoClosedTrades += 1;
      continue;
    }

    // --- Phase 3: delivery-risk flag (stock options, ITM inside expiry week) ---
    if (!isIndexUnderlying(trade.underlyingSymbol) && daysToExpiry(trade.expiryDate, asOf) <= DTE_GAMMA_THRESHOLD_DAYS) {
      const spot = await getLatestSpot(trade.underlyingSymbol, client);
      if (spot !== null) {
        const itmShortLeg = trade.legs.find((leg) => leg.side === "SELL" && (leg.optionType === "CE" ? spot > leg.strikePrice.toNumber() : spot < leg.strikePrice.toNumber()));
        if (itmShortLeg) {
          await flagExitRuleOnce(trade.id, "DELIVERY_RISK", `Short ${itmShortLeg.optionType} ${itmShortLeg.strikePrice.toNumber()} is ITM inside expiry week - physical delivery obligation; margin ramped ${DELIVERY_WEEK_MARGIN_MULTIPLIER}x.`, client);
        }
      }
    }

    // --- Intraday MTM sampling (capped to one row per 5 minutes) ---
    const lastSnapshot = await client.simMtmSnapshot.findFirst({
      where: { tradeId: trade.id },
      orderBy: { ts: "desc" },
      select: { ts: true }
    });
    if (!lastSnapshot || asOf.getTime() - lastSnapshot.ts.getTime() >= INTRADAY_MTM_SAMPLE_MS) {
      await client.simMtmSnapshot.create({
        data: {
          tradeId: trade.id,
          ts: asOf,
          closeCost: closeCost.closeCostTotal,
          pnl,
          netDelta: closeCost.greeks.netDelta,
          netGamma: closeCost.greeks.netGamma,
          netTheta: closeCost.greeks.netTheta,
          netVega: closeCost.greeks.netVega,
          marginReq: await computeDynamicMarginForTrade(trade, client, asOf)
        }
      });
      result.sampledTrades += 1;
    }
  }

  // --- Phase 3: margin-call sweep, per account ---
  // If an account's maintenance margin exceeds its NLV, liquidate the
  // largest margin consumer first (broker RMS behavior) until it fits.
  result.liquidatedTrades = await runSimMarginCallSweep(asOf, client);

  return result;
}

async function runSimMarginCallSweep(asOf: Date, client: PrismaClient): Promise<number> {
  const openTrades = await client.simTrade.findMany({
    where: { status: "OPEN" },
    include: { legs: true, account: true }
  });
  if (openTrades.length === 0) {
    return 0;
  }

  interface MarginEntry {
    trade: (typeof openTrades)[number];
    margin: number;
    closeCost: TradeCloseCost | null;
    unrealized: number;
  }
  const byAccount = new Map<string, MarginEntry[]>();
  for (const trade of openTrades) {
    const margin = await computeDynamicMarginForTrade(trade, client, asOf);
    const closeCost = await computeTradeCloseCost(trade, client);
    const unrealized = closeCost ? trade.netCredit.toNumber() - closeCost.closeCostTotal : 0;
    const list = byAccount.get(trade.accountId) ?? [];
    list.push({ trade, margin, closeCost, unrealized });
    byAccount.set(trade.accountId, list);
  }

  let liquidated = 0;
  for (const entries of byAccount.values()) {
    const account = entries[0].trade.account;
    let totalMargin = entries.reduce((sum, entry) => sum + entry.margin, 0);
    let nlv = account.cash.toNumber() + entries.reduce((sum, entry) => sum + entry.unrealized, 0);
    if (totalMargin <= nlv) {
      continue;
    }
    // Largest margin consumer first.
    entries.sort((a, b) => b.margin - a.margin);
    for (const entry of entries) {
      if (totalMargin <= nlv || !entry.closeCost) {
        continue;
      }
      const didClose = await executeSimTradeClose(entry.trade, entry.closeCost, "MARGIN_CALL_LIQUIDATION", client, "LIQUIDATED");
      if (!didClose) {
        continue;
      }
      await client.simExitEvent.create({
        data: {
          tradeId: entry.trade.id,
          rule: "MARGIN_CALL",
          action: "LIQUIDATED",
          detail: `Maintenance margin ${totalMargin.toFixed(0)} exceeded NLV ${nlv.toFixed(0)}; position force-closed (margin ${entry.margin.toFixed(0)}).`
        }
      });
      liquidated += 1;
      // NLV is unchanged by the liquidation itself (the unrealized P&L just
      // became realized at the same price); only the margin demand drops.
      totalMargin -= entry.margin;
    }
  }
  return liquidated;
}

// Expiry settlement: each leg settles at intrinsic value against the latest
// spot (indexes are cash settled; stock delivery risk is a Phase 3 concern).
async function settleExpiredSimTrade(trade: { id: string; accountId: string; underlyingSymbol: string; netCredit: { toNumber(): number }; lotSize: number; lots: number; legs: Array<{ id: string; side: string; optionType: OptionType; strikePrice: { toNumber(): number } }> }, client: PrismaClient): Promise<void> {
  const spot = await getLatestSpot(trade.underlyingSymbol, client);
  const unitMultiplier = trade.lotSize * trade.lots;
  let settleCostPerUnit = 0;
  let anyItm = false;
  const legFills: Array<{ legId: string; closeFillPrice: number }> = [];

  for (const leg of trade.legs) {
    const strike = leg.strikePrice.toNumber();
    const intrinsic = spot === null ? 0 : leg.optionType === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    if (intrinsic > 0) {
      anyItm = true;
    }
    settleCostPerUnit += leg.side === "SELL" ? intrinsic : -intrinsic;
    legFills.push({ legId: leg.id, closeFillPrice: round2(intrinsic) });
  }

  const settleCost = round2(settleCostPerUnit * unitMultiplier);
  const realizedPnl = round2(trade.netCredit.toNumber() - settleCost);
  const now = new Date();

  await client.$transaction(async (tx) => {
    const updated = await tx.simTrade.updateMany({
      where: { id: trade.id, status: "OPEN" },
      data: { status: "EXPIRED", closedAt: now, exitReason: anyItm ? "EXPIRED_ITM_SETTLED" : "EXPIRED_WORTHLESS", realizedPnl }
    });
    if (updated.count === 0) {
      return;
    }
    for (const fill of legFills) {
      await tx.simLeg.update({ where: { id: fill.legId }, data: { closeFillPrice: fill.closeFillPrice } });
    }
    await tx.simAccount.update({
      where: { id: trade.accountId },
      data: { cash: { increment: realizedPnl } }
    });
    if (anyItm) {
      await tx.simExitEvent.create({
        data: { tradeId: trade.id, rule: "EXPIRY_ITM", action: "FLAGGED", detail: `Settled at intrinsic value; P&L ${realizedPnl.toFixed(0)}.` }
      });
    }
  });
}

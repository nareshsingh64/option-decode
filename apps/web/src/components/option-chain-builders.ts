import type { MarketOverview, OverviewTick } from "./live-dashboard";
import { classifyOptionActivity, type OptionActivityKind } from "./strike-pressure-analytics";

export type { OptionActivityKind };
export type NumberFormatMode = "indian" | "metric";
export type QuantityDisplayMode = "lots" | "numbers";

// Used only as a stand-in for the expected-move calculation when the real
// India VIX quote is unavailable. Callers must check vixAvailable before
// trusting/displaying `vix` - this default exists purely so the strike
// range still renders something, not because 15% is a real reading.
const DEFAULT_VIX_FALLBACK = 15;

export interface VixStrikeRange {
  lower: number;
  upper: number;
  expectedMove: number;
  vix: number;
  vixAvailable: boolean;
  // "atm": centered on the live ATM strike (what the caller asked for).
  // "vix": derived from the VIX expected-move formula instead - either
  // because the caller asked for VIX mode directly, or because ATM mode
  // was requested but the current ATM strike couldn't be located in the
  // chain, and this is a silent-fallback path callers should surface.
  rangeMode: "atm" | "vix";
}

export interface DisplayPreferences {
  numberFormatMode: NumberFormatMode;
  quantityDisplayMode: QuantityDisplayMode;
}

export function buildVixStrikeRange(overview: MarketOverview): VixStrikeRange {
  const spot = overview.snapshot.spotPrice;
  const vixAvailable = Boolean(overview.indiaVix && overview.indiaVix > 0);
  const vix = vixAvailable ? (overview.indiaVix as number) : DEFAULT_VIX_FALLBACK;
  const daysToExpiry = getDaysToExpiry(overview.snapshot.expiry, overview.snapshot.snapshotTime);
  const expectedMove = spot > 0 ? spot * (vix / 100) * Math.sqrt(daysToExpiry / 365) : 0;

  return {
    lower: Math.max(0, spot - expectedMove),
    upper: spot + expectedMove,
    expectedMove,
    vix,
    vixAvailable,
    rangeMode: "vix"
  };
}

export function buildAtmStrikeRange(overview: MarketOverview): VixStrikeRange {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === overview.snapshot.atmStrike);
  if (atmIndex < 0) {
    // ATM strike isn't in the current chain (stale/mismatched snapshot) -
    // fall back to the VIX-derived range. rangeMode stays "vix" so callers
    // that asked for "atm" can detect the fallback happened and say so.
    return buildVixStrikeRange(overview);
  }
  const visibleStrikes = strikes.slice(Math.max(0, atmIndex - 6), atmIndex + 7);
  return {
    lower: visibleStrikes[0] ?? overview.snapshot.atmStrike,
    upper: visibleStrikes[visibleStrikes.length - 1] ?? overview.snapshot.atmStrike,
    expectedMove: Math.abs((visibleStrikes[visibleStrikes.length - 1] ?? overview.snapshot.atmStrike) - overview.snapshot.atmStrike),
    vix: overview.indiaVix && overview.indiaVix > 0 ? overview.indiaVix : DEFAULT_VIX_FALLBACK,
    vixAvailable: Boolean(overview.indiaVix && overview.indiaVix > 0),
    rangeMode: "atm"
  };
}

function getDaysToExpiry(expiry: string, snapshotTime: string) {
  const expiryTime = Date.parse(`${expiry}T15:30:00+05:30`);
  const snapshotDate = Date.parse(snapshotTime);
  if (!Number.isFinite(expiryTime) || !Number.isFinite(snapshotDate)) {
    return 1;
  }
  return Math.max(1, Math.ceil((expiryTime - snapshotDate) / 86_400_000));
}

export function buildChainRows(overview: MarketOverview, range: VixStrikeRange, preferences: DisplayPreferences) {
  const ticksByStrike = new Map<number, Partial<Record<"CE" | "PE", OverviewTick>>>();

  for (const tick of overview.snapshot.ticks) {
    const row = ticksByStrike.get(tick.strikePrice) ?? {};
    row[tick.optionType] = tick;
    ticksByStrike.set(tick.strikePrice, row);
  }

  const allRows = [...ticksByStrike.entries()]
    .filter(([strike]) => strike >= range.lower && strike <= range.upper)
    .map(([strike, pair]) => ({
      strike,
      ceOi: formatQuantityValue(pair.CE?.openInterest, pair.CE, preferences),
      ceOiLots: toLots(pair.CE?.openInterest, pair.CE),
      ceOiRaw: pair.CE?.openInterest ?? 0,
      ceChg: formatQuantityValue(pair.CE?.changeInOpenInterest, pair.CE, preferences, true),
      ceChgSignedLots: toLots(pair.CE?.changeInOpenInterest, pair.CE),
      ceChgLots: Math.abs(toLots(pair.CE?.changeInOpenInterest, pair.CE)),
      ceChgRaw: Math.abs(pair.CE?.changeInOpenInterest ?? 0),
      ceVol: formatQuantityValue(pair.CE?.volume, pair.CE, preferences),
      ceVolLots: toLots(pair.CE?.volume, pair.CE),
      ceVolRaw: pair.CE?.volume ?? 0,
      ceLtp: pair.CE?.lastPrice,
      ceLtpChange: pair.CE?.lastPriceChange,
      ceLtpChangePercent: pair.CE?.lastPriceChangePercent,
      ceActivity: classifyOptionActivity(pair.CE),
      ceIv: pair.CE?.impliedVolatility,
      ceDelta: pair.CE?.delta,
      ceGamma: pair.CE?.gamma,
      ceTheta: pair.CE?.theta,
      ceVega: pair.CE?.vega,
      peLtp: pair.PE?.lastPrice,
      peLtpChange: pair.PE?.lastPriceChange,
      peLtpChangePercent: pair.PE?.lastPriceChangePercent,
      peActivity: classifyOptionActivity(pair.PE),
      peIv: pair.PE?.impliedVolatility,
      peDelta: pair.PE?.delta,
      peGamma: pair.PE?.gamma,
      peTheta: pair.PE?.theta,
      peVega: pair.PE?.vega,
      peVol: formatQuantityValue(pair.PE?.volume, pair.PE, preferences),
      peVolLots: toLots(pair.PE?.volume, pair.PE),
      peVolRaw: pair.PE?.volume ?? 0,
      peChg: formatQuantityValue(pair.PE?.changeInOpenInterest, pair.PE, preferences, true),
      peChgSignedLots: toLots(pair.PE?.changeInOpenInterest, pair.PE),
      peChgLots: Math.abs(toLots(pair.PE?.changeInOpenInterest, pair.PE)),
      peChgRaw: Math.abs(pair.PE?.changeInOpenInterest ?? 0),
      peOi: formatQuantityValue(pair.PE?.openInterest, pair.PE, preferences),
      peOiLots: toLots(pair.PE?.openInterest, pair.PE),
      peOiRaw: pair.PE?.openInterest ?? 0,
      ceOiPercent: 0,
      ceChgPercent: 0,
      ceVolPercent: 0,
      peOiPercent: 0,
      peChgPercent: 0,
      peVolPercent: 0,
      ceOiRank: undefined as 1 | 2 | undefined,
      ceChgRank: undefined as 1 | 2 | undefined,
      ceVolRank: undefined as 1 | 2 | undefined,
      peOiRank: undefined as 1 | 2 | undefined,
      peChgRank: undefined as 1 | 2 | undefined,
      peVolRank: undefined as 1 | 2 | undefined
    }))
    .sort((left, right) => right.strike - left.strike);

  const visibleRows = allRows;

  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceOiLots, row.ceOiRaw, preferences), (row, percent) => {
    row.ceOiPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceChgLots, row.ceChgRaw, preferences), (row, percent) => {
    row.ceChgPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceVolLots, row.ceVolRaw, preferences), (row, percent) => {
    row.ceVolPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peOiLots, row.peOiRaw, preferences), (row, percent) => {
    row.peOiPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peChgLots, row.peChgRaw, preferences), (row, percent) => {
    row.peChgPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peVolLots, row.peVolRaw, preferences), (row, percent) => {
    row.peVolPercent = percent;
  });

  applyPressureRanks(visibleRows, (row) => row.ceOiLots, (row, rank) => {
    row.ceOiRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.ceChgLots, (row, rank) => {
    row.ceChgRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.ceVolLots, (row, rank) => {
    row.ceVolRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.peOiLots, (row, rank) => {
    row.peOiRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.peChgLots, (row, rank) => {
    row.peChgRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.peVolLots, (row, rank) => {
    row.peVolRank = rank;
  });

  return visibleRows;
}

export function buildOiBuildupRows(chainRows: ReturnType<typeof buildChainRows>, atmStrike: number, numberFormatMode: NumberFormatMode) {
  const maxOi = Math.max(0, ...chainRows.flatMap((row) => [row.ceOiLots, row.peOiLots]));
  const oiPercent = (value: number) => (maxOi > 0 && value > 0 ? Math.max(3, Math.round((value / maxOi) * 100)) : 0);
  return chainRows.map((row) => ({
    strike: row.strike,
    isAtm: row.strike === atmStrike,
    cePercent: oiPercent(row.ceOiLots),
    pePercent: oiPercent(row.peOiLots),
    ceBuilding: row.ceChgSignedLots >= 0,
    peBuilding: row.peChgSignedLots >= 0,
    ceLabel: formatLarge(row.ceOiLots, numberFormatMode),
    peLabel: formatLarge(row.peOiLots, numberFormatMode)
  }));
}

export function buildIvSkewRows(chainRows: ReturnType<typeof buildChainRows>) {
  const rows = [...chainRows].sort((left, right) => left.strike - right.strike);
  const ivValues = rows.flatMap((row) => [row.ceIv, row.peIv]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const minIv = ivValues.length ? Math.min(...ivValues) : 0;
  const maxIv = ivValues.length ? Math.max(...ivValues) : 1;
  const ivRange = Math.max(1, maxIv - minIv);
  const width = 520;
  const height = 180;
  const padding = 22;
  const xRange = Math.max(1, rows.length - 1);
  const yForIv = (iv?: number) => {
    if (iv === undefined || !Number.isFinite(iv)) {
      return undefined;
    }
    return height - padding - ((iv - minIv) / ivRange) * (height - padding * 2);
  };

  return rows.map((row, index) => ({
    strike: row.strike,
    x: padding + (index / xRange) * (width - padding * 2),
    ceY: yForIv(row.ceIv),
    peY: yForIv(row.peIv)
  }));
}

function displayRankValue(lotsValue: number, rawValue: number, preferences: DisplayPreferences) {
  return preferences.quantityDisplayMode === "lots" ? lotsValue : rawValue;
}

function applyPressurePercents<T>(rows: T[], getValue: (row: T) => number, setPercent: (row: T, percent: number) => void) {
  const maxValue = Math.max(0, ...rows.map(getValue));
  for (const row of rows) {
    const percent = maxValue > 0 ? Math.round((getValue(row) / maxValue) * 100) : 0;
    setPercent(row, percent);
  }
}

function applyPressureRanks<T>(rows: T[], getValue: (row: T) => number, setRank: (row: T, rank: 1 | 2) => void) {
  const rankedRows = [...rows]
    .filter((row) => getValue(row) > 0)
    .sort((left, right) => getValue(right) - getValue(left))
    .slice(0, 2);

  rankedRows.forEach((row, index) => {
    setRank(row, (index + 1) as 1 | 2);
  });
}

export function buildTopStrikeRows(overview: MarketOverview, preferences: DisplayPreferences) {
  const getQuantity = (tick: OverviewTick) => (preferences.quantityDisplayMode === "lots" ? toLots(tick.openInterest, tick) : tick.openInterest ?? 0);
  return [...overview.snapshot.ticks]
    .filter((tick) => (tick.openInterest ?? 0) > 0)
    .sort((left, right) => getQuantity(right) - getQuantity(left))
    .slice(0, 4)
    .map((tick) => ({
      strike: tick.strikePrice,
      optionType: tick.optionType,
      openInterest: getQuantity(tick),
      changePercent: tick.openInterest ? ((tick.changeInOpenInterest ?? 0) / tick.openInterest) * 100 : 0
    }));
}

// Deliberately NOT reusing @option-decode/analytics' calculateChainStats
// here: that server-side version always sums raw contract-count OI, while
// this client version needs to optionally convert to lots depending on the
// user's quantityDisplayMode preference. The breadth-dominance ratio (1.05)
// below must stay in sync with the same constant in
// packages/analytics/src/index.ts's calculateChainStats - if one changes,
// update the other, or "OI Breadth" can disagree between this page and any
// server-computed view of the same snapshot.
export function buildChainStats(overview: MarketOverview, preferences: DisplayPreferences) {
  const ceTicks = overview.snapshot.ticks.filter((tick) => tick.optionType === "CE");
  const peTicks = overview.snapshot.ticks.filter((tick) => tick.optionType === "PE");
  const getQuantity = (value: number | undefined, tick: OverviewTick) => (preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value ?? 0);
  const totalCeOi = ceTicks.reduce((sum, tick) => sum + getQuantity(tick.openInterest, tick), 0);
  const totalPeOi = peTicks.reduce((sum, tick) => sum + getQuantity(tick.openInterest, tick), 0);
  const totalCeChange = ceTicks.reduce((sum, tick) => sum + getQuantity(tick.changeInOpenInterest, tick), 0);
  const totalPeChange = peTicks.reduce((sum, tick) => sum + getQuantity(tick.changeInOpenInterest, tick), 0);
  const maxOiTick = [...overview.snapshot.ticks].sort((left, right) => getQuantity(right.openInterest, right) - getQuantity(left.openInterest, left))[0];
  const breadth = totalPeOi > totalCeOi * 1.05 ? "Put Support" : totalCeOi > totalPeOi * 1.05 ? "Call Resistance" : "Balanced";

  return {
    totalCeOi,
    totalPeOi,
    totalCeChange,
    totalPeChange,
    breadth,
    maxOiStrikeText: maxOiTick ? `${formatStrike(maxOiTick.strikePrice)} ${maxOiTick.optionType}` : "--",
    maxOiSide: maxOiTick ? `${formatQuantityValue(maxOiTick.openInterest, maxOiTick, preferences)} OI` : "--"
  };
}

export type ChainStats = ReturnType<typeof buildChainStats>;
export type ChainRow = ReturnType<typeof buildChainRows>[number];
export type TopStrikeRow = ReturnType<typeof buildTopStrikeRows>[number];

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function formatLarge(value?: number, mode: NumberFormatMode = "indian") {
  if (value === undefined) {
    return "--";
  }
  const absoluteValue = Math.abs(value);
  if (mode === "metric") {
    if (absoluteValue >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(1)}B`;
    }
    if (absoluteValue >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (absoluteValue >= 1000) {
      return `${(value / 1000).toFixed(0)}K`;
    }
    return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }
  if (absoluteValue >= 10000000) {
    return `${(value / 10000000).toFixed(1)}Cr`;
  }
  if (absoluteValue >= 100000) {
    return `${(value / 100000).toFixed(1)}L`;
  }
  if (absoluteValue >= 1000) {
    return `${(value / 1000).toFixed(0)}K`;
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function toLots(value: number | undefined, tick?: Pick<OverviewTick, "lotSize" | "underlyingSymbol">) {
  const lotSize = tick?.lotSize && tick.lotSize > 0 ? tick.lotSize : getLotSizeForUnderlying(tick?.underlyingSymbol);
  return (value ?? 0) / lotSize;
}

function formatQuantityValue(value: number | undefined, tick: OverviewTick | undefined, preferences: DisplayPreferences, signed = false) {
  if (value === undefined) {
    return "--";
  }
  const displayValue = preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value;
  const sign = signed && displayValue >= 0 ? "+" : "";
  return `${sign}${formatLarge(displayValue, preferences.numberFormatMode)}`;
}

function getLotSizeForUnderlying(underlyingSymbol?: string) {
  const lotSizes: Record<string, number> = {
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
  return lotSizes[String(underlyingSymbol ?? "").toUpperCase()] ?? 1;
}

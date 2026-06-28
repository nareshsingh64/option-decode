import type { OverviewTick } from "./live-dashboard";
import type { DisplayPreferences } from "./option-chain-builders";

export type NumberFormatMode = "indian" | "metric";

interface MarketTickerItem {
  symbol: string;
  displayName: string;
  segment: string;
  spotPrice?: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
}

export function mergeTickerItems(currentItems: MarketTickerItem[], nextItems: MarketTickerItem[]) {
  if (!nextItems.length) {
    return currentItems;
  }

  const seenSymbols = new Set<string>();
  const nextBySymbol = new Map(nextItems.map((item) => [item.symbol, item]));
  const mergedItems = currentItems.map((currentItem) => {
    seenSymbols.add(currentItem.symbol);
    const nextItem = nextBySymbol.get(currentItem.symbol);
    if (!nextItem) {
      return currentItem;
    }

    return mergeTickerItem(currentItem, nextItem);
  });

  for (const nextItem of nextItems) {
    if (!seenSymbols.has(nextItem.symbol)) {
      mergedItems.push(nextItem);
    }
  }

  return mergedItems;
}

function mergeTickerItem(currentItem: MarketTickerItem, nextItem: MarketTickerItem) {
  const spotPrice = isValidTickerNumber(nextItem.spotPrice) ? nextItem.spotPrice : currentItem.spotPrice;
  const previousClose = isValidTickerNumber(nextItem.previousClose) ? nextItem.previousClose : currentItem.previousClose;
  const change = nextItem.change ?? (spotPrice !== undefined && previousClose ? spotPrice - previousClose : currentItem.change);
  const changePercent = nextItem.changePercent ?? (change !== undefined && previousClose ? (change / previousClose) * 100 : currentItem.changePercent);

  return {
    ...nextItem,
    spotPrice,
    previousClose,
    change,
    changePercent
  };
}

function isValidTickerNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function formatPrice(value?: number) {
  return value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

export function normalizeTradablePrice(value: number, tickSize = 0.05) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Number((Math.ceil((value - 1e-9) / tickSize) * tickSize).toFixed(2));
}

export function formatTradablePrice(value: number, tickSize = 0.05) {
  return normalizeTradablePrice(value, tickSize).toFixed(2);
}

export function getDefaultTrailDistanceForEntry(entryPrice: number) {
  return normalizeTradablePrice(entryPrice * 0.18);
}

export function getDefaultTargetPrice(action: string, entryPrice: number) {
  return normalizeTradablePrice(action === "BUY" ? entryPrice * 1.35 : Math.max(0, entryPrice * 0.65));
}

export function getTrailingStopLoss(action: string, referencePrice: number, trailDistance: number) {
  const rawStopLoss = action === "BUY" ? Math.max(0, referencePrice - trailDistance) : referencePrice + trailDistance;
  return normalizeTradablePrice(rawStopLoss);
}

export function formatIstTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const istDate = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const hours = String(istDate.getUTCHours()).padStart(2, "0");
  const minutes = String(istDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(istDate.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function formatIstShortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const istDate = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const day = String(istDate.getUTCDate()).padStart(2, "0");
  const month = monthNames[istDate.getUTCMonth()] ?? "Jan";
  const hours = String(istDate.getUTCHours()).padStart(2, "0");
  const minutes = String(istDate.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}`;
}

export function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function formatLarge(value?: number, mode: NumberFormatMode = "indian") {
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

export function toLots(value: number | undefined, tick?: Pick<OverviewTick, "lotSize" | "underlyingSymbol">) {
  const lotSize = tick?.lotSize && tick.lotSize > 0 ? tick.lotSize : getLotSizeForUnderlying(tick?.underlyingSymbol);
  return (value ?? 0) / lotSize;
}

export function formatQuantityValue(value: number | undefined, tick: OverviewTick | undefined, preferences: DisplayPreferences, signed = false) {
  if (value === undefined) {
    return "--";
  }
  const displayValue = preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value;
  const sign = signed && displayValue >= 0 ? "+" : "";
  return `${sign}${formatLarge(displayValue, preferences.numberFormatMode)}`;
}

export function formatOptionalNumber(value: number | undefined, digits: number) {
  if (value === undefined) {
    return "--";
  }
  return value.toFixed(digits);
}

export function getLotSizeForUnderlying(underlyingSymbol?: string) {
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

export function formatLotsAndQty(lots: number, lotSize: number, quantity: number) {
  return `${lots} x ${lotSize} = ${quantity} qty`;
}

export function formatCurrency(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

export function formatLtpChange(value?: number, percent?: number) {
  if (value === undefined) {
    return "Chg --";
  }

  const sign = value >= 0 ? "+" : "";
  const percentText = percent === undefined ? "" : ` (${sign}${percent.toFixed(1)}%)`;
  return `${sign}${value.toFixed(2)}${percentText}`;
}

export function formatSignedLarge(value?: number, mode: NumberFormatMode = "indian") {
  if (value === undefined) {
    return "--";
  }
  return `${value >= 0 ? "+" : ""}${formatLarge(value, mode)}`;
}

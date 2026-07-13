import type { OptionChainSnapshot, OptionContractTick, UnderlyingDefinition, UnderlyingSymbol } from "@option-decode/types";

export interface DhanClientOptions {
  baseUrl: string;
  clientId: string;
  accessToken: string;
  requestTimeoutMs?: number;
}

export interface DhanOptionChainRequest {
  underlying: UnderlyingDefinition;
  expiry: string;
  spotPriceOverride?: number;
}

export interface DhanOhlcQuote {
  securityId: number;
  lastPrice?: number;
  previousClose?: number;
}

interface CommodityFutureQuote {
  securityId: number;
  expiryDate: string;
}

// Dhan's F&O trading segment differs from the UnderlyingDefinition.segment
// used for option-chain lookups (which is IDX_I for every index, spot or
// otherwise). Margin calculation needs the real order-routing segment.
const BSE_UNDERLYING_KEYS = new Set(["SENSEX", "BANKEX"]);
const MCX_UNDERLYING_KEYS = new Set(["CRUDEOIL", "NATURALGAS", "COPPER", "SILVER"]);

export function getFnoExchangeSegment(underlyingKey: string): "NSE_FNO" | "BSE_FNO" | "MCX_COMM" {
  const key = normalizeUnderlyingKeyForSegment(underlyingKey);
  if (MCX_UNDERLYING_KEYS.has(key)) return "MCX_COMM";
  if (BSE_UNDERLYING_KEYS.has(key)) return "BSE_FNO";
  return "NSE_FNO";
}

function normalizeUnderlyingKeyForSegment(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

export interface DhanMarginLegInput {
  transactionType: "BUY" | "SELL";
  quantity: number;
  securityId: string;
  price: number;
  exchangeSegment?: "NSE_FNO" | "BSE_FNO" | "MCX_COMM";
  productType?: "CNC" | "INTRADAY" | "MARGIN" | "MTF";
}

export interface DhanMultiOrderMarginResult {
  totalMargin: number;
  spanMargin: number;
  exposureMargin: number;
  equityMargin: number;
  foMargin: number;
  commodityMargin: number;
  currency: string;
  hedgeBenefit?: string;
}

export class DhanApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DhanApiError";
  }
}

const DHAN_SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";
const COMMODITY_QUOTE_CACHE_MS = 6 * 60 * 60 * 1000;
let commodityFutureQuoteCache:
  | {
      expiresAt: number;
      quotes: Map<string, CommodityFutureQuote>;
    }
  | undefined;

export const UNDERLYINGS: Record<string, UnderlyingDefinition> = {
  NIFTY: {
    key: "NIFTY",
    symbol: "NIFTY 50",
    displayName: "NIFTY",
    securityId: 13,
    segment: "IDX_I",
    lotSize: 65
  },
  BANKNIFTY: {
    key: "BANKNIFTY",
    symbol: "BANKNIFTY",
    displayName: "BANKNIFTY",
    securityId: 25,
    segment: "IDX_I",
    lotSize: 30
  },
  FINNIFTY: {
    key: "FINNIFTY",
    symbol: "FINNIFTY",
    displayName: "FINNIFTY",
    securityId: 27,
    segment: "IDX_I",
    lotSize: 60
  },
  MIDCPNIFTY: {
    key: "MIDCPNIFTY",
    symbol: "MIDCPNIFTY",
    displayName: "MIDCPNIFTY",
    securityId: 442,
    segment: "IDX_I",
    lotSize: 120
  },
  NIFTYNXT50: {
    key: "NIFTYNXT50",
    symbol: "NIFTYNXT50",
    displayName: "NIFTY NEXT 50",
    securityId: 38,
    segment: "IDX_I",
    lotSize: 25
  },
  SENSEX: {
    key: "SENSEX",
    symbol: "SENSEX",
    displayName: "SENSEX",
    securityId: 51,
    segment: "IDX_I",
    lotSize: 20
  },
  BANKEX: {
    key: "BANKEX",
    symbol: "BANKEX",
    displayName: "BANKEX",
    securityId: 69,
    segment: "IDX_I",
    lotSize: 30
  },
  CRUDEOIL: {
    key: "CRUDEOIL",
    symbol: "CRUDEOIL",
    displayName: "CRUDEOIL",
    securityId: 294,
    segment: "MCX_COMM",
    lotSize: 100,
    quoteSecurityId: 499095
  },
  NATURALGAS: {
    key: "NATURALGAS",
    symbol: "NATURALGAS",
    displayName: "NATURAL GAS",
    securityId: 401,
    segment: "MCX_COMM",
    lotSize: 1250,
    quoteSecurityId: 504265
  },
  COPPER: {
    key: "COPPER",
    symbol: "COPPER",
    displayName: "COPPER",
    securityId: 152,
    segment: "MCX_COMM",
    lotSize: 2500,
    quoteSecurityId: 552708
  },
  SILVER: {
    key: "SILVER",
    symbol: "SILVER",
    displayName: "SILVER",
    securityId: 115,
    segment: "MCX_COMM",
    lotSize: 30,
    quoteSecurityId: 464150
  }
};

const UNDERLYING_ALIASES: Record<string, string> = {
  CRUDE: "CRUDEOIL",
  CRUDE_OIL: "CRUDEOIL",
  "CRUDE OIL": "CRUDEOIL",
  FIN_NIFTY: "FINNIFTY",
  "FIN NIFTY": "FINNIFTY",
  MID_CAP_NIFTY: "MIDCPNIFTY",
  "MID CAP NIFTY": "MIDCPNIFTY",
  NIFTY_NEXT_50: "NIFTYNXT50",
  "NIFTY NEXT 50": "NIFTYNXT50",
  NATGAS: "NATURALGAS",
  NATURAL_GAS: "NATURALGAS",
  "NATURAL GAS": "NATURALGAS"
};

export function normalizeUnderlyingKey(value: string | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  return UNDERLYING_ALIASES[normalized] ?? UNDERLYING_ALIASES[normalized.replace(/\s+/g, "_")] ?? normalized;
}

export function getUnderlyingDefinition(value: string | undefined): UnderlyingDefinition | undefined {
  return UNDERLYINGS[normalizeUnderlyingKey(value)];
}

export function getSupportedUnderlyingKeys(): string[] {
  return Object.keys(UNDERLYINGS);
}

export class DhanClient {
  constructor(private readonly options: DhanClientOptions) {}

  async getExpiryList(underlying: UnderlyingDefinition): Promise<string[]> {
    const payload = await this.postDhan<unknown>("/v2/optionchain/expirylist", {
      UnderlyingScrip: underlying.securityId,
      UnderlyingSeg: underlying.segment
    });

    if (!Array.isArray(payload) || payload.length === 0) {
      throw new DhanApiError(`No expiries returned for ${underlying.key}`);
    }

    return payload.map(String).sort();
  }

  async getOptionChain(request: DhanOptionChainRequest): Promise<OptionChainSnapshot> {
    const raw = await this.postDhan<DhanOptionChainResponse>("/v2/optionchain", {
      UnderlyingScrip: request.underlying.securityId,
      UnderlyingSeg: request.underlying.segment,
      Expiry: request.expiry
    });

    const snapshot = normalizeOptionChain(raw, request.underlying, request.expiry);
    if (!request.spotPriceOverride) {
      return snapshot;
    }

    const strikes = [...new Set(snapshot.ticks.map((tick) => tick.strikePrice))];
    const atmStrike = strikes.reduce(
      (nearest, strike) => (Math.abs(strike - request.spotPriceOverride!) < Math.abs(nearest - request.spotPriceOverride!) ? strike : nearest),
      strikes[0] ?? snapshot.atmStrike
    );
    return {
      ...snapshot,
      spotPrice: request.spotPriceOverride,
      atmStrike
    };
  }

  async getLastTradedPrice(segment: string, securityId: number): Promise<number | undefined> {
    const payload = await this.postDhan<DhanLtpResponse>("/v2/marketfeed/ltp", {
      [segment]: [securityId]
    });
    return toNumber(payload[segment]?.[String(securityId)]?.last_price);
  }

  async resolveQuoteUnderlyings(underlyings: UnderlyingDefinition[]): Promise<UnderlyingDefinition[]> {
    const mcxUnderlyings = underlyings.filter((underlying) => underlying.segment === "MCX_COMM");
    if (!mcxUnderlyings.length) {
      return underlyings;
    }

    const quotes = await getCommodityFutureQuotes();
    return underlyings.map((underlying) => {
      const quote = quotes.get(underlying.key);
      return quote
        ? {
            ...underlying,
            quoteSecurityId: quote.securityId,
            quoteSegment: underlying.segment
          }
        : underlying;
    });
  }

  async getLtpQuotes(underlyings: UnderlyingDefinition[]): Promise<Map<string, DhanOhlcQuote>> {
    const grouped = underlyings.reduce<Record<string, number[]>>((groups, underlying) => {
      addQuoteSecurityIds(groups, underlying);
      return groups;
    }, {});

    const payload = await this.postDhan<DhanLtpResponse>("/v2/marketfeed/ltp", grouped);
    const quotes = new Map<string, DhanOhlcQuote>();

    for (const underlying of underlyings) {
      const primarySecurityId = underlying.quoteSecurityId ?? underlying.securityId;
      const primarySegment = underlying.quoteSegment ?? underlying.segment;
      const fallbackRaw = payload[underlying.segment]?.[String(underlying.securityId)];
      const primaryRaw = payload[primarySegment]?.[String(primarySecurityId)];
      const raw = selectQuotePayload(primaryRaw, fallbackRaw);
      quotes.set(underlying.key, {
        securityId: raw === primaryRaw ? primarySecurityId : underlying.securityId,
        lastPrice: toNumber(raw?.last_price)
      });
    }

    return quotes;
  }

  async getOhlcQuotes(underlyings: UnderlyingDefinition[]): Promise<Map<string, DhanOhlcQuote>> {
    const grouped = underlyings.reduce<Record<string, number[]>>((groups, underlying) => {
      addQuoteSecurityIds(groups, underlying);
      return groups;
    }, {});

    const payload = await this.postDhan<DhanOhlcResponse>("/v2/marketfeed/ohlc", grouped);
    const quotes = new Map<string, DhanOhlcQuote>();

    for (const underlying of underlyings) {
      const primarySecurityId = underlying.quoteSecurityId ?? underlying.securityId;
      const primarySegment = underlying.quoteSegment ?? underlying.segment;
      const fallbackRaw = payload[underlying.segment]?.[String(underlying.securityId)];
      const primaryRaw = payload[primarySegment]?.[String(primarySecurityId)];
      const raw = selectQuotePayload(primaryRaw, fallbackRaw);
      quotes.set(underlying.key, {
        securityId: raw === primaryRaw ? primarySecurityId : underlying.securityId,
        lastPrice: toNumber(raw?.last_price),
        previousClose: toNumber(raw?.ohlc?.close)
      });
    }

    return quotes;
  }

  // Informational-only margin lookup (single leg or multiple legs of one
  // strategy passed together). Never used to block or size a paper trade -
  // callers should treat a thrown/failed call as "margin unavailable" and
  // continue, not as a reason to reject the fill.
  async calculateMultiOrderMargin(legs: DhanMarginLegInput[]): Promise<DhanMultiOrderMarginResult> {
    if (legs.length === 0) {
      throw new DhanApiError("calculateMultiOrderMargin requires at least one leg.");
    }

    const raw = await this.postDhan<Record<string, unknown>>("/v2/margincalculator/multi", {
      includePosition: false,
      includeOrders: false,
      dhanClientId: this.options.clientId,
      scripts: legs.map((leg) => ({
        exchangeSegment: leg.exchangeSegment ?? "NSE_FNO",
        transactionType: leg.transactionType,
        quantity: leg.quantity,
        productType: leg.productType ?? "INTRADAY",
        securityId: leg.securityId,
        price: leg.price
      }))
    });

    return {
      totalMargin: toNumber(raw.total_margin ?? raw.totalMargin) ?? 0,
      spanMargin: toNumber(raw.span_margin ?? raw.spanMargin) ?? 0,
      exposureMargin: toNumber(raw.exposure_margin ?? raw.exposureMargin) ?? 0,
      equityMargin: toNumber(raw.equity_margin ?? raw.equityMargin) ?? 0,
      foMargin: toNumber(raw.fo_margin ?? raw.foMargin) ?? 0,
      commodityMargin: toNumber(raw.commodity_margin ?? raw.commodityMargin) ?? 0,
      currency: typeof raw.currency === "string" ? raw.currency : "INR",
      hedgeBenefit: typeof raw.hedge_benefit === "string" && raw.hedge_benefit ? raw.hedge_benefit : undefined
    };
  }

  protected headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "access-token": this.options.accessToken,
      "client-id": this.options.clientId
    };
  }

  private async postDhan<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.options.clientId || !this.options.accessToken) {
      throw new DhanApiError("Missing Dhan credentials. Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN.");
    }
    assertAccessTokenIsUsable(this.options.accessToken);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 4_000);
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: controller.signal
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DhanApiError(`Dhan request ${path} timed out.`);
      }
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
    });

    const responseText = await response.text();
    let decoded: unknown;
    try {
      decoded = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new DhanApiError(`Dhan request ${path} returned non-JSON HTTP ${response.status}: ${responseText.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw new DhanApiError(`Dhan request ${path} failed: HTTP ${response.status} ${JSON.stringify(decoded).slice(0, 500)}`);
    }

    return unwrapDhanPayload(decoded) as T;
  }
}

async function getCommodityFutureQuotes() {
  const now = Date.now();
  if (commodityFutureQuoteCache && commodityFutureQuoteCache.expiresAt > now) {
    return commodityFutureQuoteCache.quotes;
  }

  const response = await fetch(DHAN_SCRIP_MASTER_URL);
  if (!response.ok) {
    throw new DhanApiError(`Dhan scrip master failed: HTTP ${response.status}`);
  }

  const csv = await response.text();
  const quotes = parseCommodityFutureQuotes(csv);
  commodityFutureQuoteCache = {
    expiresAt: now + COMMODITY_QUOTE_CACHE_MS,
    quotes
  };
  return quotes;
}

function parseCommodityFutureQuotes(csv: string) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0] ?? "");
  const columnIndex = new Map(header.map((column, index) => [column, index]));
  const requiredColumns = ["EXCH_ID", "SECURITY_ID", "INSTRUMENT_TYPE", "UNDERLYING_SYMBOL", "SM_EXPIRY_DATE"];
  if (requiredColumns.some((column) => !columnIndex.has(column))) {
    throw new DhanApiError("Dhan scrip master is missing required columns.");
  }
  const exchangeIndex = columnIndex.get("EXCH_ID")!;
  const securityIdIndex = columnIndex.get("SECURITY_ID")!;
  const instrumentTypeIndex = columnIndex.get("INSTRUMENT_TYPE")!;
  const underlyingSymbolIndex = columnIndex.get("UNDERLYING_SYMBOL")!;
  const expiryDateIndex = columnIndex.get("SM_EXPIRY_DATE")!;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const quotes = new Map<string, CommodityFutureQuote>();

  for (const line of lines.slice(1)) {
    const columns = splitCsvLine(line);
    if (columns[exchangeIndex] !== "MCX" || columns[instrumentTypeIndex] !== "FUTCOM") {
      continue;
    }

    const symbol = normalizeUnderlyingKey(columns[underlyingSymbolIndex]);
    if (!UNDERLYINGS[symbol]) {
      continue;
    }

    const expiryDate = columns[expiryDateIndex];
    const expiryTime = Date.parse(`${expiryDate}T00:00:00.000Z`);
    const securityId = Number(columns[securityIdIndex]);
    if (!Number.isFinite(expiryTime) || !Number.isFinite(securityId) || expiryTime < today.getTime()) {
      continue;
    }

    const existing = quotes.get(symbol);
    if (!existing || expiryDate < existing.expiryDate) {
      quotes.set(symbol, {
        securityId,
        expiryDate
      });
    }
  }

  return quotes;
}

function splitCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function addQuoteSecurityIds(groups: Record<string, number[]>, underlying: UnderlyingDefinition) {
  const primarySegment = underlying.quoteSegment ?? underlying.segment;
  const primarySecurityId = underlying.quoteSecurityId ?? underlying.securityId;
  groups[primarySegment] = addUniqueNumber(groups[primarySegment] ?? [], primarySecurityId);

  if (primarySegment !== underlying.segment || primarySecurityId !== underlying.securityId) {
    groups[underlying.segment] = addUniqueNumber(groups[underlying.segment] ?? [], underlying.securityId);
  }
}

function addUniqueNumber(values: number[], value: number) {
  return values.includes(value) ? values : [...values, value];
}

function selectQuotePayload<T extends { last_price?: unknown }>(primary: T | undefined, fallback: T | undefined): T | undefined {
  return toNumber(primary?.last_price) !== undefined ? primary : fallback ?? primary;
}

interface DhanOptionChainResponse {
  last_price?: unknown;
  oc?: Record<string, DhanStrikePayload>;
}

type DhanLtpResponse = Record<string, Record<string, { last_price?: unknown }>>;
type DhanOhlcResponse = Record<string, Record<string, { last_price?: unknown; ohlc?: { close?: unknown } }>>;

interface DhanStrikePayload {
  ce?: DhanOptionLeg;
  pe?: DhanOptionLeg;
}

interface DhanOptionLeg {
  security_id?: unknown;
  last_price?: unknown;
  average_price?: unknown;
  oi?: unknown;
  previous_oi?: unknown;
  change_in_oi?: unknown;
  oi_change?: unknown;
  change_oi?: unknown;
  volume?: unknown;
  top_bid_price?: unknown;
  top_ask_price?: unknown;
  implied_volatility?: unknown;
  greeks?: {
    delta?: unknown;
    theta?: unknown;
    gamma?: unknown;
    vega?: unknown;
  };
}

function unwrapDhanPayload(response: unknown): unknown {
  if (!isRecord(response)) {
    return response;
  }

  if (response.status && response.status !== "success") {
    throw new DhanApiError(formatDhanError(response));
  }

  const payload = response.data ?? response;
  if (isRecord(payload) && "status" in payload && "data" in payload) {
    if (payload.status !== "success") {
      throw new DhanApiError(formatDhanError(payload));
    }
    return payload.data;
  }

  return payload;
}

function normalizeOptionChain(raw: DhanOptionChainResponse, underlying: UnderlyingDefinition, expiry: string): OptionChainSnapshot {
  const optionChain = raw.oc ?? {};
  const strikes = Object.keys(optionChain)
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (strikes.length === 0) {
    throw new DhanApiError("Option chain payload did not contain any strike data.");
  }

  const spotPrice = toNumber(raw.last_price) ?? 0;
  const atmStrike = strikes.reduce((nearest, strike) => (Math.abs(strike - spotPrice) < Math.abs(nearest - spotPrice) ? strike : nearest), strikes[0] ?? 0);
  const now = new Date();
  const tradingDate = now.toISOString().slice(0, 10);
  const ticks: OptionContractTick[] = [];

  for (const strikePrice of strikes) {
    const payload = optionChain[String(strikePrice)] ?? optionChain[strikePrice.toFixed(6)] ?? optionChain[strikePrice.toFixed(1)];
    if (!payload) {
      continue;
    }

    const ce = normalizeLeg(payload.ce, "CE", strikePrice, underlying, expiry, tradingDate, now);
    const pe = normalizeLeg(payload.pe, "PE", strikePrice, underlying, expiry, tradingDate, now);
    if (ce) ticks.push(ce);
    if (pe) ticks.push(pe);
  }

  return {
    tradingDate,
    snapshotTime: now.toISOString(),
    underlyingSymbol: underlying.key,
    expiry,
    spotPrice,
    atmStrike,
    ticks
  };
}

function normalizeLeg(
  leg: DhanOptionLeg | undefined,
  optionType: "CE" | "PE",
  strikePrice: number,
  underlying: UnderlyingDefinition,
  expiry: string,
  tradingDate: string,
  now: Date
): OptionContractTick | null {
  if (!leg) {
    return null;
  }

  const oi = toNumber(leg.oi);
  const previousOi = toNumber(leg.previous_oi);
  const reportedOiChange = firstNumber(leg.change_in_oi, leg.oi_change, leg.change_oi);

  return {
    tradingDate,
    tickTime: now.toISOString(),
    underlyingSymbol: underlying.key,
    expiry,
    optionType,
    strikePrice,
    securityId: leg.security_id === undefined || leg.security_id === null ? undefined : String(leg.security_id),
    lotSize: underlying.lotSize,
    lastPrice: toNumber(leg.last_price),
    bidPrice: toNumber(leg.top_bid_price),
    askPrice: toNumber(leg.top_ask_price),
    volume: toNumber(leg.volume),
    openInterest: oi,
    changeInOpenInterest: reportedOiChange ?? (oi !== undefined && previousOi !== undefined ? oi - previousOi : undefined),
    impliedVolatility: toNumber(leg.implied_volatility),
    delta: toNumber(leg.greeks?.delta),
    gamma: toNumber(leg.greeks?.gamma),
    theta: toNumber(leg.greeks?.theta),
    vega: toNumber(leg.greeks?.vega)
  };
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatDhanError(response: Record<string, unknown>): string {
  const remarks = response.remarks ? `remarks=${JSON.stringify(response.remarks)}` : "";
  const data = response.data ? `data=${JSON.stringify(response.data)}` : "";
  return [remarks, data].filter(Boolean).join("; ") || "Dhan request failed";
}

function assertAccessTokenIsUsable(token: string): void {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof payload.exp === "number" && Date.now() >= payload.exp * 1000) {
      throw new DhanApiError(`Dhan access token expired at ${new Date(payload.exp * 1000).toISOString()}. Generate a fresh token and update .env.local.`);
    }
  } catch (error) {
    if (error instanceof DhanApiError) {
      throw error;
    }
  }
}

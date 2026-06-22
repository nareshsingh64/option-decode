import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { calculatePressureScore, generateMarketAlerts } from "@option-decode/analytics";
import { loadConfig } from "@option-decode/config";
import { buildDemoSnapshot, cancelPendingPaperOrder, closePaperPosition, createUser, getAdminOverview, getAuthUserById, getDefaultWatchlist, getLatestOptionChainSnapshot, getLatestSpotChange, getOptionChainSnapshotById, getPaperSummary, getUserCredentialsByEmail, listReplaySnapshots, listStoredExpiries, placePaperOrder, updateAdminUserRole, updateDefaultWatchlist, updatePaperPositionRisk, updatePendingPaperOrder } from "@option-decode/db";
import { DhanClient, getSupportedUnderlyingKeys, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { UnderlyingDefinition } from "@option-decode/types";
import { createClearedSessionCookie, createSessionCookie, getSessionUserId, hashPassword, verifyPassword } from "./auth.js";

const config = loadConfig();
const supportedUnderlyings = getSupportedUnderlyingKeys();
const visibleUnderlyings = [...new Set([...config.feedUnderlyings.map(normalizeUnderlyingKey), ...supportedUnderlyings])];
const tickerUnderlyings = visibleUnderlyings.filter((symbol) => Boolean(getUnderlyingDefinition(symbol)));
const INDIA_VIX_UNDERLYING: UnderlyingDefinition = {
  key: "INDIAVIX",
  symbol: "INDIA VIX",
  displayName: "INDIA VIX",
  securityId: 21,
  segment: "IDX_I",
  lotSize: 1
};
const MARKET_AUX_CACHE_MS = 5_000;
let marketAuxCache:
  | {
      expiresAt: number;
      value: {
        indiaVix?: number;
        ticker: MarketTickerItem[];
      };
    }
  | undefined;

interface MarketTickerItem {
  symbol: string;
  displayName: string;
  segment: string;
  spotPrice?: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
}
const dhan = new DhanClient({
  baseUrl: config.DHAN_API_BASE_URL,
  clientId: config.DHAN_CLIENT_ID,
  accessToken: config.DHAN_ACCESS_TOKEN
});
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug"
  }
});

const allowedOrigins = new Set([
  config.APP_PUBLIC_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
  },
  credentials: true
});

app.get("/health", async () => ({
  ok: true,
  service: "option-decode-api",
  timestamp: new Date().toISOString()
}));

const authSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(80).optional()
});

app.post("/api/auth/register", async (request, reply) => {
  const parsed = authSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid registration details" });
  }

  try {
    const user = await createUser({
      email: parsed.data.email,
      passwordHash: hashPassword(parsed.data.password),
      displayName: parsed.data.displayName
    });
    reply.header("set-cookie", createSessionCookie(user, config.SESSION_SECRET));
    return { user };
  } catch (error) {
    request.log.warn({ error }, "User registration failed");
    return reply.status(409).send({ message: "An account already exists for this email." });
  }
});

app.post("/api/auth/login", async (request, reply) => {
  const parsed = authSchema.pick({ email: true, password: true }).safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid login details" });
  }

  const credentials = await getUserCredentialsByEmail(parsed.data.email);
  if (!credentials || !verifyPassword(parsed.data.password, credentials.passwordHash)) {
    return reply.status(401).send({ message: "Email or password is incorrect." });
  }

  const user = await getAuthUserById(credentials.id);
  if (!user) {
    return reply.status(401).send({ message: "Account was not found." });
  }

  reply.header("set-cookie", createSessionCookie(user, config.SESSION_SECRET));
  return { user };
});

app.get("/api/auth/me", async (request) => {
  const userId = getSessionUserId(request.headers.cookie, config.SESSION_SECRET);
  const user = userId ? await getAuthUserById(userId) : null;
  return { user };
});

app.post("/api/auth/logout", async (_request, reply) => {
  reply.header("set-cookie", createClearedSessionCookie());
  return { ok: true };
});

app.get("/api/admin/overview", async (request, reply) => {
  const admin = await requireAdminUser(request.headers.cookie);
  if (!admin) {
    return reply.status(403).send({ message: "Admin access is required." });
  }

  return getAdminOverview();
});

const adminRoleSchema = z.object({
  role: z.enum(["ADMIN", "SUBSCRIBER", "TRIAL", "FREE"])
});

app.patch<{
  Params: {
    id: string;
  };
}>("/api/admin/users/:id/role", async (request, reply) => {
  const admin = await requireAdminUser(request.headers.cookie);
  if (!admin) {
    return reply.status(403).send({ message: "Admin access is required." });
  }

  const parsed = adminRoleSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid user role." });
  }

  return updateAdminUserRole(request.params.id, parsed.data.role);
});

app.get<{
  Querystring: {
    underlying?: string;
    expiry?: string;
  };
}>("/api/market/overview", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  const marketAux = await getMarketAuxData();
  const spotPriceOverride = marketAux.ticker.find((item) => item.symbol === requestedUnderlying)?.spotPrice;
  const snapshot = await getLatestSnapshotOrDemo(requestedUnderlying, requestedExpiry, spotPriceOverride);
  const pressure = calculatePressureScore(snapshot);
  const alerts = generateMarketAlerts(snapshot, pressure);
  const expiries = await getExpiriesOrEmpty(requestedUnderlying);

  return {
    underlyings: visibleUnderlyings,
    expiries,
    selectedUnderlying: requestedUnderlying,
    selectedExpiry: snapshot.expiry,
    indiaVix: marketAux.indiaVix,
    ticker: marketAux.ticker,
    snapshot,
    pressure,
    alerts
  };
});

app.get("/api/market/ticker", async () => {
  const marketAux = await getMarketAuxData();
  return {
    indiaVix: marketAux.indiaVix,
    ticker: marketAux.ticker
  };
});

app.get<{
  Querystring: {
    underlying?: string;
  };
}>("/api/market/expiries", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const expiries = await getExpiriesOrEmpty(requestedUnderlying);

  return {
    underlying: requestedUnderlying,
    expiries,
    currentExpiry: expiries[0] ?? null
  };
});

app.get<{
  Querystring: {
    underlying?: string;
    expiry?: string;
  };
}>("/api/replay/timeline", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  return {
    snapshots: await listReplaySnapshots(requestedUnderlying, requestedExpiry)
  };
});

app.get<{
  Params: {
    id: string;
  };
}>("/api/replay/snapshot/:id", async (request, reply) => {
  const snapshot = await getOptionChainSnapshotById(request.params.id);
  if (!snapshot) {
    return reply.status(404).send({ message: "Replay snapshot was not found." });
  }

  const pressure = calculatePressureScore(snapshot);
  return {
    snapshot,
    pressure,
    alerts: generateMarketAlerts(snapshot, pressure)
  };
});

app.get("/api/paper/summary", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  return getPaperSummary(user);
});

app.get("/api/watchlist/default", async () => getDefaultWatchlist());

const watchlistSchema = z.object({
  symbols: z.array(z.string().trim().min(1)).min(1).max(12)
}).superRefine((value, context) => {
  const unsupported = value.symbols.map(normalizeUnderlyingKey).filter((symbol) => !visibleUnderlyings.includes(symbol));
  if (unsupported.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["symbols"],
      message: `Unsupported symbols: ${unsupported.join(", ")}`
    });
  }
});

app.put("/api/watchlist/default", async (request, reply) => {
  const parsed = watchlistSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "Invalid watchlist",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  return updateDefaultWatchlist(parsed.data.symbols.map(normalizeUnderlyingKey));
});

const paperOrderSchema = z.object({
  underlyingSymbol: z.string().trim().min(1),
  expiry: z.string().trim().min(1),
  action: z.enum(["BUY", "SELL"]),
  optionType: z.enum(["CE", "PE"]),
  strikePrice: z.coerce.number().positive(),
  lots: z.coerce.number().int().positive().max(1000),
  requestedPrice: z.coerce.number().nonnegative(),
  stopLoss: z.coerce.number().nonnegative(),
  trailingStop: z.boolean().default(true),
  trailDistance: z.coerce.number().nonnegative().optional(),
  targetPrice: z.coerce.number().nonnegative(),
  strategyName: z.string().trim().min(1).max(80),
  reasonText: z.string().trim().max(500).optional()
});

app.post("/api/paper/orders", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  const parsed = paperOrderSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "Invalid paper order",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  const validationMessage = validatePaperOrderRisk(parsed.data.action, parsed.data.requestedPrice, parsed.data.stopLoss, parsed.data.targetPrice);
  if (validationMessage) {
    return reply.status(400).send({ message: validationMessage });
  }

  return placePaperOrder(parsed.data, user);
});

const pendingOrderUpdateSchema = paperOrderSchema.pick({
  lots: true,
  requestedPrice: true,
  stopLoss: true,
  trailingStop: true,
  trailDistance: true,
  targetPrice: true
});

app.patch<{
  Params: {
    id: string;
  };
}>("/api/paper/orders/:id", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  const parsed = pendingOrderUpdateSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({
      message: "Invalid pending order update",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  const currentSummary = await getPaperSummary(user);
  const currentOrder = currentSummary.orders.find((order) => order.id === request.params.id && order.status === "PENDING");
  if (!currentOrder) {
    return reply.status(404).send({ message: "Pending paper order was not found." });
  }

  const validationMessage = validatePaperOrderRisk(currentOrder.action, parsed.data.requestedPrice, parsed.data.stopLoss, parsed.data.targetPrice);
  if (validationMessage) {
    return reply.status(400).send({ message: validationMessage });
  }

  try {
    return await updatePendingPaperOrder(request.params.id, parsed.data, user);
  } catch (error) {
    return reply.status(404).send({ message: error instanceof Error ? error.message : "Unable to update pending paper order" });
  }
});

app.post<{
  Params: {
    id: string;
  };
}>("/api/paper/orders/:id/cancel", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  try {
    return await cancelPendingPaperOrder(request.params.id, user);
  } catch (error) {
    return reply.status(404).send({ message: error instanceof Error ? error.message : "Unable to cancel pending paper order" });
  }
});

const closePositionSchema = z.object({
  exitReason: z.string().trim().min(1).max(80).default("MANUAL")
});

app.post<{
  Params: {
    id: string;
  };
}>("/api/paper/positions/:id/close", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  const parsed = closePositionSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid close request" });
  }

  try {
    return await closePaperPosition(request.params.id, user, parsed.data.exitReason);
  } catch (error) {
    return reply.status(404).send({ message: error instanceof Error ? error.message : "Unable to close paper position" });
  }
});

const positionRiskSchema = z.object({
  stopLoss: z.coerce.number().nonnegative(),
  trailDistance: z.coerce.number().nonnegative().optional(),
  targetPrice: z.coerce.number().nonnegative()
});

app.patch<{
  Params: {
    id: string;
  };
}>("/api/paper/positions/:id/risk", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  const parsed = positionRiskSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid position risk request" });
  }

  try {
    return await updatePaperPositionRisk(request.params.id, user, parsed.data.stopLoss, parsed.data.targetPrice, parsed.data.trailDistance);
  } catch (error) {
    return reply.status(400).send({ message: error instanceof Error ? error.message : "Unable to update position risk" });
  }
});

function normalizeUnderlying(value: string | undefined): string {
  const normalized = normalizeUnderlyingKey(value ?? config.feedUnderlyings[0] ?? "NIFTY");
  return visibleUnderlyings.includes(normalized) ? normalized : String(visibleUnderlyings[0] ?? "NIFTY");
}

async function requireAdminUser(cookieHeader: string | undefined) {
  const userId = getSessionUserId(cookieHeader, config.SESSION_SECRET);
  const user = userId ? await getAuthUserById(userId) : null;
  return user?.role === "ADMIN" ? user : null;
}

async function getRequestUser(cookieHeader: string | undefined) {
  const userId = getSessionUserId(cookieHeader, config.SESSION_SECRET);
  return userId ? getAuthUserById(userId) : null;
}

function validatePaperOrderRisk(action: string, requestedPrice: number, stopLoss: number, targetPrice: number) {
  if (stopLoss >= requestedPrice && action === "BUY") {
    return "Stop loss must be below entry price for BUY orders.";
  }

  if (targetPrice <= requestedPrice && action === "BUY") {
    return "Target must be above entry price for BUY orders.";
  }

  if (stopLoss <= requestedPrice && action === "SELL") {
    return "Stop loss must be above entry price for SELL orders.";
  }

  if (targetPrice >= requestedPrice && action === "SELL") {
    return "Target must be below entry price for SELL orders.";
  }

  return null;
}

async function getExpiriesOrEmpty(underlyingSymbol: string) {
  try {
    const storedExpiries = await listStoredExpiries(underlyingSymbol);
    if (storedExpiries.length) {
      return storedExpiries;
    }

    const underlying = getUnderlyingDefinition(underlyingSymbol);
    return underlying ? await dhan.getExpiryList(underlying) : [];
  } catch (error) {
    app.log.warn({ error, underlyingSymbol }, "Unable to list stored expiries");
    return [];
  }
}

async function getLatestSnapshotOrDemo(underlyingSymbol: string, expiry?: string, spotPriceOverride?: number) {
  try {
    const storedSnapshot = await getLatestOptionChainSnapshot(underlyingSymbol, expiry);
    if (storedSnapshot) {
      return storedSnapshot;
    }

    const underlying = getUnderlyingDefinition(underlyingSymbol);
    if (underlying) {
      const selectedExpiry = expiry ?? (await dhan.getExpiryList(underlying))[0];
      if (selectedExpiry) {
        return await dhan.getOptionChain({ underlying, expiry: selectedExpiry, spotPriceOverride });
      }
    }

    return buildDemoSnapshot();
  } catch (error) {
    app.log.warn({ error, underlyingSymbol, expiry }, "Falling back to demo market snapshot");
    return underlyingSymbol === "NIFTY" ? buildDemoSnapshot() : buildEmptySnapshot(underlyingSymbol, expiry);
  }
}

async function getMarketAuxData() {
  const now = Date.now();
  if (marketAuxCache && marketAuxCache.expiresAt > now) {
    return marketAuxCache.value;
  }

  const value = await getFreshMarketAuxData();
  marketAuxCache = {
    expiresAt: now + MARKET_AUX_CACHE_MS,
    value
  };
  return value;
}

async function getFreshMarketAuxData() {
  const definitions = tickerUnderlyings.map((symbol) => getUnderlyingDefinition(symbol)).filter((definition): definition is NonNullable<typeof definition> => Boolean(definition));

  try {
    const quotes = await dhan.getOhlcQuotes([...definitions, INDIA_VIX_UNDERLYING]);
    const ticker = await Promise.all(definitions.map(async (definition) => {
      const quote = quotes.get(definition.key);
      const storedChange = await getLatestSpotChange(definition.key).catch(() => null);
      const useStoredLastFeed = shouldUseStoredTickerFeed(definition);
      const spotPrice = useStoredLastFeed ? storedChange?.spotPrice ?? quote?.lastPrice : quote?.lastPrice ?? storedChange?.spotPrice;
      const previousClose = useStoredLastFeed ? storedChange?.previousClose ?? quote?.previousClose : quote?.previousClose ?? storedChange?.previousClose;
      const change = spotPrice !== undefined && previousClose !== undefined ? spotPrice - previousClose : storedChange?.change;
      return {
        symbol: definition.key,
        displayName: definition.displayName,
        segment: definition.segment,
        spotPrice,
        previousClose,
        change,
        changePercent: change !== undefined && previousClose ? (change / previousClose) * 100 : storedChange?.changePercent
      };
    }));

    return {
      indiaVix: quotes.get(INDIA_VIX_UNDERLYING.key)?.lastPrice,
      ticker
    };
  } catch (error) {
    app.log.warn({ error }, "Unable to fetch market ticker from Dhan");
    const ticker = await Promise.all(
      definitions.map(async (definition) => {
        const storedChange = await getLatestSpotChange(definition.key).catch(() => null);
        return {
          symbol: definition.key,
          displayName: definition.displayName,
          segment: definition.segment,
          spotPrice: storedChange?.spotPrice,
          previousClose: storedChange?.previousClose,
          change: storedChange?.change,
          changePercent: storedChange?.changePercent
        };
      })
    );
    return { indiaVix: undefined, ticker };
  }
}

function buildEmptySnapshot(underlyingSymbol: string, expiry?: string) {
  const now = new Date();
  return {
    tradingDate: now.toISOString().slice(0, 10),
    snapshotTime: now.toISOString(),
    underlyingSymbol,
    expiry: expiry ?? now.toISOString().slice(0, 10),
    spotPrice: 0,
    atmStrike: 0,
    ticks: []
  };
}

function shouldUseStoredTickerFeed(definition: UnderlyingDefinition) {
  if (definition.segment === "MCX_COMM") {
    return !isMarketSessionOpen(9, 0, 23, 30);
  }

  return !isMarketSessionOpen(9, 15, 15, 30);
}

function isMarketSessionOpen(startHour: number, startMinute: number, endHour: number, endMinute: number) {
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const day = istNow.getUTCDay();
  if (day === 0 || day === 6) {
    return false;
  }

  const minutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  return minutes >= startHour * 60 + startMinute && minutes <= endHour * 60 + endMinute;
}

const address = await app.listen({
  port: config.API_PORT,
  host: "0.0.0.0"
});

app.log.info(`Option Decode API listening at ${address}`);

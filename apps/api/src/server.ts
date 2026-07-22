import cors from "@fastify/cors";
import Fastify from "fastify";
import Redis from "ioredis";
import net from "node:net";
import tls from "node:tls";
import { z } from "zod";
import { calculateAtmStraddleExpectedMove, calculateMarketBias, calculateMarketPulse, calculatePressureScore, calculateStrikeMatrix, calculateStrikeMovement, calculateTradeInterpretation, generateMarketAlerts, isTradingHorizon } from "@option-decode/analytics";
import { calculateTradeRecommendations } from "@option-decode/trading";
import { loadConfig } from "@option-decode/config";
import { buildDemoSnapshot, calculateOiWeightedAverageSellPrices, cancelPendingPaperOrder, closePaperPosition, createEmailVerificationToken, createPasswordResetToken, createUser, disablePushSubscriptionsForUser, getAdminOverview, getAuthUserById, getDefaultWatchlist, getLatestOptionChainSnapshot, getLatestSpotChange, getOptionChainSnapshotById, getPaperSummary, getPendingOrdersForMarginGroup, getUserAlertThreshold, getUserCredentialsByEmail, listPcrTrend, listRecentPressureHistory, listReplaySnapshots, listReplayTradingDates, listStoredExpiries, listUserAlertThresholds, markUserLogin, placeMultiLegPaperOrder, placePaperOrder, recordOrderMargin, resetPasswordWithToken, setUserTabs, updateAdminUserDisabled, updateAdminUserRole, updateDefaultWatchlist, updatePaperPositionRisk, updatePendingPaperOrder, upsertPushSubscription, upsertUserAlertThreshold, verifyEmailToken } from "@option-decode/db";
import { DhanClient, getFnoExchangeSegment, getSupportedUnderlyingKeys, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { MarketPulse, OptionChainSnapshot, PressureScore, UnderlyingDefinition } from "@option-decode/types";
import { isMarketSessionOpen as isSegmentMarketSessionOpen } from "@option-decode/utils";
import { createClearedSessionCookie, createSessionCookie, getSessionUserId, hashPassword, verifyPassword } from "./auth.js";
import { registerSimRoutes } from "./sim-routes.js";

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
// Was 5s, which meant the ticker's stale-while-revalidate cache went stale
// almost as fast as the frontend polled it, so nearly every poll cycle kicked
// off a fresh Dhan LTP/OHLC round trip. Combined with the worker's own 30s
// snapshot-cycle Dhan calls, this pushed total request volume over Dhan's
// rate limit and surfaced as intermittent HTTP 429 DhanApiErrors. Ticker
// data doesn't need sub-25s freshness, so raising the TTL cuts most of that
// call volume directly.
const MARKET_AUX_CACHE_MS = 25_000;
const MARKET_SNAPSHOT_CACHE_MS = 10_000;
const MARKET_EXPIRIES_CACHE_MS = 10_000;
const MARKET_PULSE_CACHE_MS = 10_000;
// enrichZonesWithAvgSellPrice() runs one historical-tick-history DB query
// per support/resistance zone (typically 4-10 zones), in parallel. Unlike
// every other data source on this endpoint (snapshot/expiries/pulse), it
// had no caching at all, so every overview poll - and especially the first
// poll right after switching symbols - paid that full cost on every call.
// Same TTL as the snapshot cache: zones are a deterministic function of the
// snapshot, so this can't be any staler than the snapshot data already is.
const OI_WEIGHTED_ZONES_CACHE_MS = MARKET_SNAPSHOT_CACHE_MS;
// How far back to look for the market-pulse rate-of-change calculation.
// Long enough that a couple of noisy ~30s snapshots don't dominate the
// trend line, short enough to still describe "right now" rather than the
// whole session.
const MARKET_PULSE_WINDOW_MS = 5 * 60 * 1000;
const WATCHLIST_SYMBOLS_CACHE_MS = 30_000;
const LIVE_SNAPSHOT_STALE_MS = 90_000;
const MARKET_STREAM_TICKER_MS = 5_000;
const MARKET_STREAM_SNAPSHOT_MS = 30_000;
const MARKET_STREAM_HEARTBEAT_MS = 15_000;
const MARKET_SNAPSHOT_SAVED_CHANNEL = "market:snapshot:saved";
const marketAuxCache = new Map<
  string,
  {
    expiresAt: number;
    value: {
      indiaVix?: number;
      ticker: MarketTickerItem[];
    };
    refreshing?: boolean;
  }
>();
const marketSnapshotCache = new Map<string, HotCacheEntry<OptionChainSnapshot>>();
const oiWeightedZonesCache = new Map<string, HotCacheEntry<PressureScore>>();
const marketPulseCache = new Map<string, HotCacheEntry<MarketPulse | null>>();
const expiriesCache = new Map<string, HotCacheEntry<string[]>>();
const tradableExpiriesCache = new Map<string, HotCacheEntry<string[]>>();
const tickerSymbolsCache = new Map<string, HotCacheEntry<string[] | undefined>>();
const marketStreamClients = new Map<number, MarketStreamClient>();
let nextMarketStreamClientId = 1;

interface MarketTickerItem {
  symbol: string;
  displayName: string;
  segment: string;
  spotPrice?: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
}

interface HotCacheEntry<T> {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
}

interface MarketSnapshotSavedMessage {
  snapshotId: string;
  underlying: string;
  expiry: string;
  snapshotTime: string;
  serverTime: string;
}

interface MarketStreamClient {
  id: number;
  underlying: string;
  expiry?: string;
  writeEvent: (event: string, data: unknown) => void;
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
const redisSubscriber = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true
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

const emailSchema = z.object({
  email: z.string().trim().email()
});

const resetPasswordSchema = z.object({
  token: z.string().trim().min(20),
  password: z.string().min(8).max(128)
});

app.post("/api/auth/register", async (request, reply) => {
  const parsed = authSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid registration details" });
  }

  let user: Awaited<ReturnType<typeof createUser>>;
  try {
    user = await createUser({
      email: parsed.data.email,
      passwordHash: hashPassword(parsed.data.password),
      displayName: parsed.data.displayName
    });
  } catch (error) {
    request.log.warn({ error }, "User registration failed");
    return reply.status(409).send({ message: "An account already exists for this email." });
  }

  try {
    const verification = await createEmailVerificationToken(user.email);
    await sendTransactionalEmail({
      to: verification.email,
      subject: "Verify your Option Decode account",
      text: `Verify your account: ${config.APP_PUBLIC_URL}/verify-email?token=${verification.token}`
    });
  } catch (error) {
    request.log.warn({ err: error, email: user.email }, "Verification email delivery failed");
    return reply.status(503).send({ message: "Account was created, but verification email could not be sent. Please contact support." });
  }

  reply.header("set-cookie", createSessionCookie(user, config.SESSION_SECRET));
  return { user };
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
  if (credentials.disabled) {
    return reply.status(403).send({ message: "This account is disabled. Please contact support." });
  }

  const user = await getAuthUserById(credentials.id);
  if (!user || user.disabled) {
    return reply.status(401).send({ message: "Account was not found." });
  }

  await markUserLogin(user.id);
  reply.header("set-cookie", createSessionCookie(user, config.SESSION_SECRET));
  return { user };
});

app.get("/api/auth/me", async (request) => {
  const userId = getSessionUserId(request.headers.cookie, config.SESSION_SECRET);
  const user = userId ? await getAuthUserById(userId) : null;
  return { user: user?.disabled ? null : user };
});

app.post("/api/auth/logout", async (_request, reply) => {
  reply.header("set-cookie", createClearedSessionCookie());
  return { ok: true };
});

app.post("/api/auth/resend-verification", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }
  if (user.emailVerified) {
    return { ok: true, message: "Email is already verified." };
  }

  const verification = await createEmailVerificationToken(user.email);
  await sendTransactionalEmail({
    to: verification.email,
    subject: "Verify your Option Decode account",
    text: `Verify your account: ${config.APP_PUBLIC_URL}/verify-email?token=${verification.token}`
  });
  return { ok: true };
});

app.post<{
  Body: {
    token?: string;
  };
}>("/api/auth/verify-email", async (request, reply) => {
  const token = String(request.body?.token ?? "");
  const user = await verifyEmailToken(token);
  if (!user) {
    return reply.status(400).send({ message: "Verification link is invalid or expired." });
  }

  reply.header("set-cookie", createSessionCookie(user, config.SESSION_SECRET));
  return { user };
});

app.post("/api/auth/forgot-password", async (request) => {
  const parsed = emailSchema.safeParse(request.body);
  if (parsed.success) {
    const reset = await createPasswordResetToken(parsed.data.email);
    if (reset) {
      await sendTransactionalEmail({
        to: reset.email,
        subject: "Reset your Option Decode password",
        text: `Reset your password: ${config.APP_PUBLIC_URL}/reset-password?token=${reset.token}`
      });
    }
  }

  return { ok: true };
});

app.post("/api/auth/reset-password", async (request, reply) => {
  const parsed = resetPasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid password reset request." });
  }

  const user = await resetPasswordWithToken(parsed.data.token, hashPassword(parsed.data.password));
  if (!user) {
    return reply.status(400).send({ message: "Reset link is invalid or expired." });
  }

  reply.header("set-cookie", createSessionCookie(user, config.SESSION_SECRET));
  return { user };
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

const adminDisabledSchema = z.object({
  disabled: z.boolean()
});

app.patch<{
  Params: {
    id: string;
  };
}>("/api/admin/users/:id/disabled", async (request, reply) => {
  const admin = await requireAdminUser(request.headers.cookie);
  if (!admin) {
    return reply.status(403).send({ message: "Admin access is required." });
  }

  const parsed = adminDisabledSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid user status." });
  }

  return updateAdminUserDisabled(request.params.id, parsed.data.disabled);
});

// Role-based tab access: admin assigns which dashboard tabs a user sees.
const adminTabsSchema = z.object({
  tabs: z.array(z.string().trim().min(1)).max(20)
});

app.patch<{
  Params: {
    id: string;
  };
}>("/api/admin/users/:id/tabs", async (request, reply) => {
  const admin = await requireAdminUser(request.headers.cookie);
  if (!admin) {
    return reply.status(403).send({ message: "Admin access is required." });
  }

  const parsed = adminTabsSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid tab assignment." });
  }

  const tabs = await setUserTabs(request.params.id, parsed.data.tabs);
  return { id: request.params.id, tabs };
});

// Enriches support/resistance zones with the OI-buildup-weighted average
// sell price (see calculateOiWeightedAverageSellPrices), alongside the
// existing LTP-based premium/trueZone - deliberately additive, not a
// replacement, since the two answer different questions. Best-effort: a
// failure here (e.g. a slow query) falls back to the zones unchanged
// rather than failing the whole market-overview/replay response.
async function enrichZonesWithAvgSellPrice(pressure: PressureScore, underlyingSymbol: string, expiryLabel: string): Promise<PressureScore> {
  const strikes = [
    ...pressure.supportZones.map((zone) => ({ optionType: "PE" as const, strikePrice: zone.strikePrice })),
    ...pressure.resistanceZones.map((zone) => ({ optionType: "CE" as const, strikePrice: zone.strikePrice }))
  ];

  if (!strikes.length) {
    return pressure;
  }

  const weighted = await calculateOiWeightedAverageSellPrices(underlyingSymbol, expiryLabel, strikes).catch((error) => {
    app.log.warn({ error, underlyingSymbol, expiryLabel }, "Unable to compute OI-weighted average sell price; zones shown without it");
    return new Map();
  });

  const applyWeighted = (zone: PressureScore["supportZones"][number], optionType: "CE" | "PE") => {
    const result = weighted.get(`${optionType}:${zone.strikePrice}`);
    if (!result) {
      return zone;
    }
    return {
      ...zone,
      avgSellPrice: result.avgSellPrice,
      weightedTrueZone: optionType === "CE" ? zone.strikePrice + result.avgSellPrice : Math.max(0, zone.strikePrice - result.avgSellPrice),
      weightedSampleOi: result.totalOi
    };
  };

  return {
    ...pressure,
    supportZones: pressure.supportZones.map((zone) => applyWeighted(zone, "PE")),
    resistanceZones: pressure.resistanceZones.map((zone) => applyWeighted(zone, "CE"))
  };
}

app.get<{
  Querystring: {
    underlying?: string;
    expiry?: string;
  };
}>("/api/market/overview", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  const tickerSymbolsPromise = getTickerSymbols(requestedUnderlying);
  const userPromise = getRequestUser(request.headers.cookie);
  const [marketAux, snapshot, expiries, tradableExpiries, user] = await Promise.all([
    tickerSymbolsPromise.then((symbols) => getMarketAuxData(symbols)),
    getCachedLatestSnapshotOrDemo(requestedUnderlying, requestedExpiry),
    getCachedExpiriesOrEmpty(requestedUnderlying),
    getCachedTradableExpiriesOrEmpty(requestedUnderlying),
    userPromise
  ]);
  const marketPulsePromise = getCachedMarketPulse(snapshot.underlyingSymbol, snapshot.expiry);
  const pressure = await getHotCacheValue(oiWeightedZonesCache, `${snapshot.underlyingSymbol}:${snapshot.expiry}`, OI_WEIGHTED_ZONES_CACHE_MS, () =>
    enrichZonesWithAvgSellPrice(calculatePressureScore(snapshot), snapshot.underlyingSymbol, snapshot.expiry)
  );
  const alertThreshold = user ? await getUserAlertThreshold(user.id, snapshot.underlyingSymbol) : null;
  const alerts = generateMarketAlerts(snapshot, pressure, new Date(), alertThreshold ?? undefined);
  const strikeMovement = calculateStrikeMovement(snapshot);
  const tradeInterpretation = calculateTradeInterpretation(strikeMovement);
  const marketBias = calculateMarketBias(snapshot, pressure);
  const marketPulse = await marketPulsePromise;
  // ATM Call LTP + ATM Put LTP - the playbook's own weekly expected-move
  // boundary, separate from the India-VIX-derived range already sent below
  // via `indiaVix`. Feeds both the dashboard's own display and the seller
  // strike selection inside calculateTradeRecommendations.
  const atmStraddle = calculateAtmStraddleExpectedMove(snapshot);

  return {
    underlyings: visibleUnderlyings,
    expiries,
    tradableExpiries,
    selectedUnderlying: requestedUnderlying,
    selectedExpiry: snapshot.expiry,
    indiaVix: marketAux.indiaVix,
    ticker: marketAux.ticker,
    snapshot,
    pressure,
    marketPulse,
    atmStraddle,
    alerts,
    // Raw ATM +/-4 strike movement rows, already computed above for the
    // Trade Recommendations engine. Sent to the client so the Strike
    // Movement table on the dashboard reads the SAME numbers the
    // recommendations are based on, instead of the web app recomputing its
    // own (subtly different) version from raw ticks - see
    // strike-pressure-analytics.ts on the client for the presentation-only
    // decoration applied on top of these rows.
    strikeMovement,
    recommendations: calculateTradeRecommendations(snapshot, pressure, marketBias, strikeMovement, tradeInterpretation, atmStraddle)
  };
});

app.get<{
  Querystring: {
    symbols?: string;
  };
}>("/api/market/ticker", async (request) => {
  const marketAux = await getMarketAuxData(parseTickerSymbols(request.query.symbols));
  return {
    indiaVix: marketAux.indiaVix,
    ticker: marketAux.ticker
  };
});

app.get<{
  Querystring: {
    underlying?: string;
    expiry?: string;
    limit?: string;
  };
}>("/api/market/pcr-trend", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  const parsedLimit = Number(request.query.limit ?? 60);
  return {
    trend: await listPcrTrend(requestedUnderlying, requestedExpiry, Number.isFinite(parsedLimit) ? parsedLimit : 60)
  };
});

app.get<{
  Querystring: {
    underlying?: string;
    expiry?: string;
    horizon?: string;
    tradingDate?: string;
  };
}>("/api/market/strike-matrix", async (request, reply) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  const requestedHorizon = request.query.horizon?.trim().toLowerCase();
  const requestedTradingDate = request.query.tradingDate?.trim() || undefined;
  const horizon = isTradingHorizon(requestedHorizon) ? requestedHorizon : "intraday";

  // Historical mode: when a trading date is picked on the calendar, analyse
  // that day's LAST stored snapshot (listReplaySnapshots orders desc), the
  // same data the Replay Lab reads. Otherwise use the live cached snapshot.
  let snapshot: OptionChainSnapshot;
  if (requestedTradingDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedTradingDate)) {
      return reply.status(400).send({ message: "tradingDate must be formatted as YYYY-MM-DD." });
    }
    const daySnapshots = await listReplaySnapshots(requestedUnderlying, requestedExpiry, requestedTradingDate);
    const latest = daySnapshots[0];
    if (!latest) {
      return reply.status(404).send({ message: `No option chain snapshots stored for ${requestedUnderlying} on ${requestedTradingDate}.` });
    }
    const stored = await getOptionChainSnapshotById(latest.id);
    if (!stored) {
      return reply.status(404).send({ message: "Stored snapshot could not be loaded." });
    }
    snapshot = stored;
  } else {
    snapshot = await getCachedLatestSnapshotOrDemo(requestedUnderlying, requestedExpiry);
  }

  return {
    underlying: snapshot.underlyingSymbol,
    expiry: snapshot.expiry,
    tradingDate: snapshot.tradingDate,
    snapshotTime: snapshot.snapshotTime,
    spotPrice: snapshot.spotPrice,
    atmStrike: snapshot.atmStrike,
    analysis: calculateStrikeMatrix(snapshot, horizon)
  };
});

const alertThresholdSchema = z.object({
  proximityPoints: z.coerce.number().positive().max(10000),
  pcrUpper: z.coerce.number().min(0.01).max(10),
  pcrLower: z.coerce.number().min(0.01).max(10),
  pressureWarning: z.coerce.number().int().min(1).max(100),
  pressureCritical: z.coerce.number().int().min(1).max(100)
}).superRefine((value, context) => {
  if (value.pcrLower >= value.pcrUpper) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pcrLower"],
      message: "PCR lower threshold must be below PCR upper threshold."
    });
  }
  if (value.pressureWarning > value.pressureCritical) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pressureWarning"],
      message: "Warning pressure must be less than or equal to critical pressure."
    });
  }
});

app.get("/api/settings/alert-thresholds", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  return {
    thresholds: await listUserAlertThresholds(user.id)
  };
});

app.put<{
  Params: {
    underlying: string;
  };
}>("/api/settings/alert-thresholds/:underlying", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  const underlyingSymbol = normalizeUnderlyingKey(request.params.underlying);
  if (!visibleUnderlyings.includes(underlyingSymbol)) {
    return reply.status(400).send({ message: "Unsupported underlying." });
  }

  const parsed = alertThresholdSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({
      message: "Invalid alert thresholds.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  const threshold = await upsertUserAlertThreshold(user.id, {
    underlyingSymbol,
    ...parsed.data
  });
  marketSnapshotCache.clear();
  return { threshold };
});

app.get("/api/push/vapid-public-key", async () => ({
  enabled: Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY),
  publicKey: config.VAPID_PUBLIC_KEY ?? null
}));

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});

app.post("/api/push/subscriptions", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) {
    return reply.status(503).send({ message: "Browser push is not configured." });
  }

  const parsed = pushSubscriptionSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid push subscription." });
  }

  const subscription = await upsertPushSubscription(user.id, {
    ...parsed.data,
    userAgent: request.headers["user-agent"]
  });
  return { subscription };
});

app.delete("/api/push/subscriptions", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  const parsed = z.object({ endpoint: z.string().url().optional() }).safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid push disable request." });
  }

  await disablePushSubscriptionsForUser(user.id, parsed.data.endpoint);
  return { disabled: true };
});

app.get<{
  Querystring: {
    symbols?: string;
    underlying?: string;
    expiry?: string;
  };
}>("/api/market/stream", async (request, reply) => {
  const tickerSymbols = parseTickerSymbols(request.query.symbols);
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  const corsHeaders = origin && allowedOrigins.has(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin"
      }
    : {};

  reply.hijack();
  reply.raw.writeHead(200, {
    ...corsHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  reply.raw.write("retry: 5000\n\n");

  let closed = false;
  const writeEvent = (event: string, data: unknown) => {
    if (closed || reply.raw.destroyed) {
      return;
    }

    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const sendTicker = async () => {
    try {
      const marketAux = await getMarketAuxData(tickerSymbols);
      writeEvent("ticker", {
        indiaVix: marketAux.indiaVix,
        ticker: marketAux.ticker,
        serverTime: new Date().toISOString()
      });
    } catch (error) {
      app.log.warn({ error }, "Unable to emit market ticker stream event");
      writeEvent("error", {
        message: "Unable to refresh ticker stream",
        serverTime: new Date().toISOString()
      });
    }
  };
  const sendSnapshotReady = () => {
    writeEvent("snapshot-ready", {
      underlying: requestedUnderlying,
      expiry: requestedExpiry,
      serverTime: new Date().toISOString()
    });
  };
  const heartbeat = () => {
    writeEvent("heartbeat", {
      serverTime: new Date().toISOString()
    });
  };

  const tickerTimer = setInterval(() => {
    void sendTicker();
  }, MARKET_STREAM_TICKER_MS);
  const snapshotTimer = setInterval(sendSnapshotReady, MARKET_STREAM_SNAPSHOT_MS);
  const heartbeatTimer = setInterval(heartbeat, MARKET_STREAM_HEARTBEAT_MS);
  const clientId = nextMarketStreamClientId++;
  marketStreamClients.set(clientId, {
    id: clientId,
    underlying: requestedUnderlying,
    expiry: requestedExpiry,
    writeEvent
  });

  request.raw.on("close", () => {
    closed = true;
    clearInterval(tickerTimer);
    clearInterval(snapshotTimer);
    clearInterval(heartbeatTimer);
    marketStreamClients.delete(clientId);
  });

  await sendTicker();
  sendSnapshotReady();
});

app.get<{
  Querystring: {
    underlying?: string;
  };
}>("/api/market/expiries", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const expiries = await getCachedExpiriesOrEmpty(requestedUnderlying);

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
}>("/api/replay/trading-dates", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  return {
    tradingDates: await listReplayTradingDates(requestedUnderlying, requestedExpiry)
  };
});

app.get<{
  Querystring: {
    underlying?: string;
    expiry?: string;
    tradingDate?: string;
  };
}>("/api/replay/timeline", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  const requestedTradingDate = request.query.tradingDate?.trim() || undefined;
  return {
    snapshots: await listReplaySnapshots(requestedUnderlying, requestedExpiry, requestedTradingDate)
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

  // Keyed by the immutable snapshot id (not underlying:expiry, as the live
  // overview cache above is) since replay can jump between many different
  // historical snapshots of the same underlying/expiry - a past snapshot's
  // data never changes, so this is safe to cache the same way.
  const pressure = await getHotCacheValue(oiWeightedZonesCache, `replay:${request.params.id}`, OI_WEIGHTED_ZONES_CACHE_MS, () =>
    enrichZonesWithAvgSellPrice(calculatePressureScore(snapshot), snapshot.underlyingSymbol, snapshot.expiry)
  );
  const user = await getRequestUser(request.headers.cookie);
  const alertThreshold = user ? await getUserAlertThreshold(user.id, snapshot.underlyingSymbol) : null;
  const strikeMovement = calculateStrikeMovement(snapshot);
  const tradeInterpretation = calculateTradeInterpretation(strikeMovement);
  const marketBias = calculateMarketBias(snapshot, pressure);
  const marketPulse = await computeMarketPulseAsOf(snapshot.underlyingSymbol, snapshot.expiry, Date.parse(snapshot.snapshotTime));
  const atmStraddle = calculateAtmStraddleExpectedMove(snapshot);
  // Evaluated as-of the REPLAYED snapshot's own time, not real wall-clock
  // "now" - matters for time-aware alerts (gamma-risk) so a replay of a
  // long-past session reads correctly instead of comparing against today's
  // date and always falling outside the expiry window.
  const replayAsOf = new Date(snapshot.snapshotTime);
  return {
    snapshot,
    pressure,
    marketPulse,
    atmStraddle,
    alerts: generateMarketAlerts(snapshot, pressure, Number.isFinite(replayAsOf.getTime()) ? replayAsOf : new Date(), alertThreshold ?? undefined),
    strikeMovement,
    recommendations: calculateTradeRecommendations(snapshot, pressure, marketBias, strikeMovement, tradeInterpretation, atmStraddle)
  };
});

app.get("/api/paper/summary", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  return getPaperSummary(user);
});

// Paper Trading Pro (seller strategy simulator) - separate module, all
// routes under /api/sim/*. See sim-routes.ts.
registerSimRoutes(app, getRequestUser);

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

  tickerSymbolsCache.clear();
  marketAuxCache.clear();
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

  const { summary, orderId } = await placePaperOrder(parsed.data, user);
  const marginRecorded = await tryEstimateOrderMargin(orderId, null);
  return marginRecorded ? getPaperSummary(user) : summary;
});

// Build multi-leg at entry: one ticket, a main leg plus one or more hedge
// legs (e.g. a bought OTM option protecting a sold ATM/ITM option), all
// created together and linked as one strategy. Informational only in the
// sense that each leg still fills independently against its own requested
// price - this endpoint just lets the user submit them as one action
// instead of placing separate orders and manually tracking the pairing.
const paperOrderLegSchema = paperOrderSchema.extend({
  legRole: z.enum(["MAIN", "HEDGE"]).optional()
});

const multiLegPaperOrderSchema = z.object({
  legs: z.array(paperOrderLegSchema).min(1).max(6)
});

app.post("/api/paper/orders/multi-leg", async (request, reply) => {
  const user = await getRequestUser(request.headers.cookie);
  if (!user) {
    return reply.status(401).send({ message: "Login is required." });
  }

  const parsed = multiLegPaperOrderSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      message: "Invalid multi-leg paper order",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  for (const leg of parsed.data.legs) {
    const validationMessage = validatePaperOrderRisk(leg.action, leg.requestedPrice, leg.stopLoss, leg.targetPrice);
    if (validationMessage) {
      return reply.status(400).send({ message: validationMessage });
    }
  }

  const { summary, orderIds } = await placeMultiLegPaperOrder(parsed.data.legs, user);
  const groupId = summary.orders.find((order) => orderIds.includes(order.id))?.groupId ?? null;
  const marginRecorded = orderIds.length ? await tryEstimateOrderMargin(orderIds[0], groupId) : false;
  return marginRecorded ? getPaperSummary(user) : summary;
});

// Best-effort margin estimate at order placement time (works outside market
// hours - Dhan's margin calculator is a static SPAN/exposure lookup, not a
// live quote). Never throws: a failure here should never block placing the
// order itself, it just means no margin figure shows up yet. Returns
// whether a figure was actually recorded, so the caller knows whether it's
// worth re-fetching the summary to include it in the response.
async function tryEstimateOrderMargin(orderId: string, groupId: string | null): Promise<boolean> {
  try {
    const legs = await getPendingOrdersForMarginGroup(orderId, groupId);
    const scriptLegs = legs.filter((leg) => leg.securityId);
    if (!scriptLegs.length) {
      app.log.warn({ orderId, groupId }, "Margin estimate skipped: no leg has a known Dhan securityId yet");
      return false;
    }

    const margin = await dhan.calculateMultiOrderMargin(
      scriptLegs.map((leg) => ({
        transactionType: leg.action === "SELL" ? "SELL" : "BUY",
        quantity: leg.quantity,
        securityId: leg.securityId as string,
        price: leg.entryPrice,
        exchangeSegment: getFnoExchangeSegment(leg.underlyingSymbol)
      }))
    );

    await recordOrderMargin(
      legs.map((leg) => leg.id),
      margin.totalMargin,
      {
        spanMargin: margin.spanMargin,
        exposureMargin: margin.exposureMargin,
        foMargin: margin.foMargin,
        commodityMargin: margin.commodityMargin,
        currency: margin.currency,
        hedgeBenefit: margin.hedgeBenefit ?? null,
        legCount: scriptLegs.length,
        estimatedAt: "placement"
      }
    );

    return true;
  } catch (error) {
    app.log.warn({ error, orderId, groupId }, "Margin estimate skipped for new paper order (informational only)");
    return false;
  }
}

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
  targetPrice: z.coerce.number().nonnegative(),
  trailingStop: z.boolean().optional()
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
    return await updatePaperPositionRisk(request.params.id, user, parsed.data.stopLoss, parsed.data.targetPrice, parsed.data.trailDistance, parsed.data.trailingStop);
  } catch (error) {
    return reply.status(400).send({ message: error instanceof Error ? error.message : "Unable to update position risk" });
  }
});

function normalizeUnderlying(value: string | undefined): string {
  const normalized = normalizeUnderlyingKey(value ?? config.feedUnderlyings[0] ?? "NIFTY");
  return visibleUnderlyings.includes(normalized) ? normalized : String(visibleUnderlyings[0] ?? "NIFTY");
}

interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
}

async function sendTransactionalEmail(message: TransactionalEmail) {
  if (!config.SMTP_HOST) {
    throw new Error("SMTP_HOST is not configured");
  }

  await deliverSmtpEmail(message);
}

async function requireAdminUser(cookieHeader: string | undefined) {
  const userId = getSessionUserId(cookieHeader, config.SESSION_SECRET);
  const user = userId ? await getAuthUserById(userId) : null;
  return user && !user.disabled && user.role === "ADMIN" ? user : null;
}

async function getRequestUser(cookieHeader: string | undefined) {
  const userId = getSessionUserId(cookieHeader, config.SESSION_SECRET);
  const user = userId ? await getAuthUserById(userId) : null;
  return user?.disabled ? null : user;
}

async function deliverSmtpEmail(message: TransactionalEmail) {
  const host = config.SMTP_HOST;
  if (!host) {
    throw new Error("SMTP_HOST is not configured");
  }

  const envelopeFrom = extractEmailAddress(config.EMAIL_FROM);
  const envelopeTo = extractEmailAddress(message.to);
  const client = await openSmtpConnection(host, config.SMTP_PORT, config.SMTP_SECURE);

  try {
    await client.expect(220);
    await client.command(`EHLO ${getSmtpHeloName()}`, 250);

    if (!config.SMTP_SECURE) {
      await client.command("STARTTLS", 220);
      await client.startTls(host);
      await client.command(`EHLO ${getSmtpHeloName()}`, 250);
    }

    if (config.SMTP_USER && config.SMTP_PASSWORD) {
      await client.command("AUTH LOGIN", 334);
      await client.command(Buffer.from(config.SMTP_USER).toString("base64"), 334);
      await client.command(Buffer.from(config.SMTP_PASSWORD).toString("base64"), 235);
    }

    await client.command(`MAIL FROM:<${envelopeFrom}>`, 250);
    await client.command(`RCPT TO:<${envelopeTo}>`, [250, 251]);
    await client.command("DATA", 354);
    await client.command(formatEmailMessage(message), 250);
  } finally {
    await client.quit();
  }
}

async function openSmtpConnection(host: string, port: number, secure: boolean) {
  let socket: net.Socket | tls.TLSSocket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  let buffer = "";
  const pending: Array<(value: string) => void> = [];

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    flushSmtpReplies();
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  function flushSmtpReplies() {
    while (pending.length) {
      const reply = readCompleteSmtpReply(buffer);
      if (!reply) {
        return;
      }
      buffer = buffer.slice(reply.length);
      pending.shift()?.(reply);
    }
  }

  function readReply() {
    return new Promise<string>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off("close", onClose);
        reject(error);
      };
      const onClose = () => {
        socket.off("error", onError);
        reject(new Error("SMTP connection closed"));
      };
      socket.once("error", onError);
      socket.once("close", onClose);
      pending.push((reply) => {
        socket.off("error", onError);
        socket.off("close", onClose);
        resolve(reply);
      });
      flushSmtpReplies();
    });
  }

  async function expect(expectedCodes: number | number[]) {
    const reply = await readReply();
    assertSmtpReply(reply, expectedCodes);
    return reply;
  }

  async function command(commandText: string, expectedCodes: number | number[]) {
    socket.write(`${commandText}\r\n`);
    return expect(expectedCodes);
  }

  async function startTls(servername: string) {
    socket = tls.connect({ socket, servername });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      flushSmtpReplies();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
  }

  async function quit() {
    if (socket.destroyed) {
      return;
    }
    try {
      await command("QUIT", 221);
    } catch {
      // Closing quietly is acceptable after a failed SMTP transaction.
    } finally {
      socket.end();
    }
  }

  return { command, expect, quit, startTls };
}

function readCompleteSmtpReply(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  let consumed = 0;
  for (const line of lines) {
    if (!line) {
      break;
    }
    consumed += line.length + (buffer[consumed + line.length] === "\r" ? 2 : 1);
    if (/^\d{3} /.test(line)) {
      return buffer.slice(0, consumed);
    }
  }
  return null;
}

function assertSmtpReply(reply: string, expectedCodes: number | number[]) {
  const expected = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  const code = Number(reply.slice(0, 3));
  if (!expected.includes(code)) {
    throw new Error(`SMTP command failed with ${code}: ${sanitizeSmtpReply(reply)}`);
  }
}

function sanitizeSmtpReply(reply: string) {
  return reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500);
}

function formatEmailMessage(message: TransactionalEmail) {
  const headers = [
    `From: ${config.EMAIL_FROM}`,
    `To: ${message.to}`,
    `Subject: ${sanitizeEmailHeader(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  return `${headers.join("\r\n")}\r\n\r\n${message.text.replace(/\r?\n/g, "\r\n")}\r\n.`;
}

function sanitizeEmailHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function extractEmailAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

function getSmtpHeloName() {
  return new URL(config.APP_PUBLIC_URL).hostname || "pytrade.co.in";
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

async function getCachedExpiriesOrEmpty(underlyingSymbol: string) {
  return getHotCacheValue(expiriesCache, underlyingSymbol, MARKET_EXPIRIES_CACHE_MS, () => getExpiriesOrEmpty(underlyingSymbol));
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

async function getCachedTradableExpiriesOrEmpty(underlyingSymbol: string) {
  return getHotCacheValue(tradableExpiriesCache, underlyingSymbol, MARKET_EXPIRIES_CACHE_MS, () => getTradableExpiriesOrEmpty(underlyingSymbol));
}

// Unlike getExpiriesOrEmpty (which prioritizes expiries we've already
// captured snapshot history for, since that list feeds Replay Lab/Market
// Controls which need actual stored data), this is for pickers where the
// user is choosing an expiry to trade FORWARD from now (e.g. the Paper
// Trading order ticket's "trade next week's expiry" selector) - it should
// offer every expiry the broker currently lists as tradable, even ones
// nothing has ever been captured for yet. getLatestSnapshotOrDemo already
// knows how to fetch a live chain for a never-before-seen expiry, so once
// picked here it just works.
async function getTradableExpiriesOrEmpty(underlyingSymbol: string) {
  const underlying = getUnderlyingDefinition(underlyingSymbol);
  if (!underlying) {
    return [];
  }

  try {
    const liveExpiries = await dhan.getExpiryList(underlying);
    if (liveExpiries.length) {
      return liveExpiries;
    }
  } catch (error) {
    app.log.warn({ error, underlyingSymbol }, "Unable to list live tradable expiries; falling back to stored expiries");
  }

  return getExpiriesOrEmpty(underlyingSymbol);
}

async function getCachedLatestSnapshotOrDemo(underlyingSymbol: string, expiry?: string) {
  const cacheKey = `${underlyingSymbol}:${expiry ?? ""}`;
  return getHotCacheValue(marketSnapshotCache, cacheKey, MARKET_SNAPSHOT_CACHE_MS, () => getLatestSnapshotOrDemo(underlyingSymbol, expiry));
}

// Shared by both the live dashboard (asOfMs = now) and replay (asOfMs =
// the historical snapshot's own time) so a replayed pulse reading is
// anchored to "what the trailing 5 minutes looked like at that moment in
// history", not accidentally pulled forward to include readings between
// then and the actual present.
async function computeMarketPulseAsOf(underlyingSymbol: string, expiry: string, asOfMs: number) {
  try {
    const history = await listRecentPressureHistory(underlyingSymbol, expiry, asOfMs - MARKET_PULSE_WINDOW_MS, asOfMs);
    return calculateMarketPulse(history);
  } catch (error) {
    app.log.warn({ error, underlyingSymbol, expiry, asOfMs }, "Unable to compute market pulse");
    return null;
  }
}

async function getCachedMarketPulse(underlyingSymbol: string, expiry: string) {
  const cacheKey = `${underlyingSymbol}:${expiry}`;
  return getHotCacheValue(marketPulseCache, cacheKey, MARKET_PULSE_CACHE_MS, () => computeMarketPulseAsOf(underlyingSymbol, expiry, Date.now()));
}

async function getLatestSnapshotOrDemo(underlyingSymbol: string, expiry?: string, spotPriceOverride?: number) {
  try {
    const underlying = getUnderlyingDefinition(underlyingSymbol);
    const storedSnapshot = await getLatestOptionChainSnapshot(underlyingSymbol, expiry);
    if (storedSnapshot) {
      if (!underlying || !isSegmentMarketSessionOpen(underlying.segment) || !isSnapshotStale(storedSnapshot.snapshotTime)) {
        return storedSnapshot;
      }

      const liveExpiry = expiry ?? storedSnapshot.expiry;
      try {
        return await dhan.getOptionChain({ underlying, expiry: liveExpiry, spotPriceOverride });
      } catch (liveError) {
        app.log.warn({ error: liveError, underlyingSymbol, expiry: liveExpiry }, "Stored snapshot is stale; live option-chain refresh failed");
      }

      return storedSnapshot;
    }

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

function isSnapshotStale(snapshotTime: string) {
  const parsed = Date.parse(snapshotTime);
  return Number.isFinite(parsed) && Date.now() - parsed > LIVE_SNAPSHOT_STALE_MS;
}

async function getTickerSymbols(selectedUnderlying?: string) {
  const selectedSymbol = normalizeUnderlyingKey(selectedUnderlying);
  const cacheKey = selectedSymbol || "default";
  return getHotCacheValue(tickerSymbolsCache, cacheKey, WATCHLIST_SYMBOLS_CACHE_MS, async () => {
    const watchlist = await getDefaultWatchlist().catch(() => null);
    return normalizeTickerSymbols([selectedUnderlying, ...(watchlist?.symbols ?? [])]);
  });
}

function parseTickerSymbols(symbols?: string) {
  if (!symbols) {
    return undefined;
  }

  return normalizeTickerSymbols(symbols.split(","));
}

function normalizeTickerSymbols(symbols: Array<string | undefined>) {
  const normalized = symbols.map((symbol) => normalizeUnderlyingKey(symbol)).filter((symbol) => tickerUnderlyings.includes(symbol));
  return normalized.length ? [...new Set(normalized)] : undefined;
}

// Stale-while-revalidate: ticker/India VIX data is auxiliary display info
// (getFreshMarketAuxData already wraps the underlying Dhan calls in
// Promise.allSettled with a graceful per-quote fallback), but the old
// version still made every /api/market/overview response WAIT on a fresh
// Dhan round trip whenever the 5s cache had expired - which, given the
// dashboard polls roughly every 25-30s, was effectively every single
// request. Confirmed in production this was adding ~1s to every overview
// call, worse whenever the ongoing DhanApiError issue (LTP/OHLC/ticker
// fetch failures - still unresolved, token/rate-limit/outage unconfirmed)
// meant that second was spent failing rather than succeeding. Now: once
// we have ANY cached value, serve it immediately even if stale, and
// refresh in the background for next time - only a cold start (no cached
// value at all yet) still blocks on a live fetch.
async function getMarketAuxData(symbols?: string[]) {
  const requestedSymbols = normalizeTickerSymbols(symbols ?? tickerUnderlyings) ?? tickerUnderlyings;
  const cacheKey = requestedSymbols.slice().sort().join(",");
  const now = Date.now();
  const cached = marketAuxCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached) {
    if (!cached.refreshing) {
      cached.refreshing = true;
      getFreshMarketAuxData(requestedSymbols)
        .then((value) => {
          marketAuxCache.set(cacheKey, { expiresAt: Date.now() + MARKET_AUX_CACHE_MS, value });
        })
        .catch((error) => {
          cached.refreshing = false;
          app.log.warn({ error }, "Background market aux refresh failed; continuing to serve stale ticker data");
        });
    }
    return cached.value;
  }

  const value = await getFreshMarketAuxData(requestedSymbols);
  marketAuxCache.set(cacheKey, {
    expiresAt: now + MARKET_AUX_CACHE_MS,
    value
  });
  return value;
}

async function getHotCacheValue<T>(cache: Map<string, HotCacheEntry<T>>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const pending = load()
    .then((value) => {
      cache.set(key, {
        expiresAt: Date.now() + ttlMs,
        value
      });
      return value;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, {
    expiresAt: now + ttlMs,
    promise: pending
  });
  return pending;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreshMarketAuxData(symbols: string[]) {
  const definitions = symbols.map((symbol) => getUnderlyingDefinition(symbol)).filter((definition): definition is NonNullable<typeof definition> => Boolean(definition));

  try {
    const quoteDefinitions = await dhan.resolveQuoteUnderlyings(definitions);
    const quoteUnderlyings = [...quoteDefinitions, INDIA_VIX_UNDERLYING];
    // Dhan caps Market Quote calls at 1 request/sec ACROSS BOTH the LTP and
    // OHLC endpoints combined (not 1/sec each) - see
    // https://docs.dhanhq.co/api/v2/guides/rate-limits. Firing these two
    // calls concurrently via Promise.all therefore breached the limit on
    // every single refresh, regardless of how infrequently refreshes
    // themselves happened. Run them sequentially with a >1s gap instead.
    const ltpResult = await dhan
      .getLtpQuotes(quoteUnderlyings)
      .then((value) => ({ status: "fulfilled" as const, value }))
      .catch((reason) => ({ status: "rejected" as const, reason }));
    await sleep(1100);
    const ohlcResult = await dhan
      .getOhlcQuotes(quoteUnderlyings)
      .then((value) => ({ status: "fulfilled" as const, value }))
      .catch((reason) => ({ status: "rejected" as const, reason }));
    const ltpQuotes = ltpResult.status === "fulfilled" ? ltpResult.value : new Map<string, { lastPrice?: number }>();
    const ohlcQuotes = ohlcResult.status === "fulfilled" ? ohlcResult.value : new Map<string, { lastPrice?: number; previousClose?: number }>();
    if (ltpResult.status === "rejected") {
      app.log.warn({ error: ltpResult.reason }, "Unable to fetch market LTP from Dhan");
    }
    if (ohlcResult.status === "rejected") {
      app.log.warn({ error: ohlcResult.reason }, "Unable to fetch market OHLC from Dhan");
    }
    if (ltpResult.status === "rejected" && ohlcResult.status === "rejected") {
      throw ltpResult.reason;
    }

    const ticker = await Promise.all(quoteDefinitions.map(async (definition) => {
      const ltpQuote = ltpQuotes.get(definition.key);
      const ohlcQuote = ohlcQuotes.get(definition.key);
      const storedChange = await getLatestSpotChange(definition.key).catch(() => null);
      const useStoredLastFeed = shouldUseStoredTickerFeed(definition);
      const liveSpotPrice = firstPositiveNumber(ltpQuote?.lastPrice, ohlcQuote?.lastPrice);
      const livePreviousClose = firstPositiveNumber(ohlcQuote?.previousClose);
      const storedSpotPrice = firstPositiveNumber(storedChange?.spotPrice);
      const storedPreviousClose = firstPositiveNumber(storedChange?.previousClose);
      const spotPrice = useStoredLastFeed ? storedSpotPrice ?? liveSpotPrice : liveSpotPrice ?? storedSpotPrice;
      const previousClose = useStoredLastFeed ? storedPreviousClose ?? livePreviousClose : livePreviousClose ?? storedPreviousClose;
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
      indiaVix: firstPositiveNumber(ltpQuotes.get(INDIA_VIX_UNDERLYING.key)?.lastPrice, ohlcQuotes.get(INDIA_VIX_UNDERLYING.key)?.lastPrice),
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

function firstPositiveNumber(...values: Array<number | undefined>) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
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

function handleSnapshotSavedMessage(message: string) {
  let payload: MarketSnapshotSavedMessage;
  try {
    payload = JSON.parse(message) as MarketSnapshotSavedMessage;
  } catch (error) {
    app.log.warn({ error, message }, "Ignoring malformed market snapshot pub/sub message");
    return;
  }

  if (!payload.underlying || !payload.expiry || !payload.snapshotId) {
    app.log.warn({ payload }, "Ignoring incomplete market snapshot pub/sub message");
    return;
  }

  clearMarketSnapshotCache(payload.underlying, payload.expiry);
  for (const client of marketStreamClients.values()) {
    if (client.underlying !== payload.underlying) {
      continue;
    }

    if (client.expiry && client.expiry !== payload.expiry) {
      continue;
    }

    client.writeEvent("snapshot-ready", payload);
  }
}

function clearMarketSnapshotCache(underlying: string, expiry?: string) {
  for (const cacheKey of marketSnapshotCache.keys()) {
    if (cacheKey === `${underlying}:` || cacheKey.startsWith(`${underlying}:`)) {
      if (!expiry || cacheKey === `${underlying}:${expiry}` || cacheKey === `${underlying}:`) {
        marketSnapshotCache.delete(cacheKey);
      }
    }
  }
}

async function startMarketSnapshotSubscriber() {
  redisSubscriber.on("error", (error) => {
    app.log.warn({ error }, "Market snapshot Redis subscriber error");
  });
  redisSubscriber.on("message", (channel, message) => {
    if (channel === MARKET_SNAPSHOT_SAVED_CHANNEL) {
      handleSnapshotSavedMessage(message);
    }
  });

  await redisSubscriber.connect();
  await redisSubscriber.subscribe(MARKET_SNAPSHOT_SAVED_CHANNEL);
  app.log.info({ channel: MARKET_SNAPSHOT_SAVED_CHANNEL }, "Subscribed to market snapshot notifications");
}

app.addHook("onClose", async () => {
  await redisSubscriber.quit().catch((error: unknown) => {
    app.log.warn({ error }, "Unable to close market snapshot Redis subscriber cleanly");
  });
});

await startMarketSnapshotSubscriber();

const address = await app.listen({
  port: config.API_PORT,
  host: "0.0.0.0"
});

app.log.info(`Option Decode API listening at ${address}`);

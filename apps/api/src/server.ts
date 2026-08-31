import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import Redis from "ioredis";
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { z } from "zod";
import { calculateAtmIvPercentile, calculateAtmStraddleExpectedMove, calculateElliottWave, calculateMarketBias, calculateMarketPulse, calculatePressureScore, calculateStrikeMatrix, calculateStrikeMovement, calculateTradeInterpretation, generateMarketAlerts, isTradingHorizon, WAVE_ZIGZAG_PRESETS } from "@option-decode/analytics";
import { calculateTradeRecommendations } from "@option-decode/trading";
import { loadConfig } from "@option-decode/config";
import { buildPasswordResetEmail, buildVerificationEmail } from "./email-templates.js";
import { buildDemoSnapshot, calculateOiWeightedAverageSellPrices, cancelPendingPaperOrder, closePaperPosition, createEmailVerificationToken, createPasswordResetToken, createUser, disablePushSubscriptionsForUser, getAdminOverview, getAtmCallIvHistory, getAuthUserById, getDefaultWatchlist, getLatestOptionChainSnapshot, getLatestSpotChange, getOptionChainSnapshotById, getPaperSummary, getPendingOrdersForMarginGroup, getSimSummaryForUserId, getSpotPriceHistory, getUserAlertThreshold, getUserCredentialsByEmail, listPcrTrend, listRecentPressureHistory, listRecentWaveAlerts, listSimAccountsForAdmin, listReplaySnapshots, listReplayTradingDates, listStoredExpiries, listUserAlertThresholds, logDhanApiRequest, markUserLogin, placeMultiLegPaperOrder, placePaperOrder, recordOrderMargin, resetPasswordWithToken, saveOptionChainSnapshot, setUserTabs, updateAdminUserDisabled, updateAdminUserRole, updateDefaultWatchlist, updatePaperPositionRisk, updatePendingPaperOrder, upsertPushSubscription, upsertUserAlertThreshold, validatePaperOrderCapacity, verifyEmailToken } from "@option-decode/db";
import { DhanClient, getFnoExchangeSegment, getSupportedUnderlyingKeys, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { DhanLiveFeedExchangeSegment } from "@option-decode/dhan";
import type { ElliottWaveAnalysis, MarketPulse, OptionChainSnapshot, PressureScore, TradingHorizon, UnderlyingDefinition } from "@option-decode/types";
import { isExpiryInPast, isMarketSessionOpen as isSegmentMarketSessionOpen } from "@option-decode/utils";
import { createClearedSessionCookie, createSessionCookie, getSessionUserId, hashPassword, verifyPassword } from "./auth.js";
import { startApiMemorySampling } from "./api-memory.js";
import { getLiveTicks } from "./live-tick-cache.js";
import { registerLiveRoutes } from "./live-routes.js";
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
const KNOWN_LIVE_FEED_SEGMENTS = new Set<DhanLiveFeedExchangeSegment>(["IDX_I", "NSE_EQ", "NSE_FNO", "NSE_CURRENCY", "BSE_EQ", "MCX_COMM", "BSE_CURRENCY", "BSE_FNO"]);
function toLiveFeedSegment(segment: string): DhanLiveFeedExchangeSegment | undefined {
  return KNOWN_LIVE_FEED_SEGMENTS.has(segment as DhanLiveFeedExchangeSegment) ? (segment as DhanLiveFeedExchangeSegment) : undefined;
}
// Was a flat 5s, which meant the ticker's stale-while-revalidate cache
// went stale almost as fast as the frontend polled it, so nearly every
// poll cycle kicked off a fresh Dhan LTP/OHLC round trip - combined with
// the worker's own 30s snapshot-cycle Dhan calls, this pushed total
// request volume over Dhan's rate limit and surfaced as intermittent
// HTTP 429 DhanApiErrors. Raised to 25s to fix that (2026-07-29).
//
// Now conditional: when the Dhan Live Market Feed is enabled,
// getFreshMarketAuxData reads most of this data from a Redis tick cache
// instead of REST (see live-tick-cache.ts) - a 1s TTL costs nothing there,
// and is what actually lets the ticker strip reflect the feed's ~1s
// cadence end to end. When the feed is off (or REST is the fallback path
// for whatever it hasn't reported fresh data for), stay at the
// proven-safe 25s - a short TTL on pure REST polling is exactly what
// caused the original incident above.
const MARKET_AUX_CACHE_MS = config.LIVE_MARKET_FEED_ENABLED ? 1_000 : 25_000;
const MARKET_SNAPSHOT_CACHE_MS = 10_000;
// Expiry lists only change at rollover - once a week for index weeklies,
// once a month for stocks/MCX commodities - and only overnight, never
// mid-session. A 10s TTL was effectively no caching at all: the
// DhanApiRequestLog audit (2026-07-29) showed api:tradable-expiries +
// worker:index-capture:expiry-list together accounting for ~37% of all
// Dhan traffic. An hour of staleness is harmless here - the current front
// expiry stays valid until it actually settles, so the worst case is a
// brand-new expiry taking up to an hour to appear as selectable.
const MARKET_EXPIRIES_CACHE_MS = 60 * 60 * 1000;
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
// Matches MIN_IV_RANK_HISTORY_DAYS in @option-decode/analytics's Strike
// Matrix engine - fetches a bit more than the minimum the rule needs so a
// day or two of missing/incomplete history doesn't tip it back into
// "insufficient data."
const IV_RANK_LOOKBACK_DAYS = 25;
const WATCHLIST_SYMBOLS_CACHE_MS = 30_000;
const LIVE_SNAPSHOT_STALE_MS = 90_000;
// Matches MARKET_AUX_CACHE_MS's reasoning: pushing every 1s only reflects
// genuinely new data when the live feed is on (getMarketAuxData's own
// cache TTL is what actually gates freshness) - on pure REST, a 1s push
// interval would just resend the same 25s-cached value 25x over for no
// benefit, so keep the wider interval there.
const MARKET_STREAM_TICKER_MS = config.LIVE_MARKET_FEED_ENABLED ? 1_000 : 5_000;
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
interface ElliottWaveApiResponse {
  underlying: string;
  horizon: TradingHorizon;
  zigZagPercent: number;
  pointCount: number;
  analysis: ElliottWaveAnalysis;
}
const elliottWaveCache = new Map<string, HotCacheEntry<ElliottWaveApiResponse>>();
// How far back to pull spot-price history before running ZigZag detection,
// per horizon - wide enough to contain several confirmed swings at that
// horizon's threshold (see WAVE_ZIGZAG_PRESETS), capped by
// getSpotPriceHistory's own MAX_SPOT_PRICE_HISTORY_ROWS row limit regardless
// of how wide the window is asked to be.
const ELLIOTT_WAVE_LOOKBACK_MS: Record<TradingHorizon, number> = {
  intraday: 2 * 24 * 60 * 60 * 1000,
  weekly: 20 * 24 * 60 * 60 * 1000,
  monthly: 180 * 24 * 60 * 60 * 1000
};
// Matches the Strike Matrix tab's own per-horizon refresh cadence - the
// underlying spot series doesn't move fast enough at weekly/monthly scale to
// justify polling more often than that.
const ELLIOTT_WAVE_CACHE_MS: Record<TradingHorizon, number> = {
  intraday: 60_000,
  weekly: 5 * 60_000,
  monthly: 15 * 60_000
};
const oiWeightedZonesCache = new Map<string, HotCacheEntry<PressureScore>>();
const marketPulseCache = new Map<string, HotCacheEntry<MarketPulse | null>>();
// ATM IV history changes once per trading day, so it is cached far longer
// than the 10s market caches. Without this the overview route would pay for
// a multi-day history walk on every poll.
const atmIvHistoryCache = new Map<string, HotCacheEntry<number[]>>();
const ATM_IV_HISTORY_CACHE_MS = 30 * 60 * 1000;
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
  accessToken: config.DHAN_ACCESS_TOKEN,
  // Fire-and-forget audit log of every Dhan request this api server makes
  // - see DhanApiRequestLog in @option-decode/db. Not awaited, and wrapped
  // so a DB hiccup here can never surface as if the Dhan call itself
  // failed.
  onRequest: (event) => {
    logDhanApiRequest(event).catch((error) => {
      app.log.warn({ error, caller: event.caller }, "Failed to write Dhan API request audit log");
    });
  }
});
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug"
  },
  // Every request arrives from nginx on loopback, so without this `request.ip`
  // is 127.0.0.1 for the entire internet and any per-IP logic silently becomes
  // per-server. Scoped to loopback rather than `true`: nginx is the only thing
  // that can reach this port, and trusting all proxies would let a client
  // forge X-Forwarded-For if that ever stopped being true.
  trustProxy: "127.0.0.1"
});
const redisSubscriber = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true
});
// Separate from redisSubscriber on purpose - once a connection calls
// .subscribe(), ioredis restricts it to pub/sub only and regular commands
// (GET/MGET) throw. This one is for reading the worker's Dhan live feed
// tick cache (see live-tick-cache.ts).
const redisCache = new Redis(config.REDIS_URL, {
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

// Registration demands more than login does: a real name and a reachable
// mobile number, both mandatory. Login still uses authSchema.pick(), so
// existing accounts - which predate the mobile column and have none - can
// still sign in.
//
// Stored as bare 10 digits. Indian mobile numbers start 6-9, and callers
// variously send "+91 98765 43210", "091-9876543210" or "9876543210"; if
// those were stored verbatim the same person would look like three
// different users the first time anyone tries to match on this column.
const registerSchema = authSchema.extend({
  displayName: z.string().trim().min(1).max(80),
  mobile: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s()-]/g, ""))
    .refine((value) => /^(\+?91)?[6-9]\d{9}$/.test(value), {
      message: "Enter a valid 10-digit Indian mobile number."
    })
    .transform((value) => value.replace(/^\+?91/, ""))
});

const emailSchema = z.object({
  email: z.string().trim().email()
});

const resetPasswordSchema = z.object({
  token: z.string().trim().min(20),
  password: z.string().min(8).max(128)
});

app.post("/api/auth/register", async (request, reply) => {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    // Surface the field-level reason - "Invalid registration details" gives a
    // user no way to tell a malformed mobile number from a short password.
    const detail = parsed.error.issues[0]?.message;
    return reply.status(400).send({ message: detail ?? "Invalid registration details" });
  }

  let user: Awaited<ReturnType<typeof createUser>>;
  try {
    user = await createUser({
      email: parsed.data.email,
      passwordHash: hashPassword(parsed.data.password),
      displayName: parsed.data.displayName,
      mobile: parsed.data.mobile
    });
  } catch (error) {
    request.log.warn({ error }, "User registration failed");
    return reply.status(409).send({ message: "An account already exists for this email." });
  }

  // Minting the token is guarded as well as sending it: the account already
  // exists by this point, so a failure here still needs the "created, but"
  // answer rather than a bare 500 that reads like the signup itself failed.
  let verificationSent = false;
  try {
    const verification = await createEmailVerificationToken(user.email);
    const email = buildVerificationEmail(user.displayName, `${config.APP_PUBLIC_URL}/verify-email?token=${verification.token}`);
    verificationSent = await trySendTransactionalEmail(request.log, "register", { to: verification.email, ...email });
  } catch (error) {
    request.log.error({ err: error, flow: "register", to: user.email }, "Verification token could not be created");
  }
  if (!verificationSent) {
    return reply.status(503).send({ message: "Account was created, but verification email could not be sent. Please contact support." });
  }

  // Deliberately NO session cookie. Registration used to sign the account in
  // immediately, which made the verification email decorative - nothing ever
  // checked it, and /api/auth/login did not either. An account is now inert
  // until the address behind it is proven, so the only thing this returns is
  // an instruction to go and read the email.
  return {
    ok: true,
    verificationRequired: true,
    email: user.email,
    message: "Account created. Check your email for a verification link, then sign in."
  };
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
  // The gate that makes verification mean something. Registration no longer
  // issues a session, but without this an unverified account could simply go
  // to the login page and get one anyway - which is exactly what it did
  // before. Checked AFTER the password, so an attacker cannot use this
  // response to discover which addresses are registered.
  if (!credentials.emailVerified) {
    return reply.status(403).send({
      message: "Please verify your email address first. Check your inbox for the verification link.",
      verificationRequired: true
    });
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
  // Safe to be candid here - the caller is already authenticated as this
  // account, so admitting the send failed leaks nothing.
  const email = buildVerificationEmail(user.displayName, `${config.APP_PUBLIC_URL}/verify-email?token=${verification.token}`);
  const sent = await trySendTransactionalEmail(request.log, "resend-verification", { to: verification.email, ...email });
  if (!sent) {
    return reply.status(503).send({ message: "Verification email could not be sent right now. Please try again shortly or contact support." });
  }
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

// Unauthenticated endpoints that send mail need a ceiling, because every
// request costs a real message against a real mailbox quota. Two independent
// limits: per-address stops one victim being buried in reset mail, per-IP
// stops one caller draining the day's send quota across many addresses and
// locking every genuine user out of password recovery.
const FORGOT_PASSWORD_LIMIT_PER_EMAIL = 3;
const FORGOT_PASSWORD_LIMIT_PER_IP = 10;
const FORGOT_PASSWORD_WINDOW_SECONDS = 60 * 60;

/**
 * INCR-and-expire counter in Redis rather than in-process: the count has to
 * survive an API restart, or anyone rate-limited could just wait for a deploy.
 *
 * Fails OPEN. If Redis is unreachable this is a safety valve that has stopped
 * working, not a security boundary that has been breached - refusing every
 * password reset during a Redis blip would be the worse outcome. The failure
 * is logged so it doesn't pass silently.
 */
async function consumeRateLimit(log: FastifyBaseLogger, bucket: string, limit: number, windowSeconds: number) {
  const key = `ratelimit:${bucket}`;
  try {
    const count = await redisCache.incr(key);
    if (count === 1) {
      await redisCache.expire(key, windowSeconds);
    }
    if (count > limit) {
      const ttl = await redisCache.ttl(key);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    log.error({ err: error, bucket }, "Rate limit check failed, allowing request");
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

app.post("/api/auth/forgot-password", async (request, reply) => {
  const parsed = emailSchema.safeParse(request.body);

  // Deliberately BEFORE any account lookup, and applied to well-formed
  // addresses whether or not they exist. A limit that only kicked in for real
  // accounts would hand an attacker the enumeration oracle that the
  // unconditional {ok:true} below exists to deny them.
  const limits = parsed.success
    ? [
        { bucket: `forgot-password:email:${parsed.data.email.toLowerCase()}`, limit: FORGOT_PASSWORD_LIMIT_PER_EMAIL },
        { bucket: `forgot-password:ip:${request.ip}`, limit: FORGOT_PASSWORD_LIMIT_PER_IP }
      ]
    : [{ bucket: `forgot-password:ip:${request.ip}`, limit: FORGOT_PASSWORD_LIMIT_PER_IP }];

  for (const { bucket, limit } of limits) {
    const result = await consumeRateLimit(request.log, bucket, limit, FORGOT_PASSWORD_WINDOW_SECONDS);
    if (!result.allowed) {
      request.log.warn({ bucket, limit, ip: request.ip }, "Password reset rate limit hit");
      return reply
        .status(429)
        .header("retry-after", String(result.retryAfterSeconds))
        .send({ message: "Too many password reset requests. Please try again later." });
    }
  }

  if (parsed.success) {
    const reset = await createPasswordResetToken(parsed.data.email);
    if (reset) {
      const email = buildPasswordResetEmail(reset.displayName, `${config.APP_PUBLIC_URL}/reset-password?token=${reset.token}`);
      await trySendTransactionalEmail(request.log, "forgot-password", { to: reset.email, ...email });
    }
  }

  // Deliberately unconditional. A bad address, a disabled account and a failed
  // send must be indistinguishable from success, or this endpoint becomes an
  // account-enumeration oracle. The operator learns about failures from the
  // log line above, not from the response.
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

  // A valid reset token proves control of the mailbox, but that is not the
  // proof the login gate checks for - emailVerified. Without this, an
  // unverified signup could skip "verify email" entirely by going straight
  // to "forgot password": createUser leaves the account emailVerified=false,
  // /api/auth/forgot-password sends a reset link to any address whether or
  // not it is verified, and this route came out the other end setting a
  // session cookie unconditionally. Confirmed live: an unverified account
  // could reset its password and land inside the app having never proven
  // the address was real.
  //
  // Since they DID just prove mailbox control - just not via the
  // verification link specifically - a fresh one is sent here rather than
  // leaving them stuck. Without this they would have no way back in at all:
  // resend-verification requires being logged in, which an unverified
  // account cannot do.
  if (!user.emailVerified) {
    const verification = await createEmailVerificationToken(user.email);
    const email = buildVerificationEmail(user.displayName, `${config.APP_PUBLIC_URL}/verify-email?token=${verification.token}`);
    // Best-effort and not reflected in the response either way: the password
    // is already changed regardless of whether this send succeeds, and a 503
    // here would read as the password change having failed when it did not.
    await trySendTransactionalEmail(request.log, "reset-password-unverified", { to: verification.email, ...email });
    return {
      ok: true,
      verificationRequired: true,
      message: "Password updated. We've also sent a new verification link to your email - verify your address, then sign in."
    };
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

// Paper Trade Pro oversight. READ ONLY, deliberately: an admin can look at
// anyone's simulator account but cannot close a trade or reset a balance.
// Acting on another user's positions is a different feature with a different
// blast radius, and leaving it out means no bug here can move someone's money,
// paper or otherwise.
//
// These live in their own /api/admin/sim/* namespace rather than adding a
// userId parameter to /api/sim/*. That surface currently takes NO user
// identifier at all - every route acts strictly as the caller - and that is a
// structural guarantee worth keeping: it means no future role-checking bug can
// turn an ordinary endpoint into a cross-user data leak.
app.get("/api/admin/sim/accounts", async (request, reply) => {
  const admin = await requireAdminUser(request.headers.cookie);
  if (!admin) {
    return reply.status(403).send({ message: "Admin access is required." });
  }
  return { accounts: await listSimAccountsForAdmin() };
});

app.get<{ Params: { userId: string } }>("/api/admin/sim/accounts/:userId", async (request, reply) => {
  const admin = await requireAdminUser(request.headers.cookie);
  if (!admin) {
    return reply.status(403).send({ message: "Admin access is required." });
  }
  // Null means the user has no simulator account - a 404, NOT an empty
  // summary. getSimSummaryForUserId deliberately does not create one, so an
  // admin browsing to a user who has never traded cannot conjure an account
  // into existence just by looking.
  const summary = await getSimSummaryForUserId(request.params.userId);
  if (!summary) {
    return reply.status(404).send({ message: "That user has no simulator account." });
  }
  return summary;
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
  // Keyed by the exact capture (snapshotTime), not just underlying+expiry.
  // The snapshot cache keys on the REQUESTED expiry - "" when the client
  // sends none - while this one keyed on the RESOLVED expiry, so two
  // different snapshot-cache entries ("NIFTY:" and "NIFTY:2026-08-04")
  // that resolve to the same expiry shared a single pressure entry, and
  // whichever populated it first won. Within their independent 10s TTLs
  // that let ticks from one capture pair with bias/zones computed from
  // another. Including snapshotTime makes the pressure entry belong to the
  // ticks actually being returned - the same discipline the replay route
  // below already uses by keying on its snapshot id.
  const pressureCacheKey = `${snapshot.underlyingSymbol}:${snapshot.expiry}:${snapshot.snapshotTime}`;
  const pressure = await getHotCacheValue(oiWeightedZonesCache, pressureCacheKey, OI_WEIGHTED_ZONES_CACHE_MS, () =>
    enrichZonesWithAvgSellPrice(calculatePressureScore(snapshot), snapshot.underlyingSymbol, snapshot.expiry)
  );
  const alertThreshold = user ? await getUserAlertThreshold(user.id, snapshot.underlyingSymbol) : null;
  const alerts = generateMarketAlerts(snapshot, pressure, new Date(), alertThreshold ?? undefined);
  // Where today's ATM IV sits in its own recent range - the first thing both
  // a seller and a buyer want to know, and previously computed only for the
  // Strike Matrix's monthly IV-Rank rule and never surfaced anywhere else.
  const atmIvHistory = await getHotCacheValue(atmIvHistoryCache, snapshot.underlyingSymbol, ATM_IV_HISTORY_CACHE_MS, () =>
    getAtmCallIvHistory(snapshot.underlyingSymbol, IV_RANK_LOOKBACK_DAYS)
  );
  const atmCallIv = snapshot.ticks.find((tick) => tick.optionType === "CE" && tick.strikePrice === snapshot.atmStrike)?.impliedVolatility;
  const atmIvPercentile = calculateAtmIvPercentile(atmIvHistory, atmCallIv);
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
    // Was computed above (and already fed into calculateTradeRecommendations
    // below) but never actually sent - the client silently recomputed its
    // own Conviction/Setup Quality/Readiness with different math instead,
    // so the number on screen and the number gating the recommendations
    // underneath it disagreed (confirmed live: the client's "Conviction:
    // High" band fired ~91x more often than this server value's). Sending
    // it makes this the one and only source of truth for those three cards.
    marketBias,
    atmIvPercentile,
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

  // Only fetched for monthly - the only horizon whose risk rule consults
  // it - to avoid the extra history lookup on every intraday/weekly poll.
  const ivHistory = horizon === "monthly" ? await getAtmCallIvHistory(snapshot.underlyingSymbol, IV_RANK_LOOKBACK_DAYS) : undefined;

  return {
    underlying: snapshot.underlyingSymbol,
    expiry: snapshot.expiry,
    tradingDate: snapshot.tradingDate,
    snapshotTime: snapshot.snapshotTime,
    spotPrice: snapshot.spotPrice,
    atmStrike: snapshot.atmStrike,
    analysis: calculateStrikeMatrix(snapshot, horizon, new Date(), ivHistory)
  };
});

app.get<{
  Querystring: {
    underlying?: string;
    horizon?: string;
  };
}>("/api/market/elliott-wave", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedHorizon = request.query.horizon?.trim().toLowerCase();
  const horizon = isTradingHorizon(requestedHorizon) ? requestedHorizon : "intraday";

  return getHotCacheValue(elliottWaveCache, `${requestedUnderlying}:${horizon}`, ELLIOTT_WAVE_CACHE_MS[horizon], async () => {
    const zigZagPercent = WAVE_ZIGZAG_PRESETS[horizon];
    const lookbackMs = ELLIOTT_WAVE_LOOKBACK_MS[horizon];
    const sinceMs = Date.now() - lookbackMs;
    // getSpotPriceHistory's own default `limit` (1000) was silently clipping
    // every horizon to the same ~1-day tail regardless of how wide a window
    // it asked for - confirmed live on 2026-08-05: intraday, weekly and
    // monthly all returned the identical ~22-hour span for NIFTY. Sizing the
    // limit off the horizon's own lookback window (at the worker's capture
    // cadence, with a small margin) lets each horizon actually reach as far
    // back as its window and the retained data allow.
    const limit = Math.ceil((lookbackMs / config.SNAPSHOT_INTERVAL_MS) * 1.1);
    // Not expiry-scoped - spot price is a property of the underlying, so
    // the series is continuous across expiry rollovers (see
    // getSpotPriceHistory's doc comment).
    const points = await getSpotPriceHistory(requestedUnderlying, sinceMs, limit);
    const analysis = calculateElliottWave(requestedUnderlying, points, zigZagPercent);
    return {
      underlying: requestedUnderlying,
      horizon,
      zigZagPercent,
      pointCount: points.length,
      analysis
    };
  });
});

// Screener alert cache TTL: alerts are written by the worker's scan cycle
// (every 3 min - see apps/worker/src/wave-screener.ts), so polling this any
// faster would only ever re-serve the same DB read.
const WAVE_ALERTS_CACHE_MS = 60_000;
const waveAlertsCache = new Map<string, HotCacheEntry<ReturnType<typeof listRecentWaveAlerts> extends Promise<infer T> ? T : never>>();

app.get<{
  Querystring: {
    underlying?: string;
    limit?: string;
  };
}>("/api/market/elliott-wave/alerts", async (request) => {
  const underlying = request.query.underlying?.trim() || undefined;
  const parsedLimit = Number(request.query.limit ?? 50);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

  const alerts = await getHotCacheValue(waveAlertsCache, `${underlying ?? "*"}:${limit}`, WAVE_ALERTS_CACHE_MS, () => listRecentWaveAlerts(limit, underlying));
  return { alerts };
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
    marketBias,
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
registerLiveRoutes(app, getRequestUser, redisCache);

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

  const capacityMessage = await validatePaperOrderCapacity([parsed.data], user);
  if (capacityMessage) {
    return reply.status(400).send({ message: capacityMessage });
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

  const capacityMessage = await validatePaperOrderCapacity(parsed.data.legs, user);
  if (capacityMessage) {
    return reply.status(400).send({ message: capacityMessage });
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
      })),
      "api:paper-trading:margin"
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
  // Optional: when present the message goes out as multipart/alternative and
  // the client picks. The text part is never optional - it is what text-only
  // clients render and what filters score when HTML is stripped.
  html?: string;
}

async function sendTransactionalEmail(message: TransactionalEmail) {
  if (!config.SMTP_HOST) {
    throw new Error("SMTP_HOST is not configured");
  }

  await deliverSmtpEmail(message);
}

type TransactionalEmailFlow = "register" | "resend-verification" | "forgot-password" | "reset-password-unverified";

// Every caller of sendTransactionalEmail goes through here, because a
// delivery failure used to be either invisible or actively harmful.
// /forgot-password did not catch at all: the throw became a 500, which broke
// the flow AND confirmed to the caller that the address exists - the exact
// account enumeration its unconditional {ok:true} was written to prevent.
// Nothing reached the log either, so an entirely dead mail path showed up
// only as users reporting that links never arrived. It stayed dead for days:
// Microsoft disabled basic auth on the sender mailbox and every send had been
// failing "535 5.7.139 ... basic authentication is disabled" ever since.
//
// The SMTP reply text is the whole point of the log line - assertSmtpReply
// puts the server's own reason in the error message, and that is what names
// the cause. Callers decide what the user is told; they no longer decide
// whether the failure is recorded.
async function trySendTransactionalEmail(log: FastifyBaseLogger, flow: TransactionalEmailFlow, message: TransactionalEmail) {
  try {
    await sendTransactionalEmail(message);
    log.info({ flow, to: message.to }, "Transactional email delivered");
    return true;
  } catch (error) {
    log.error({ err: error, flow, to: message.to }, "Transactional email delivery failed");
    return false;
  }
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

// Both bodies are base64-encoded rather than sent as 8bit. Three reasons, all
// of which bite in practice: SMTP lines must stay under 998 octets and a
// single long HTML line would breach that; a body line beginning with "." has
// to be dot-stuffed or it terminates DATA early; and base64 sidesteps any
// charset mangling by an intermediate relay. The base64 alphabet contains
// neither "." nor long runs, so both problems disappear rather than needing
// to be handled.
function encodeEmailBody(value: string) {
  return (
    Buffer.from(value, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
}

function formatEmailMessage(message: TransactionalEmail) {
  const baseHeaders = [`From: ${config.EMAIL_FROM}`, `To: ${message.to}`, `Subject: ${sanitizeEmailHeader(message.subject)}`, "MIME-Version: 1.0"];

  if (!message.html) {
    const headers = [...baseHeaders, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
    return `${headers.join("\r\n")}\r\n\r\n${encodeEmailBody(message.text)}\r\n.`;
  }

  // Random boundary so it cannot collide with anything in the bodies.
  const boundary = `----=_OptionDecode_${randomBytes(16).toString("hex")}`;
  const headers = [...baseHeaders, `Content-Type: multipart/alternative; boundary="${boundary}"`];

  // Plain text first: multipart/alternative is ordered least-to-most
  // preferred, so the HTML part must come last to be the one clients choose.
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeEmailBody(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeEmailBody(message.html),
    `--${boundary}--`
  ];

  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n.`;
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
    return underlying ? await dhan.getExpiryList(underlying, "api:expiries-or-empty") : [];
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
    const liveExpiries = await dhan.getExpiryList(underlying, "api:tradable-expiries");
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

// Write-through: any time we're forced to hit Dhan live (either the stored
// snapshot for this underlying+expiry was stale, or - the slow path this
// fixes - nothing has ever been captured for this expiry at all, e.g. a
// Paper Trading order ticket expiry from the broker's full tradableExpiries
// list that the worker doesn't proactively poll), persist the result the
// same way the worker does every 30s. Without this, every single visit to
// an uncaptured expiry paid for a fresh live Dhan round trip with nothing
// ever cached - this is what made "switching to any available expiry" feel
// slow. Saved fire-and-forget (not awaited) so persistence never adds to
// this request's latency; a failure here just means the next visit repeats
// the same live fetch, so it's safe to only log and move on. The existing
// isSnapshotStale/isSegmentMarketSessionOpen check above already governs
// how fresh a persisted snapshot needs to be before it's served straight
// from storage again, so this doesn't loosen freshness for any expiry that
// wasn't already tolerating that same window.
function persistLiveSnapshotInBackground(snapshot: OptionChainSnapshot, underlyingSymbol: string, expiry: string) {
  saveOptionChainSnapshot(snapshot).catch((error) => {
    app.log.warn({ error, underlyingSymbol, expiry }, "Failed to persist live-fetched option chain snapshot");
  });
}

async function getLatestSnapshotOrDemo(underlyingSymbol: string, expiry?: string, spotPriceOverride?: number) {
  // A client-supplied expiry that's already in the past (e.g. a browser tab
  // left open for weeks, still polling with a long-expired date) can only
  // ever fail against the live Dhan option-chain endpoint ("Invalid Expiry
  // Date") - treat it the same as no expiry at all instead of wasting a
  // live API call chasing a dead contract every request. Observed in
  // production: one such stale expiry generated 500+ failed Dhan calls in
  // a single day (see api:live-fetch-uncaptured in DhanApiRequestLog).
  if (expiry && isExpiryInPast(expiry)) {
    app.log.warn({ underlyingSymbol, requestedExpiry: expiry }, "Ignoring client-supplied expiry that is already in the past");
    expiry = undefined;
  }

  try {
    const underlying = getUnderlyingDefinition(underlyingSymbol);
    const storedSnapshot = await getLatestOptionChainSnapshot(underlyingSymbol, expiry);
    if (storedSnapshot) {
      if (!underlying || !isSegmentMarketSessionOpen(underlying.segment) || !isSnapshotStale(storedSnapshot.snapshotTime)) {
        return storedSnapshot;
      }

      const liveExpiry = expiry ?? storedSnapshot.expiry;
      try {
        const liveSnapshot = await dhan.getOptionChain({ underlying, expiry: liveExpiry, spotPriceOverride, caller: "api:live-refresh-stale" });
        persistLiveSnapshotInBackground(liveSnapshot, underlyingSymbol, liveExpiry);
        return liveSnapshot;
      } catch (liveError) {
        app.log.warn({ error: liveError, underlyingSymbol, expiry: liveExpiry }, "Stored snapshot is stale; live option-chain refresh failed");
      }

      return storedSnapshot;
    }

    if (underlying) {
      const selectedExpiry = expiry ?? (await dhan.getExpiryList(underlying, "api:live-fetch-uncaptured:expiry-list"))[0];
      if (selectedExpiry) {
        const liveSnapshot = await dhan.getOptionChain({ underlying, expiry: selectedExpiry, spotPriceOverride, caller: "api:live-fetch-uncaptured" });
        persistLiveSnapshotInBackground(liveSnapshot, underlyingSymbol, selectedExpiry);
        return liveSnapshot;
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

// Drops entries whose TTL has already lapsed. These caches only ever
// overwrote a key or got cleared wholesale, so any cache whose keyspace
// grows over time - `replay:<snapshotId>` grows as snapshots are viewed,
// and the pressure cache is now keyed per capture - would otherwise retain
// every entry it ever held for the process's lifetime. Sweeping on write
// keeps them bounded by what's actually live within the TTL, which for a
// 10s window is a handful of entries. Cheap for that reason: the sweep is
// O(size) but the sweep is exactly what keeps size small.
function pruneExpiredHotCacheEntries<T>(cache: Map<string, HotCacheEntry<T>>, now: number) {
  for (const [entryKey, entry] of cache) {
    // Never evict an in-flight load: its promise is what de-duplicates
    // concurrent callers, and expiresAt on a pending entry is only a
    // provisional stamp set before the value exists.
    if (entry.promise === undefined && entry.expiresAt <= now) {
      cache.delete(entryKey);
    }
  }
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
  pruneExpiredHotCacheEntries(cache, now);

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

    const ltpQuotes = new Map<string, { lastPrice?: number }>();
    const ohlcQuotes = new Map<string, { lastPrice?: number; previousClose?: number }>();
    let restUnderlyings = quoteUnderlyings;

    // Prefer the worker's Dhan live feed tick cache (see live-tick-cache.ts)
    // over a REST round trip - only underlyings the feed doesn't have
    // fresh data for fall through to the REST path below, unchanged. When
    // the feed covers everything requested, this skips both REST calls
    // (and their mandatory 1.1s rate-limit gap) entirely.
    if (config.LIVE_MARKET_FEED_ENABLED) {
      const liveKeys = quoteUnderlyings
        .map((underlying) => {
          const segment = toLiveFeedSegment(underlying.quoteSegment ?? underlying.segment);
          return segment ? { segment, securityId: underlying.quoteSecurityId ?? underlying.securityId } : undefined;
        })
        .filter((entry): entry is { segment: DhanLiveFeedExchangeSegment; securityId: number } => Boolean(entry));
      const liveTicks = await getLiveTicks(redisCache, liveKeys);

      const stillNeeded: UnderlyingDefinition[] = [];
      for (const underlying of quoteUnderlyings) {
        const segment = toLiveFeedSegment(underlying.quoteSegment ?? underlying.segment);
        const securityId = underlying.quoteSecurityId ?? underlying.securityId;
        const tick = segment ? liveTicks.get(`${segment}:${securityId}`) : undefined;
        if (tick?.ltp !== undefined) {
          ltpQuotes.set(underlying.key, { lastPrice: tick.ltp });
          // Verified in production (2026-07-29) against NIFTY, SENSEX and an
          // NSE_EQ stock: Dhan's Quote packet dayClose field actually holds
          // the previous trading day's close throughout live trading,
          // despite the docs saying it's "only sent post market close".
          // The dedicated Prev Close packet (response code 6, tick.prevClose)
          // never arrived for any instrument in that test, so use dayClose
          // instead - tick.prevClose is kept as a fallback in case Dhan
          // starts sending it later.
          ohlcQuotes.set(underlying.key, { lastPrice: tick.ltp, previousClose: tick.dayClose ?? tick.prevClose });
        } else {
          stillNeeded.push(underlying);
        }
      }
      restUnderlyings = stillNeeded;
    }

    if (restUnderlyings.length) {
      // Dhan caps Market Quote calls at 1 request/sec ACROSS BOTH the LTP
      // and OHLC endpoints combined (not 1/sec each) - see
      // https://docs.dhanhq.co/api/v2/guides/rate-limits. Firing these two
      // calls concurrently via Promise.all therefore breached the limit on
      // every single refresh, regardless of how infrequently refreshes
      // themselves happened. Run them sequentially with a >1s gap instead.
      const ltpResult = await dhan
        .getLtpQuotes(restUnderlyings, "api:ticker:ltp")
        .then((value) => ({ status: "fulfilled" as const, value }))
        .catch((reason) => ({ status: "rejected" as const, reason }));
      await sleep(1100);
      const ohlcResult = await dhan
        .getOhlcQuotes(restUnderlyings, "api:ticker:ohlc")
        .then((value) => ({ status: "fulfilled" as const, value }))
        .catch((reason) => ({ status: "rejected" as const, reason }));
      if (ltpResult.status === "fulfilled") {
        for (const [key, value] of ltpResult.value) {
          ltpQuotes.set(key, value);
        }
      } else {
        app.log.warn({ error: ltpResult.reason }, "Unable to fetch market LTP from Dhan");
      }
      if (ohlcResult.status === "fulfilled") {
        for (const [key, value] of ohlcResult.value) {
          ohlcQuotes.set(key, value);
        }
      } else {
        app.log.warn({ error: ohlcResult.reason }, "Unable to fetch market OHLC from Dhan");
      }
      if (ltpResult.status === "rejected" && ohlcResult.status === "rejected" && !ltpQuotes.size && !ohlcQuotes.size) {
        throw ltpResult.reason;
      }
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

// Routes through the shared isMarketSessionOpen rather than a local copy of
// the session bounds. This used to hardcode 09:15-15:30 for NSE, which the
// move to NSE_SESSION_* in @option-decode/types missed - so from 15:30 to
// 15:41 IST the ticker served the STORED feed while the market was still
// live. That window is exactly the Closing Auction Session print (~15:29)
// and the F&O tail to 15:40, i.e. the settlement price and the last ten
// minutes of trading on it; see docs/nse-cas-impact.md.
function shouldUseStoredTickerFeed(definition: UnderlyingDefinition) {
  return !isSegmentMarketSessionOpen(definition.segment);
}

function firstPositiveNumber(...values: Array<number | undefined>) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
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

/**
 * Nothing warmed these caches before, so whoever arrived first after a
 * deploy paid the entire cold cost of the overview endpoint. Measured on
 * production 2026-08-05: 3.70s cold against 4ms warm, and roughly 2.8s of
 * that cold figure is getMarketAuxData - it downloads Dhan's 34MB scrip
 * master to resolve MCX contracts, then makes two rate-limited Dhan calls
 * separated by a mandatory 1.1s sleep (their LTP and OHLC endpoints share a
 * 1 request/sec budget). None of that gets faster by asking nicely; it just
 * shouldn't be a user's first impression of the app.
 *
 * getMarketAuxData already serves stale-while-revalidate once an entry
 * exists - it only blocks when the cache is completely empty. Populating it
 * here means that blocking path is taken by the server at startup rather
 * than by a person waiting on a dashboard.
 *
 * Deliberately not awaited: the server must accept connections immediately,
 * and a warm-up failure must never prevent it from serving. A failure here
 * is logged and simply leaves the old behaviour in place for one request.
 */
async function warmOverviewCaches() {
  const startedAt = Date.now();
  try {
    const underlying = normalizeUnderlying(undefined);
    const symbols = await getTickerSymbols(underlying);
    const [, snapshot] = await Promise.all([
      getMarketAuxData(symbols),
      getCachedLatestSnapshotOrDemo(underlying, undefined),
      getCachedExpiriesOrEmpty(underlying),
      getCachedTradableExpiriesOrEmpty(underlying)
    ]);
    // Cheap now that it is a single query, but it is on the same critical
    // path and cached for 30 minutes, so there is no reason to leave it cold.
    await getHotCacheValue(atmIvHistoryCache, snapshot.underlyingSymbol, ATM_IV_HISTORY_CACHE_MS, () =>
      getAtmCallIvHistory(snapshot.underlyingSymbol, IV_RANK_LOOKBACK_DAYS)
    );
    app.log.info({ underlying, ms: Date.now() - startedAt }, "Overview cache warm-up complete");
  } catch (error) {
    app.log.warn({ err: error, ms: Date.now() - startedAt }, "Overview cache warm-up failed; the first request will pay cold cost");
  }
}

void warmOverviewCaches();

// Memory sampling. Started after listen() so the first sample reflects a
// serving process rather than one still wiring itself up.
startApiMemorySampling();

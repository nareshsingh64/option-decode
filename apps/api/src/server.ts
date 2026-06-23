import cors from "@fastify/cors";
import Fastify from "fastify";
import net from "node:net";
import tls from "node:tls";
import { z } from "zod";
import { calculatePressureScore, generateMarketAlerts } from "@option-decode/analytics";
import { loadConfig } from "@option-decode/config";
import { buildDemoSnapshot, cancelPendingPaperOrder, closePaperPosition, createEmailVerificationToken, createPasswordResetToken, createUser, getAdminOverview, getAuthUserById, getDefaultWatchlist, getLatestOptionChainSnapshot, getLatestSpotChange, getOptionChainSnapshotById, getPaperSummary, getUserCredentialsByEmail, listReplaySnapshots, listStoredExpiries, markUserLogin, placePaperOrder, resetPasswordWithToken, updateAdminUserDisabled, updateAdminUserRole, updateDefaultWatchlist, updatePaperPositionRisk, updatePendingPaperOrder, verifyEmailToken } from "@option-decode/db";
import { DhanClient, getSupportedUnderlyingKeys, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { OptionChainSnapshot, UnderlyingDefinition } from "@option-decode/types";
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
const MARKET_SNAPSHOT_CACHE_MS = 10_000;
const MARKET_EXPIRIES_CACHE_MS = 10_000;
const WATCHLIST_SYMBOLS_CACHE_MS = 30_000;
const marketAuxCache = new Map<
  string,
  {
    expiresAt: number;
    value: {
      indiaVix?: number;
      ticker: MarketTickerItem[];
    };
  }
>();
const marketSnapshotCache = new Map<string, HotCacheEntry<OptionChainSnapshot>>();
const expiriesCache = new Map<string, HotCacheEntry<string[]>>();
const tickerSymbolsCache = new Map<string, HotCacheEntry<string[] | undefined>>();

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

app.get<{
  Querystring: {
    underlying?: string;
    expiry?: string;
  };
}>("/api/market/overview", async (request) => {
  const requestedUnderlying = normalizeUnderlying(request.query.underlying);
  const requestedExpiry = request.query.expiry?.trim() || undefined;
  const tickerSymbolsPromise = getTickerSymbols(requestedUnderlying);
  const [marketAux, snapshot, expiries] = await Promise.all([
    tickerSymbolsPromise.then((symbols) => getMarketAuxData(symbols)),
    getCachedLatestSnapshotOrDemo(requestedUnderlying, requestedExpiry),
    getCachedExpiriesOrEmpty(requestedUnderlying)
  ]);
  const pressure = calculatePressureScore(snapshot);
  const alerts = generateMarketAlerts(snapshot, pressure);

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

async function getCachedLatestSnapshotOrDemo(underlyingSymbol: string, expiry?: string) {
  const cacheKey = `${underlyingSymbol}:${expiry ?? ""}`;
  return getHotCacheValue(marketSnapshotCache, cacheKey, MARKET_SNAPSHOT_CACHE_MS, () => getLatestSnapshotOrDemo(underlyingSymbol, expiry));
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

async function getMarketAuxData(symbols?: string[]) {
  const requestedSymbols = normalizeTickerSymbols(symbols ?? tickerUnderlyings) ?? tickerUnderlyings;
  const cacheKey = requestedSymbols.slice().sort().join(",");
  const now = Date.now();
  const cached = marketAuxCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
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

async function getFreshMarketAuxData(symbols: string[]) {
  const definitions = symbols.map((symbol) => getUnderlyingDefinition(symbol)).filter((definition): definition is NonNullable<typeof definition> => Boolean(definition));

  try {
    const quoteDefinitions = await dhan.resolveQuoteUnderlyings(definitions);
    const quoteUnderlyings = [...quoteDefinitions, INDIA_VIX_UNDERLYING];
    const [ltpResult, ohlcResult] = await Promise.allSettled([dhan.getLtpQuotes(quoteUnderlyings), dhan.getOhlcQuotes(quoteUnderlyings)]);
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

const address = await app.listen({
  port: config.API_PORT,
  host: "0.0.0.0"
});

app.log.info(`Option Decode API listening at ${address}`);

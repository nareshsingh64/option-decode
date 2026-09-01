// Live Order module routes - REAL orders on a REAL brokerage account.
//
// Registered as a self-contained plugin, exactly as /api/sim/* is, so the
// existing paper modules stay untouched. Everything lives under /api/live/*.
//
// THE ISOLATION RULE, copied deliberately from /api/sim/*: no route here takes
// a user identifier. Every one resolves the caller from the session cookie.
// Under multi-trader this stops being a nicety and becomes the structural
// guarantee that no future role-checking bug can route one user's order into
// another user's brokerage account. Do not add a userId parameter to any of
// these, ever - a surface that cannot name another user cannot leak into one.
//
// There is deliberately no admin write surface. Oversight, if it is added,
// belongs in /api/admin/live/* behind requireAdminUser and must be READ ONLY:
// closing someone else's live position is a different feature with a different
// blast radius, and its absence is the guarantee.

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  LiveCredentialError,
  LiveOrderRejectedError,
  LiveTradingDisabledError,
  cancelLiveOrder,
  computeLiveMarginView,
  getBrokerCredentialStatus,
  beginBrokerConsent,
  completeBrokerConsent,
  getLiveSummary,
  listLiveChainStrikes,
  modifyLiveOrder,
  panicCloseLiveAccount,
  partnerLoginAvailable,
  placeLiveOrder,
  previewLiveOrder,
  reconcileLiveAccount,
  revokeBrokerCredential,
  saveBrokerCredential,
  setPositionStop,
  squareOffLivePosition
} from "@option-decode/db";
import type { AuthUserDto, LiveMarkResolver } from "@option-decode/db";
import type { DhanLiveFeedExchangeSegment } from "@option-decode/dhan";
import type Redis from "ioredis";
import { getLiveTicks } from "./live-tick-cache.js";

// securityId and price are OPTIONAL: the browser identifies a leg by strike and
// the server resolves the contract. Keeping Dhan security ids out of the client
// means a ticket can never be composed against a contract the server cannot
// name, which is the one thing that must not happen before a real order.
const legSchema = z.object({
  side: z.enum(["BUY", "SELL"]),
  optionType: z.enum(["CE", "PE"]),
  strikePrice: z.coerce.number().positive(),
  // Genuinely optional, NOT defaulted: zod validates default values, so a
  // default of "" against .min(1) rejects every ticket that omits the field -
  // which is every ticket the browser sends.
  securityId: z.string().trim().min(1).optional(),
  price: z.coerce.number().positive().optional()
});

const ticketSchema = z.object({
  underlyingSymbol: z.string().trim().min(1),
  expiryLabel: z.string().trim().min(1),
  structure: z.string().trim().min(1),
  lots: z.coerce.number().int().positive().max(100),
  legs: z.array(legSchema).min(1).max(4),
  signalRef: z.string().trim().max(191).optional(),
  orderType: z.enum(["LIMIT", "MARKET"]).optional()
});

const credentialSchema = z.object({
  brokerClientId: z.string().trim().min(1).max(64),
  // Never logged, never echoed back. See broker-credential-crypto.ts.
  accessToken: z.string().trim().min(20).max(4096)
});

const confirmSchema = z.object({
  confirmToken: z.string().trim().min(1).max(128)
});

const modifySchema = z.object({
  price: z.coerce.number().positive().optional(),
  triggerPrice: z.coerce.number().nonnegative().optional(),
  lots: z.coerce.number().int().positive().max(100).optional()
});

const squareOffSchema = z.object({
  // Absent means MARKET. Closing at a limit is an exit that might not happen,
  // which is the wrong default when someone has asked to be out.
  limitPrice: z.coerce.number().positive().optional()
});

const stopSchema = z.object({
  // null clears the stop. Distinguished from absent so "remove my stop" is an
  // explicit instruction rather than an empty body.
  stopPrice: z.coerce.number().positive().nullable()
});

const consentCallbackSchema = z.object({
  tokenId: z.string().trim().min(1).max(512),
  state: z.string().trim().min(1).max(128)
});

type GetRequestUser = (cookieHeader: string | undefined) => Promise<AuthUserDto | null>;

/**
 * Builds the live-mark lookup the summary uses to price open positions.
 *
 * Reads the worker's Redis tick cache, so a 1-second poll costs one MGET and no
 * broker call. Positions the feed has nothing fresh for simply keep Dhan's own
 * unrealised figure from the last reconcile - a cold cache degrades to the
 * slower number rather than to a blank.
 */
function buildMarkResolver(redis: Redis): LiveMarkResolver {
  return async (contracts) => {
  const keys = contracts
    .map((contract) => ({
      segment: contract.exchangeSegment as DhanLiveFeedExchangeSegment,
      securityId: Number(contract.securityId)
    }))
    .filter((key) => key.segment && Number.isFinite(key.securityId) && key.securityId > 0);
  if (!keys.length) return undefined;

  const ticks = await getLiveTicks(redis, keys);
  if (!ticks.size) return undefined;

  const bySecurityId = new Map<string, number>();
  for (const [key, tick] of ticks) {
    const ltp = tick.ltp;
    if (ltp !== undefined && Number.isFinite(ltp)) {
      bySecurityId.set(String(key.split(":")[1] ?? ""), ltp);
    }
  }
  return (securityId: string) => bySecurityId.get(securityId);
  };
}

/**
 * Map our error classes onto status codes.
 *
 *   403 - the switch is off, or this account is not cleared
 *   428 - the credential needs attention before anything can proceed
 *   400 - our own rules refused the trade; the user can act on it
 *
 * 428 rather than 401 for credentials: the SESSION is fine, it is the broker
 * credential that is missing or stale, and conflating the two would log the
 * user out of the app because their Dhan token expired.
 */
function sendError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof LiveTradingDisabledError) {
    return reply.status(403).send({ message: error.message });
  }
  if (error instanceof LiveCredentialError) {
    return reply.status(428).send({ message: error.message });
  }
  if (error instanceof LiveOrderRejectedError) {
    return reply.status(400).send({ message: error.message });
  }
  return undefined;
}

export function registerLiveRoutes(
  app: FastifyInstance,
  getRequestUser: GetRequestUser,
  redisCache: Redis
): void {
  // Wraps the auth check so no handler can forget it. Returns null when the
  // response has already been sent.
  const requireUser = async (cookieHeader: string | undefined, reply: FastifyReply): Promise<AuthUserDto | null> => {
    const user = await getRequestUser(cookieHeader);
    if (!user) {
      reply.status(401).send({ message: "Login is required." });
      return null;
    }
    return user;
  };

  // --- Credential ---------------------------------------------------------

  // Returns status only. The token itself is never returned, not even to its
  // owner and not even masked - there is no product reason to put a live
  // bearer credential back on the wire, and every reason a displayed one ends
  // up in a screenshot or a support ticket.
  app.get("/api/live/credential", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    try {
      return await getBrokerCredentialStatus(user);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  app.put("/api/live/credential", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = credentialSchema.safeParse(request.body);
    if (!parsed.success) {
      // Deliberately does NOT echo the issues - a zod issue on accessToken can
      // carry a fragment of the received value into the response body and the
      // logs. Say what is wrong in prose instead.
      return reply.status(400).send({ message: "A Dhan client id and an access token are both required." });
    }
    try {
      return await saveBrokerCredential(user, parsed.data);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  // --- Partner consent login ---------------------------------------------
  //
  // Lets a user connect through Dhan's own login page instead of pasting a JWT.
  // Two calls rather than one redirect chain: Dhan sends the browser back to the
  // WEB app, and the panel then posts the tokenId here. That keeps the exchange
  // on a normal same-origin authenticated request, instead of relying on a
  // session cookie surviving a cross-site redirect onto the API's origin.

  app.get("/api/live/credential/options", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    // Tells the panel which form to show. Deliberately not derived in the
    // browser: whether partner login works depends on server-side config the
    // client cannot see.
    return { partnerLogin: partnerLoginAvailable(), manualPaste: true };
  });

  app.post("/api/live/credential/consent", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    try {
      return await beginBrokerConsent(user);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  app.post("/api/live/credential/consume", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = consentCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      // No issues echoed: a zod issue on tokenId would put part of a one-time
      // credential exchange code into the response and the logs.
      return reply.status(400).send({ message: "A tokenId and state from the Dhan redirect are both required." });
    }
    try {
      return await completeBrokerConsent(user, parsed.data);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  app.delete("/api/live/credential", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    await revokeBrokerCredential(user);
    return { revoked: true };
  });

  // --- Read ---------------------------------------------------------------

  // Feeds the ticket's strike picker. Carries the liquidity verdict per strike
  // so the UI can grey out what the server would refuse anyway, rather than
  // letting the user compose a ticket that is going to be rejected.
  app.get<{ Querystring: { underlying?: string; expiry?: string } }>(
    "/api/live/chain",
    async (request, reply) => {
      const user = await requireUser(request.headers.cookie, reply);
      if (!user) return;
      const underlying = (request.query.underlying ?? "").trim();
      const expiry = (request.query.expiry ?? "").trim();
      if (!underlying || !expiry) {
        return reply.status(400).send({ message: "underlying and expiry are both required." });
      }
      const strikes = await listLiveChainStrikes(underlying, expiry);
      return { underlying, expiry, strikes };
    }
  );

  app.get("/api/live/summary", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    try {
      // One pass. The resolver is handed the open contracts mid-build, so
      // positions are read once and priced in place - a 1-second poll costs one
      // credential lookup, two findMany calls and one Redis MGET.
      return await getLiveSummary(user, undefined, buildMarkResolver(redisCache));
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  app.post("/api/live/margin", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid ticket", issues: parsed.error.issues.map((i) => i.message) });
    }
    try {
      return await computeLiveMarginView(user, parsed.data);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  // --- Two-phase placement ------------------------------------------------

  // Phase 1. Prices the basket, runs every cap, and returns a confirmToken
  // bound to (user, legs, prices, margin, clock). Nothing is sent to the broker.
  app.post("/api/live/preview", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid ticket", issues: parsed.error.issues.map((i) => i.message) });
    }
    try {
      return await previewLiveOrder(user, parsed.data);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  // Phase 2. Takes ONLY the confirmToken - the legs and prices come from the
  // preview the user actually saw, so what is placed cannot differ from what
  // was shown and approved. A token older than 10s is refused.
  app.post("/api/live/orders", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = confirmSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "A confirmToken from /api/live/preview is required." });
    }
    try {
      return await placeLiveOrder(user, parsed.data);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  app.patch<{ Params: { orderId: string } }>("/api/live/orders/:orderId", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = modifySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid modification", issues: parsed.error.issues.map((i) => i.message) });
    }
    try {
      return await modifyLiveOrder(user, request.params.orderId, parsed.data);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  app.delete<{ Params: { orderId: string } }>("/api/live/orders/:orderId", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    try {
      return await cancelLiveOrder(user, request.params.orderId);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  // --- Closing ------------------------------------------------------------

  app.post<{ Params: { positionId: string } }>("/api/live/positions/:positionId/exit", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = squareOffSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ message: "Invalid square-off request." });
    }
    try {
      return await squareOffLivePosition(user, request.params.positionId, parsed.data);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  app.put<{ Params: { positionId: string } }>("/api/live/positions/:positionId/stop", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    const parsed = stopSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ message: "stopPrice must be a positive number, or null to clear it." });
    }
    try {
      return await setPositionStop(user, request.params.positionId, parsed.data.stopPrice);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  // Cancel everything working, then flatten everything open. Available even
  // when the account has been switched off for new trades - being unable to
  // close is never the safe failure.
  app.post("/api/live/panic", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    try {
      return await panicCloseLiveAccount(user);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });

  // --- Reconciliation -----------------------------------------------------

  // Dhan is the source of truth in every disagreement; our rows are a cache of
  // it. Exposed on demand as well as running on a timer, because the first
  // thing anyone wants after an odd-looking screen is to re-ask the broker.
  app.post("/api/live/reconcile", async (request, reply) => {
    const user = await requireUser(request.headers.cookie, reply);
    if (!user) return;
    try {
      return await reconcileLiveAccount(user);
    } catch (error) {
      return sendError(reply, error) ?? Promise.reject(error);
    }
  });
}

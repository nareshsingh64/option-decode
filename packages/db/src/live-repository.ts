// Live Order module - REAL orders on a REAL brokerage account.
//
// The whole point of this file is that it is not Paper Trade Pro. Where the
// simulator's worst failure is a wrong number on a screen, every path here can
// lose money, and the code is shaped accordingly:
//
//   - Nothing places an order unless THREE independent switches are on:
//     LIVE_TRADING_ENABLED (env), LiveAccount.tradingEnabled (per account), and
//     a verified, unexpired broker credential.
//   - Caps are in RUPEES OF MARGIN, never lots. One lot is 20 contracts on
//     SENSEX and 2500 on COPPER; a lot-denominated limit is not a risk limit.
//   - Dhan's own `insufficientBalance` is consulted BEFORE our caps, because it
//     is computed against real funds including collateral we do not model.
//   - A placement that times out is UNKNOWN, never retried blindly. The
//     correlationId is persisted first so the order book can be probed for it.
//
// Design notes and the measurements behind the default caps:
// docs/live-order-module.md
//
// PER-USER CREDENTIALS. Market data still uses the app's own Dhan account
// (shared, nothing account-specific). Orders, positions, funds and MARGIN use
// the caller's own credential - margin especially, because once
// includePosition is on the answer depends on what THAT account already holds.

import { randomUUID } from "node:crypto";

import {
  DhanApiError,
  DhanClient,
  DhanPartnerClient,
  getFnoExchangeSegment,
  isPartnerLoginConfigured,
  type DhanBrokerOrder,
  type DhanFnoSegment,
  type DhanFundLimit,
  type DhanMarginLegInput
} from "@option-decode/dhan";
import { getFallbackLotSize, toBrokerQuantity, type OptionType } from "@option-decode/types";

import type { AuthUserDto } from "./auth-repository.js";
import {
  CURRENT_KEY_VERSION,
  decryptBrokerToken,
  encryptBrokerToken,
  readBrokerTokenClaims
} from "./broker-credential-crypto.js";
import { logDhanApiRequest } from "./dhan-audit-repository.js";
import { prisma } from "./index.js";
import type { PrismaClient } from "@prisma/client";

// ------------------------------------------------------------------
// Errors. Distinct classes so routes can map them to status codes without
// string-matching a message.
// ------------------------------------------------------------------

/** The trade was refused by our own rules. 400 - the user can act on it. */
export class LiveOrderRejectedError extends Error {}
/** Live trading is off, or this user is not cleared for it. 403. */
export class LiveTradingDisabledError extends Error {}
/** Credential missing, expired or unverified. 428 - the user must re-paste. */
export class LiveCredentialError extends Error {}

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

const DHAN_BASE_URL = process.env.DHAN_API_BASE_URL || "https://api.dhan.co";
/** Refuse to OPEN a position when the token has less life than this. Exits stay allowed. */
const MIN_TOKEN_HOURS_TO_OPEN = 2;
/** A preview goes stale fast - prices move and the margin was computed against them. */
const CONFIRM_TOKEN_TTL_MS = 10_000;
/** Undefined-risk structures. Blocked unless LiveAccount.allowUndefinedRisk. */
const UNDEFINED_RISK_STRUCTURES = new Set(["SHORT_STRADDLE", "SHORT_STRANGLE", "NAKED_CALL", "NAKED_PUT"]);

function liveTradingEnabledGlobally(): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env.LIVE_TRADING_ENABLED ?? "").toLowerCase());
}

// ------------------------------------------------------------------
// Per-user Dhan client
// ------------------------------------------------------------------

interface CachedClient {
  client: DhanClient;
  credentialUpdatedAt: number;
}

// DhanClient's constructor opens nothing, but rebuilding one per request would
// redo the JWT assert and re-wire the audit callback every time. Keyed by user,
// invalidated whenever the credential row changes.
const clientCache = new Map<string, CachedClient>();

export function invalidateLiveClient(userId: string): void {
  clientCache.delete(userId);
}

async function getUserDhanClient(userId: string, client: PrismaClient = prisma): Promise<DhanClient> {
  const credential = await client.userBrokerCredential.findFirst({
    where: { userId, broker: "DHAN", revokedAt: null }
  });
  if (!credential) {
    throw new LiveCredentialError("No broker credential on file. Add your Dhan access token before trading.");
  }

  const stamp = credential.updatedAt.getTime();
  const cached = clientCache.get(userId);
  if (cached && cached.credentialUpdatedAt === stamp) {
    return cached.client;
  }

  const token = decryptBrokerToken({
    cipher: Buffer.from(credential.tokenCipher),
    iv: Buffer.from(credential.tokenIv),
    tag: Buffer.from(credential.tokenTag),
    keyVersion: credential.keyVersion
  });

  const dhan = new DhanClient({
    baseUrl: DHAN_BASE_URL,
    clientId: credential.brokerClientId,
    accessToken: token,
    onRequest: (event) => {
      // Under multi-trader, "which account made this call" is the first
      // question any investigation asks - so the caller carries the user id.
      void logDhanApiRequest(event).catch(() => undefined);
    }
  });

  clientCache.set(userId, { client: dhan, credentialUpdatedAt: stamp });
  return dhan;
}

// ------------------------------------------------------------------
// Credentials
// ------------------------------------------------------------------

export interface BrokerCredentialStatus {
  present: boolean;
  brokerClientId?: string;
  tokenExpiresAt?: string;
  hoursRemaining?: number;
  verifiedOk: boolean;
  verifiedAt?: string;
  renewable: boolean;
  /** Whether a NEW position may be opened right now. Exits ignore this. */
  canOpen: boolean;
  reason?: string;
}

/**
 * Store a pasted token, after proving it actually works.
 *
 * Verification happens BEFORE persisting, deliberately. A stored credential
 * that has never authenticated is worse than none: it makes the UI claim the
 * account is ready and the failure surfaces at the worst possible moment.
 */
export async function saveBrokerCredential(
  user: AuthUserDto,
  input: { brokerClientId: string; accessToken: string },
  client: PrismaClient = prisma
): Promise<BrokerCredentialStatus> {
  const token = input.accessToken.trim();
  const brokerClientId = input.brokerClientId.trim();
  if (!token || !brokerClientId) {
    throw new LiveCredentialError("Both the Dhan client id and the access token are required.");
  }

  const claims = readBrokerTokenClaims(token);
  if (claims.dhanClientId && claims.dhanClientId !== brokerClientId) {
    throw new LiveCredentialError(
      `This token belongs to Dhan client ${claims.dhanClientId}, not ${brokerClientId}. Check which account it was minted from.`
    );
  }
  if (claims.expiresAt && claims.expiresAt.getTime() <= Date.now()) {
    throw new LiveCredentialError(
      "That token has already expired. An expired token cannot be renewed, only regenerated at web.dhan.co > My Profile > Access DhanHQ APIs."
    );
  }

  // Prove it is ALIVE, not merely unexpired. A JWT's `exp` cannot know it was
  // revoked server-side - on 2026-08-17 a token reported "10.98h remaining"
  // for hours after it had been killed. One read-only call closes that.
  const probe = new DhanClient({ baseUrl: DHAN_BASE_URL, clientId: brokerClientId, accessToken: token });
  try {
    await probe.getFundLimit("live:credential-verify");
  } catch (error) {
    throw new LiveCredentialError(
      `Dhan rejected that token: ${error instanceof Error ? error.message : String(error)}. It may be revoked, or minted for a different client id.`
    );
  }

  const encrypted = encryptBrokerToken(token);
  const data = {
    brokerClientId,
    tokenCipher: toPrismaBytes(encrypted.cipher),
    tokenIv: toPrismaBytes(encrypted.iv),
    tokenTag: toPrismaBytes(encrypted.tag),
    keyVersion: CURRENT_KEY_VERSION,
    tokenExpiresAt: claims.expiresAt ?? null,
    verifiedAt: new Date(),
    verifiedOk: true,
    renewable: claims.renewable,
    revokedAt: null
  };

  await client.userBrokerCredential.upsert({
    where: { userId_broker: { userId: user.id, broker: "DHAN" } },
    create: { userId: user.id, broker: "DHAN", ...data },
    update: data
  });
  invalidateLiveClient(user.id);

  // Give the user an account the moment they have a working credential, so the
  // caps exist and are enforced from the very first order.
  await client.liveAccount.upsert({
    where: { userId_brokerClientId: { userId: user.id, brokerClientId } },
    create: { userId: user.id, brokerClientId },
    update: {}
  });

  return getBrokerCredentialStatus(user, client);
}

// ------------------------------------------------------------------
// Partner consent login - connect through Dhan's own login page
// ------------------------------------------------------------------

function partnerOptions() {
  return {
    partnerId: process.env.DHAN_PARTNER_ID ?? "",
    partnerSecret: process.env.DHAN_PARTNER_SECRET ?? "",
    redirectUrl: process.env.DHAN_PARTNER_REDIRECT_URL ?? "",
    baseUrl: process.env.DHAN_PARTNER_BASE_URL || undefined
  };
}

export function partnerLoginAvailable(): boolean {
  return isPartnerLoginConfigured(partnerOptions());
}

// state -> which user started this consent, and when.
//
// This is the whole defence against a consent landing in the wrong account. The
// callback arrives carrying a tokenId in a query string, and without binding it
// to the user who STARTED the flow, someone could induce a logged-in user to
// complete a consent minted for a different Dhan account - handing our storage a
// credential the user never intended to connect. Both must agree: the state must
// exist, and it must belong to the session making the call.
//
// In-process and short-lived. An API restart mid-consent strands the flow, which
// costs one retry; persisting it would mean a table and a migration for state
// that is meaningless sixty seconds later.
interface PendingConsent {
  userId: string;
  createdAt: number;
}
const CONSENT_STATE_TTL_MS = 10 * 60 * 1000;
const pendingConsents = new Map<string, PendingConsent>();

function prunePendingConsents(): void {
  const cutoff = Date.now() - CONSENT_STATE_TTL_MS;
  for (const [state, pending] of pendingConsents) {
    if (pending.createdAt < cutoff) pendingConsents.delete(state);
  }
}

export interface BrokerConsentStart {
  loginUrl: string;
  state: string;
  expiresAt: string;
}

/**
 * Step 1+2. Mint a consent and hand back the URL the user logs in at.
 *
 * Called only when a user actively starts the flow: Dhan caps consents at 25 per
 * partner per day, so doing this on page load would let a few idle panels
 * exhaust the budget for everyone.
 */
export async function beginBrokerConsent(user: AuthUserDto): Promise<BrokerConsentStart> {
  const options = partnerOptions();
  if (!isPartnerLoginConfigured(options)) {
    throw new LiveCredentialError(
      "Partner login is not configured on this deployment. Set DHAN_PARTNER_ID, DHAN_PARTNER_SECRET and DHAN_PARTNER_REDIRECT_URL, or paste a token manually."
    );
  }
  prunePendingConsents();

  const partner = new DhanPartnerClient(options);
  const consent = await partner.generateConsent();
  const state = randomUUID();
  pendingConsents.set(state, { userId: user.id, createdAt: Date.now() });

  // state rides along on the redirect so the callback can prove which user
  // started this. Dhan echoes back whatever query the redirect URL carries.
  const separator = options.redirectUrl.includes("?") ? "&" : "?";
  const loginUrl = `${consent.loginUrl}&redirectUrl=${encodeURIComponent(`${options.redirectUrl}${separator}state=${state}`)}`;

  return {
    loginUrl,
    state,
    expiresAt: new Date(Date.now() + CONSENT_STATE_TTL_MS).toISOString()
  };
}

/**
 * Step 3. Exchange the redirect's tokenId for a stored credential.
 *
 * Verified against /v2/fundlimit before it is persisted, exactly as the manual
 * paste path is: a stored credential that has never authenticated is worse than
 * none, because the panel then claims the account is ready.
 */
export async function completeBrokerConsent(
  user: AuthUserDto,
  input: { tokenId: string; state: string },
  client: PrismaClient = prisma
): Promise<BrokerCredentialStatus> {
  const options = partnerOptions();
  if (!isPartnerLoginConfigured(options)) {
    throw new LiveCredentialError("Partner login is not configured on this deployment.");
  }
  prunePendingConsents();

  const pending = pendingConsents.get(input.state);
  if (!pending) {
    throw new LiveCredentialError("That login attempt has expired or was already used. Start again.");
  }
  if (pending.userId !== user.id) {
    // Someone is completing a consent started by a different session. Drop the
    // state so a second attempt cannot grind against it.
    pendingConsents.delete(input.state);
    throw new LiveCredentialError("That login attempt belongs to a different account.");
  }
  // Single use, whatever happens next.
  pendingConsents.delete(input.state);

  const partner = new DhanPartnerClient(options);
  const consumed = await partner.consumeConsent(input.tokenId);

  // From here it is the same path as a pasted token: verify it is alive,
  // encrypt, store. saveBrokerCredential does all three and is the only place
  // that writes a credential.
  return saveBrokerCredential(user, {
    brokerClientId: consumed.dhanClientId,
    accessToken: consumed.accessToken
  }, client);
}

export async function getBrokerCredentialStatus(
  user: AuthUserDto,
  client: PrismaClient = prisma
): Promise<BrokerCredentialStatus> {
  const credential = await client.userBrokerCredential.findFirst({
    where: { userId: user.id, broker: "DHAN", revokedAt: null }
  });
  if (!credential) {
    return { present: false, verifiedOk: false, renewable: false, canOpen: false, reason: "No broker credential on file." };
  }

  const hoursRemaining = credential.tokenExpiresAt
    ? (credential.tokenExpiresAt.getTime() - Date.now()) / 3_600_000
    : undefined;

  let canOpen = true;
  let reason: string | undefined;
  if (!credential.verifiedOk) {
    canOpen = false;
    reason = "The stored token has never authenticated. Re-paste it.";
  } else if (hoursRemaining !== undefined && hoursRemaining <= 0) {
    canOpen = false;
    reason = "The token has expired. Regenerate it at web.dhan.co - an expired token cannot be renewed.";
  } else if (hoursRemaining !== undefined && hoursRemaining < MIN_TOKEN_HOURS_TO_OPEN) {
    // Opening a position you may not be able to close is the failure mode this
    // prevents. Exits remain allowed throughout.
    canOpen = false;
    reason = `Only ${hoursRemaining.toFixed(1)}h of token life remains. New positions are blocked below ${MIN_TOKEN_HOURS_TO_OPEN}h; exits are still allowed.`;
  }

  return {
    present: true,
    brokerClientId: credential.brokerClientId,
    tokenExpiresAt: credential.tokenExpiresAt?.toISOString(),
    hoursRemaining: hoursRemaining === undefined ? undefined : Number(hoursRemaining.toFixed(2)),
    verifiedOk: credential.verifiedOk,
    verifiedAt: credential.verifiedAt?.toISOString(),
    renewable: credential.renewable,
    canOpen,
    reason
  };
}

export async function revokeBrokerCredential(user: AuthUserDto, client: PrismaClient = prisma): Promise<void> {
  await client.userBrokerCredential.updateMany({
    where: { userId: user.id, broker: "DHAN", revokedAt: null },
    data: { revokedAt: new Date(), verifiedOk: false }
  });
  invalidateLiveClient(user.id);
}

// ------------------------------------------------------------------
// Account + gates
// ------------------------------------------------------------------

async function requireTradableAccount(user: AuthUserDto, client: PrismaClient, forExit = false) {
  if (!liveTradingEnabledGlobally()) {
    throw new LiveTradingDisabledError("Live trading is disabled on this deployment (LIVE_TRADING_ENABLED).");
  }
  const account = await client.liveAccount.findFirst({ where: { userId: user.id, isActive: true } });
  if (!account) {
    throw new LiveTradingDisabledError("No live account. Add a broker credential first.");
  }
  if (!account.tradingEnabled) {
    throw new LiveTradingDisabledError("Live trading is not enabled on this account.");
  }
  const status = await getBrokerCredentialStatus(user, client);
  // An exit is always permitted while the credential still authenticates -
  // refusing to let someone close a position is far worse than letting them.
  if (!status.present || !status.verifiedOk) {
    throw new LiveCredentialError(status.reason ?? "Broker credential unavailable.");
  }
  if (!forExit && !status.canOpen) {
    throw new LiveCredentialError(status.reason ?? "New positions are blocked.");
  }
  return account;
}

// ------------------------------------------------------------------
// Margin view
// ------------------------------------------------------------------

export interface LiveMarginLegView {
  securityId: string;
  optionType: OptionType;
  strikePrice: number;
  transactionType: "BUY" | "SELL";
  quantity: number;
  exchangeSegment: string;
  standaloneMargin: number;
  role: "RISK" | "HEDGE";
}

export interface LiveMarginView {
  asOf: string;
  source: "DHAN";
  productType: "MARGIN";
  funds: DhanFundLimit;
  requirement: {
    total: number;
    // MEASURED 2026-08-30: Dhan returns 0.00 for every breakdown field on both
    // the single and multi endpoints - only the total is real. Null rather than
    // zero so the UI can omit them; a rendered breakdown of zeros reads as
    // "no margin required", which is the opposite of the truth.
    span: number | null;
    exposure: number | null;
    fo: number | null;
    commodity: number | null;
    currency: string;
  };
  hedge: {
    grossMargin: number;
    netMargin: number;
    benefitAmount: number;
    benefitPct: number;
    legs: LiveMarginLegView[];
  };
  headroom: {
    free: number;
    utilizationPct: number;
    /** Dhan's own shortfall. Non-zero means the broker will refuse. */
    insufficientBalance: number;
    wouldBreach: boolean;
  };
}

export interface LiveLegInput {
  side: "BUY" | "SELL";
  optionType: OptionType;
  strikePrice: number;
  // Both optional from the client. The browser has no business knowing Dhan
  // security ids, so resolveTicketLegs fills these in server-side from the
  // captured chain and refuses the ticket if it cannot.
  securityId?: string;
  price?: number;
}

/** A leg after resolveTicketLegs: contract named, price known. */
interface ResolvedLeg extends LiveLegInput {
  securityId: string;
  price: number;
}

// Omit-then-replace, NOT an intersection: `LiveTicketInput & { legs: ResolvedLeg[] }`
// intersects the two legs arrays rather than overriding, so element access still
// widens securityId back to string | undefined.
type ResolvedTicket = Omit<LiveTicketInput, "legs"> & { legs: ResolvedLeg[] };

// ------------------------------------------------------------------
// Leg resolution + the strike picker's data source
// ------------------------------------------------------------------

/** One tradeable strike, with everything the ticket and the liquidity gate need. */
export interface LiveChainStrike {
  optionType: OptionType;
  strikePrice: number;
  securityId: string;
  lastPrice: number;
  bidPrice: number | null;
  askPrice: number | null;
  openInterest: number | null;
  volume: number | null;
  delta: number | null;
  /** False when this strike fails the liquidity gate - see MIN_LIVE_OPEN_INTEREST. */
  tradeable: boolean;
  reason?: string;
}

// Same gate Paper Trade Pro applies. A strike the app NAMES as tradeable has to
// clear the same bar everywhere, or there are two standards and the stricter one
// is decorative.
const MIN_LIVE_OPEN_INTEREST = 500;
const MAX_LIVE_SPREAD_RATIO = 0.15;

/**
 * The strikes that can actually be traded for this underlying/expiry.
 *
 * Reads the most recent tick per contract. Deliberately server-side: the browser
 * has no business knowing Dhan security ids, and resolving them in one place is
 * what stops a ticket being composed against a contract we cannot name.
 */
export async function listLiveChainStrikes(
  underlyingSymbol: string,
  expiryLabel: string,
  client: PrismaClient = prisma
): Promise<LiveChainStrike[]> {
  const rows = await client.$queryRaw<Array<{
    optionType: string; strikePrice: unknown; securityId: string | null;
    lastPrice: unknown; bidPrice: unknown; askPrice: unknown;
    openInterest: unknown; volume: unknown; deltaValue: unknown;
  }>>`
    SELECT t.optionType, t.strikePrice, t.securityId, t.lastPrice, t.bidPrice, t.askPrice,
           t.openInterest, t.volume, t.deltaValue
    FROM OptionContractTick t
    JOIN (
      SELECT optionType, strikePrice, MAX(tickTime) AS latest
      FROM OptionContractTick
      WHERE underlyingSymbol = ${underlyingSymbol} AND expiryLabel = ${expiryLabel}
      GROUP BY optionType, strikePrice
    ) newest
      ON newest.optionType = t.optionType
     AND newest.strikePrice = t.strikePrice
     AND newest.latest = t.tickTime
    WHERE t.underlyingSymbol = ${underlyingSymbol} AND t.expiryLabel = ${expiryLabel}
    ORDER BY t.strikePrice ASC`;

  const num = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === "object" && value !== null && "toNumber" in value
      ? (value as { toNumber(): number }).toNumber()
      : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return rows.map((row) => {
    const lastPrice = num(row.lastPrice) ?? 0;
    const bid = num(row.bidPrice);
    const ask = num(row.askPrice);
    const oi = num(row.openInterest);
    const volume = num(row.volume);
    const spreadRatio = bid && ask && ask > 0 ? (ask - bid) / ask : null;

    let tradeable = true;
    let reason: string | undefined;
    if (!row.securityId) {
      tradeable = false;
      reason = "no Dhan security id - cannot be ordered";
    } else if (lastPrice <= 0) {
      tradeable = false;
      reason = "no traded price";
    } else if (oi !== null && oi < MIN_LIVE_OPEN_INTEREST) {
      tradeable = false;
      reason = `open interest ${Math.round(oi)} is below ${MIN_LIVE_OPEN_INTEREST}`;
    } else if (volume !== null && volume <= 0) {
      // Open interest alone is not liquidity. A deep-ITM strike can carry large
      // OI from positions opened weeks ago and trade nothing today, and a real
      // order into it gets a terrible fill. Caught by looking at live output:
      // NIFTY 22000 CE passed this gate on OI 4,875 with volume 0.
      //
      // This also keeps the module to the SAME standard as the rest of the app -
      // MIN_RECOMMENDATION_OPEN_INTEREST plus volume > 0. Anything the app names
      // as tradeable clears one bar, not two different ones.
      tradeable = false;
      reason = "no volume traded today";
    } else if (spreadRatio !== null && spreadRatio > MAX_LIVE_SPREAD_RATIO) {
      tradeable = false;
      reason = `bid/ask spread ${(spreadRatio * 100).toFixed(0)}% is wider than ${MAX_LIVE_SPREAD_RATIO * 100}%`;
    }

    return {
      optionType: row.optionType as OptionType,
      strikePrice: num(row.strikePrice) ?? 0,
      securityId: row.securityId ?? "",
      lastPrice,
      bidPrice: bid,
      askPrice: ask,
      openInterest: oi,
      volume,
      delta: num(row.deltaValue),
      tradeable,
      reason
    };
  });
}

/**
 * Fill in securityId and price for legs the caller specified only by strike.
 *
 * Refuses rather than guessing. A leg whose contract cannot be named, or which
 * fails the liquidity gate, stops the whole ticket - the alternative is placing
 * a real order against a contract we could not price.
 */
async function resolveTicketLegs(
  ticket: LiveTicketInput,
  client: PrismaClient
): Promise<ResolvedTicket> {
  if (ticket.legs.every((leg) => leg.securityId && (leg.price ?? 0) > 0)) {
    return ticket as ResolvedTicket;
  }
  const chain = await listLiveChainStrikes(ticket.underlyingSymbol, ticket.expiryLabel, client);
  const byKey = new Map(chain.map((row) => [`${row.optionType}|${row.strikePrice}`, row]));

  const legs: ResolvedLeg[] = ticket.legs.map((leg) => {
    if (leg.securityId && (leg.price ?? 0) > 0) return leg as ResolvedLeg;
    const match = byKey.get(`${leg.optionType}|${leg.strikePrice}`);
    if (!match) {
      throw new LiveOrderRejectedError(
        `No ${ticket.underlyingSymbol} ${ticket.expiryLabel} ${leg.optionType} ${leg.strikePrice} in the captured chain - it cannot be priced or ordered.`
      );
    }
    if (!match.tradeable) {
      throw new LiveOrderRejectedError(
        `${leg.optionType} ${leg.strikePrice} is not tradeable: ${match.reason}.`
      );
    }
    return { ...leg, securityId: match.securityId, price: match.lastPrice };
  });

  return { ...ticket, legs };
}

export interface LiveTicketInput {
  underlyingSymbol: string;
  expiryLabel: string;
  structure: string;
  lots: number;
  legs: LiveLegInput[];
  signalRef?: string;
}

/**
 * Price a basket's margin.
 *
 * The hedge benefit is derived NUMERICALLY from per-leg `single` calls rather
 * than read off the basket response, for two measured reasons:
 *
 *   1. Dhan returns hedge_benefit as a STRING, and not on every response.
 *   2. The `multi` endpoint returned all zeros for a valid two-leg basket on
 *      2026-08-30 while the same legs priced correctly as singles. Until a
 *      corrected multi call is verified end to end, singles are the only
 *      numbers known to be real.
 *
 * Cost is N+1 Dhan calls per basket. The calculator is a static SPAN/exposure
 * lookup rather than a live quote, so these cache well - see the note in
 * docs/live-order-module.md on caching this per user.
 */
export async function computeLiveMarginView(
  user: AuthUserDto,
  ticket: LiveTicketInput,
  client: PrismaClient = prisma
): Promise<LiveMarginView> {
  const resolved = await resolveTicketLegs(ticket, client);
  const dhan = await getUserDhanClient(user.id, client);
  const account = await client.liveAccount.findFirst({ where: { userId: user.id, isActive: true } });
  const segment = getFnoExchangeSegment(resolved.underlyingSymbol);
  const quantity = toBrokerQuantity(resolved.underlyingSymbol, resolved.lots);

  const marginLegs: DhanMarginLegInput[] = resolved.legs.map((leg) => ({
    transactionType: leg.side,
    quantity,
    securityId: leg.securityId,
    price: leg.price,
    exchangeSegment: segment,
    // Explicit, never defaulted. INTRADAY would be auto-squared at the cutoff.
    productType: "MARGIN"
  }));

  const funds = await dhan.getFundLimit("live:margin:funds");

  // Per-leg standalone margins. Sequential rather than Promise.all: the pool is
  // 10 and a fan-out here would contend with every other request in the process
  // (the getAtmCallIvHistory lesson), and these are external calls anyway.
  const legViews: LiveMarginLegView[] = [];
  let grossMargin = 0;
  for (let index = 0; index < resolved.legs.length; index += 1) {
    const leg = resolved.legs[index];
    const single = await dhan.calculateMultiOrderMargin([marginLegs[index]], "live:margin:leg");
    grossMargin += single.totalMargin;
    legViews.push({
      securityId: leg.securityId,
      optionType: leg.optionType,
      strikePrice: leg.strikePrice,
      transactionType: leg.side,
      quantity,
      exchangeSegment: segment,
      standaloneMargin: single.totalMargin,
      // A bought leg costs premium only (measured: Rs 4,500 for 150 x 30,
      // leverage 1x), so it is the hedge by construction.
      role: leg.side === "BUY" ? "HEDGE" : "RISK"
    });
  }

  const basket = await dhan.calculateMultiOrderMargin(marginLegs, "live:margin:basket");
  // Trust the basket total only when it is plausible. Zero (the measured
  // failure mode) or a benefit larger than gross means the endpoint is not
  // answering properly, and the safe reading is "no benefit" rather than a
  // number that would let someone over-leverage.
  const basketUsable = basket.totalMargin > 0 && basket.totalMargin <= grossMargin;
  const netMargin = basketUsable ? basket.totalMargin : grossMargin;
  const benefitAmount = Math.max(0, grossMargin - netMargin);

  const free = funds.availableBalance - netMargin;
  const utilizationPct = funds.availableBalance > 0 ? (netMargin / funds.availableBalance) * 100 : 100;
  // >= 100 disables the ceiling: the trader is choosing to use the whole
  // balance. Below 100 it reserves headroom for the exchange's intraday
  // revaluations, which happen six times a day.
  const maxUtil = account ? Number(account.maxMarginUtilPct) : 50;

  return {
    asOf: new Date().toISOString(),
    source: "DHAN",
    productType: "MARGIN",
    funds,
    requirement: {
      total: netMargin,
      span: basket.spanMargin > 0 ? basket.spanMargin : null,
      exposure: basket.exposureMargin > 0 ? basket.exposureMargin : null,
      fo: basket.foMargin > 0 ? basket.foMargin : null,
      commodity: basket.commodityMargin > 0 ? basket.commodityMargin : null,
      currency: basket.currency
    },
    hedge: {
      grossMargin,
      netMargin,
      benefitAmount,
      benefitPct: grossMargin > 0 ? (benefitAmount / grossMargin) * 100 : 0,
      legs: legViews
    },
    headroom: {
      free,
      utilizationPct,
      insufficientBalance: Math.max(0, netMargin - funds.availableBalance),
      wouldBreach: (maxUtil < 100 && utilizationPct > maxUtil) || free < 0
    }
  };
}

// ------------------------------------------------------------------
// Two-phase placement: preview -> confirm
// ------------------------------------------------------------------

export interface LivePreview {
  confirmToken: string;
  expiresAt: string;
  ticket: LiveTicketInput;
  quantity: number;
  exchangeSegment: DhanFnoSegment;
  lotSize: number;
  notional: number;
  margin: LiveMarginView;
  warnings: string[];
}

interface PendingPreview {
  userId: string;
  // The RESOLVED ticket, so placement uses the exact contracts and prices that
  // were priced and shown - never a re-resolution that could pick up a moved
  // price between preview and confirm.
  ticket: ResolvedTicket;
  marginTotal: number;
  createdAt: number;
}

// In-process and short-lived by design: a preview older than 10s is worthless
// because the prices it was computed against have moved.
const previews = new Map<string, PendingPreview>();

function prunePreviews(): void {
  const cutoff = Date.now() - CONFIRM_TOKEN_TTL_MS * 3;
  for (const [token, preview] of previews) {
    if (preview.createdAt < cutoff) previews.delete(token);
  }
}

export async function previewLiveOrder(
  user: AuthUserDto,
  ticket: LiveTicketInput,
  client: PrismaClient = prisma
): Promise<LivePreview> {
  const account = await requireTradableAccount(user, client);
  prunePreviews();

  if (!ticket.legs.length) {
    throw new LiveOrderRejectedError("A ticket needs at least one leg.");
  }
  // Resolve securityId/price BEFORE any cap is evaluated, so a ticket that
  // cannot be named is refused for that reason rather than for a margin figure
  // computed against a contract we could not identify.
  const resolvedTicket = await resolveTicketLegs(ticket, client);
  if (UNDEFINED_RISK_STRUCTURES.has(resolvedTicket.structure) && !account.allowUndefinedRisk) {
    throw new LiveOrderRejectedError(
      `${resolvedTicket.structure} is an undefined-risk structure and is not enabled on this account. A one-lot naked index short requires more margin than the account holds.`
    );
  }

  const lotSize = getFallbackLotSize(resolvedTicket.underlyingSymbol);
  const quantity = toBrokerQuantity(resolvedTicket.underlyingSymbol, resolvedTicket.lots);
  const segment = getFnoExchangeSegment(resolvedTicket.underlyingSymbol);
  const margin = await computeLiveMarginView(user, ticket, client);

  const warnings: string[] = [];
  const notional = resolvedTicket.legs.reduce((sum, leg) => sum + leg.strikePrice * lotSize * resolvedTicket.lots, 0);

  // Dhan's own shortfall first - it accounts for collateral and blocked
  // payouts that we do not model, so it is a better gate than anything local.
  if (margin.headroom.insufficientBalance > 0) {
    throw new LiveOrderRejectedError(
      `Insufficient funds: this basket needs Rs ${Math.round(margin.requirement.total).toLocaleString("en-IN")} against Rs ${Math.round(margin.funds.availableBalance).toLocaleString("en-IN")} available (short by Rs ${Math.round(margin.headroom.insufficientBalance).toLocaleString("en-IN")}).`
    );
  }
  // A cap of 0 means "no local cap - the broker's own view of available funds
  // is the limit". That is a deliberate setting, not a missing one: the
  // insufficientBalance check above already refused anything the account cannot
  // fund, and it is computed by Dhan against real funds including collateral
  // and blocked payouts that we do not model. A second, smaller number layered
  // on top of that is a policy choice, and an account holder is entitled to
  // decline it.
  const orderCap = Number(account.maxOrderMargin);
  if (orderCap > 0 && margin.requirement.total > orderCap) {
    throw new LiveOrderRejectedError(
      `Margin Rs ${Math.round(margin.requirement.total).toLocaleString("en-IN")} exceeds this account's per-order cap of Rs ${orderCap.toLocaleString("en-IN")}.`
    );
  }
  if (margin.headroom.wouldBreach) {
    throw new LiveOrderRejectedError(
      `This would take margin utilisation to ${margin.headroom.utilizationPct.toFixed(0)}%, past the ${Number(account.maxMarginUtilPct)}% ceiling. The exchange revalues margin six times a day; there has to be room for that.`
    );
  }

  const ceilings = (account.lotCeilings ?? {}) as Record<string, number>;
  const ceiling = ceilings[resolvedTicket.underlyingSymbol.toUpperCase()];
  if (ceiling !== undefined && resolvedTicket.lots > ceiling) {
    throw new LiveOrderRejectedError(`This account is limited to ${ceiling} lot(s) of ${resolvedTicket.underlyingSymbol}.`);
  }

  if (segment === "MCX_COMM") {
    warnings.push(
      "MCX options devolve into a FUTURES position at expiry, not cash settlement. Close before expiry day."
    );
  }

  const confirmToken = randomUUID();
  previews.set(confirmToken, {
    userId: user.id,
    ticket: resolvedTicket,
    marginTotal: margin.requirement.total,
    createdAt: Date.now()
  });

  return {
    confirmToken,
    expiresAt: new Date(Date.now() + CONFIRM_TOKEN_TTL_MS).toISOString(),
    ticket: resolvedTicket,
    quantity,
    exchangeSegment: segment,
    lotSize,
    notional,
    margin,
    warnings
  };
}

// ------------------------------------------------------------------
// Placement
// ------------------------------------------------------------------

export interface LivePlacementResult {
  groupId: string;
  orders: Array<{ id: string; correlationId: string; brokerOrderId?: string; status: string; message?: string }>;
}

export async function placeLiveOrder(
  user: AuthUserDto,
  input: { confirmToken: string },
  client: PrismaClient = prisma
): Promise<LivePlacementResult> {
  const account = await requireTradableAccount(user, client);

  const preview = previews.get(input.confirmToken);
  if (!preview) {
    throw new LiveOrderRejectedError("That preview has expired. Re-price the ticket and confirm again.");
  }
  // Bound to the user as well as the clock: a token is not a bearer capability
  // someone else can spend.
  if (preview.userId !== user.id) {
    throw new LiveOrderRejectedError("That preview does not belong to this account.");
  }
  if (Date.now() - preview.createdAt > CONFIRM_TOKEN_TTL_MS) {
    previews.delete(input.confirmToken);
    throw new LiveOrderRejectedError("That preview is more than 10 seconds old. Prices have moved - re-price and confirm again.");
  }
  previews.delete(input.confirmToken);

  await enforceOrderRate(account.id, Number(account.maxOrdersPerMinute), client);

  const ticket = preview.ticket;
  const segment = getFnoExchangeSegment(ticket.underlyingSymbol);
  const lotSize = getFallbackLotSize(ticket.underlyingSymbol);
  const quantity = toBrokerQuantity(ticket.underlyingSymbol, ticket.lots);
  const dhan = await getUserDhanClient(user.id, client);
  const groupId = randomUUID();

  const results: LivePlacementResult["orders"] = [];

  for (const leg of ticket.legs) {
    // Persist BEFORE sending. The correlationId must exist locally first or a
    // timeout leaves an order we cannot even look for.
    const correlationId = randomUUID().replace(/-/g, "").slice(0, 24);
    const row = await client.liveOrder.create({
      data: {
        accountId: account.id,
        groupId,
        legRole: leg.side === "SELL" ? "MAIN" : "HEDGE",
        correlationId,
        underlyingSymbol: ticket.underlyingSymbol,
        expiryLabel: ticket.expiryLabel,
        optionType: leg.optionType,
        strikePrice: leg.strikePrice,
        securityId: leg.securityId,
        exchangeSegment: segment,
        transactionType: leg.side,
        productType: "MARGIN",
        orderType: "LIMIT",
        lots: ticket.lots,
        lotSize,
        quantity,
        notional: leg.strikePrice * lotSize * ticket.lots,
        price: leg.price,
        status: "LOCAL_PENDING",
        quotedAt: new Date(preview.createdAt),
        quotedPrice: leg.price,
        quotedMargin: preview.marginTotal,
        signalRef: ticket.signalRef ?? null
      }
    });

    await recordOrderEvent(row.id, "LOCAL", "LOCAL_PENDING", { correlationId }, client);

    try {
      await client.liveOrder.update({ where: { id: row.id }, data: { status: "SENT" } });
      const placed = await dhan.placeOrder(
        {
          correlationId,
          transactionType: leg.side,
          exchangeSegment: segment,
          productType: "MARGIN",
          orderType: "LIMIT",
          securityId: leg.securityId,
          quantity,
          price: leg.price,
          validity: "DAY"
        },
        "live:order:place"
      );

      await client.liveOrder.update({
        where: { id: row.id },
        data: {
          brokerOrderId: placed.orderId || null,
          status: mapBrokerStatus(placed.orderStatus),
          brokerStatusRaw: placed.orderStatus ?? null
        }
      });
      await recordOrderEvent(row.id, "API_RESPONSE", placed.orderStatus ?? "PLACED", placed as unknown as Record<string, unknown>, client);
      results.push({ id: row.id, correlationId, brokerOrderId: placed.orderId, status: mapBrokerStatus(placed.orderStatus) });
    } catch (error) {
      // Establish what the failure MEANS before reacting to it - the same
      // discipline the RenewToken 5xx handling uses, and the reason these two
      // branches must not be collapsed.
      //
      // A 4xx is NEWS: Dhan looked at the request and refused it, so no order
      // was created and there is nothing to find. Recording that as UNKNOWN is
      // wrong twice over - it tells the trader we lost track of a live order
      // when we did not, and it spends two order-book probes hunting for
      // something that cannot exist. That is exactly what happened on the first
      // real placement here, a DH-905 "Invalid IP" shown to the user as UNKNOWN.
      //
      // A 5xx, a timeout or a transport error is AMBIGUITY: the request may
      // have been processed and the reply lost. Only then is the order book
      // probed for our own correlationId, because only then might it be there.
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof DhanApiError ? error.statusCode : undefined;
      const definitivelyRejected = status !== undefined && status >= 400 && status < 500;

      if (definitivelyRejected) {
        await client.liveOrder.update({
          where: { id: row.id },
          data: { status: "REJECTED", rejectionReason: message.slice(0, 255) }
        });
        await recordOrderEvent(row.id, "API_RESPONSE", "REJECTED", { error: message, statusCode: status }, client);
        results.push({ id: row.id, correlationId, status: "REJECTED", message });
      } else {
        await client.liveOrder.update({
          where: { id: row.id },
          data: { status: "UNKNOWN", rejectionReason: message.slice(0, 255) }
        });
        await recordOrderEvent(row.id, "API_RESPONSE", "UNKNOWN", { error: message, statusCode: status ?? null }, client);

        const resolved = await resolveUnknownOrder(row.id, correlationId, dhan, client);
        results.push({
          id: row.id,
          correlationId,
          brokerOrderId: resolved?.orderId,
          status: resolved ? mapBrokerStatus(resolved.orderStatus) : "UNKNOWN",
          message: resolved
            ? "Placement reply was lost but the order exists at the broker - adopted it."
            : `Placement outcome is UNKNOWN and no matching order is in the book: ${message}`
        });
      }

      // A failed leg means the basket is incomplete. Stop rather than placing
      // the remaining legs into a structure that is no longer the one priced.
      break;
    }
  }

  return { groupId, orders: results };
}

/**
 * Resolve an UNKNOWN placement by looking for our own correlationId.
 *
 * Two probes, because the order book can lag a moment behind an accepted order.
 * Found means the order exists and must be adopted, not re-sent. Not found
 * after both probes means it is safe to treat as never placed.
 */
async function resolveUnknownOrder(
  orderId: string,
  correlationId: string,
  dhan: DhanClient,
  client: PrismaClient
): Promise<DhanBrokerOrder | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const found = await dhan.findOrderByCorrelationId(correlationId, "live:order:resolve-unknown");
      if (found) {
        await client.liveOrder.update({
          where: { id: orderId },
          data: {
            brokerOrderId: found.orderId,
            status: mapBrokerStatus(found.orderStatus),
            brokerStatusRaw: found.orderStatus,
            filledQty: found.filledQty,
            avgFillPrice: found.averageTradedPrice ?? null
          }
        });
        await recordOrderEvent(orderId, "RECONCILE", found.orderStatus, found as unknown as Record<string, unknown>, client);
        return found;
      }
    } catch {
      // The probe itself failed. Leave the row UNKNOWN - that is the honest
      // state, and the reconciler will try again.
    }
  }
  return undefined;
}

/**
 * Change price, trigger or size on a working order.
 *
 * Modify is NOT re-previewed. The two-phase confirm exists to stop an order
 * being placed against prices the trader never saw; a modify is the trader
 * looking at a resting order and adjusting it deliberately, and forcing a fresh
 * preview would only add a ten-second clock to a decision that does not need
 * one. The caps still apply where they can: quantity is re-derived through
 * toBrokerQuantity so a lot count can never be sent in the wrong unit.
 */
export async function modifyLiveOrder(
  user: AuthUserDto,
  orderId: string,
  input: { price?: number; triggerPrice?: number; lots?: number },
  client: PrismaClient = prisma
) {
  const account = await requireTradableAccount(user, client);
  const order = await client.liveOrder.findFirst({ where: { id: orderId, accountId: account.id } });
  if (!order) {
    throw new LiveOrderRejectedError("No such order on this account.");
  }
  if (!order.brokerOrderId) {
    throw new LiveOrderRejectedError("That order was never accepted by the broker, so there is nothing to modify.");
  }
  if (!["SENT", "OPEN", "PARTIAL"].includes(order.status)) {
    throw new LiveOrderRejectedError(`An order in state ${order.status} cannot be modified.`);
  }
  if (input.price === undefined && input.triggerPrice === undefined && input.lots === undefined) {
    throw new LiveOrderRejectedError("Nothing to change.");
  }

  const lots = input.lots ?? order.lots;
  // Never lots * lotSize inline: MCX counts lots and NSE counts contracts, and
  // getting it wrong here would resize a LIVE order by the lot size.
  const quantity = toBrokerQuantity(order.underlyingSymbol, lots);

  const dhan = await getUserDhanClient(user.id, client);
  const result = await dhan.modifyOrder(
    {
      orderId: order.brokerOrderId,
      orderType: order.orderType as "LIMIT" | "MARKET" | "STOP_LOSS" | "STOP_LOSS_MARKET",
      quantity,
      ...(input.price === undefined ? {} : { price: input.price }),
      ...(input.triggerPrice === undefined ? {} : { triggerPrice: input.triggerPrice }),
      validity: "DAY"
    },
    "live:order:modify"
  );

  await client.liveOrder.update({
    where: { id: order.id },
    data: {
      lots,
      quantity,
      ...(input.price === undefined ? {} : { price: input.price }),
      ...(input.triggerPrice === undefined ? {} : { triggerPrice: input.triggerPrice }),
      brokerStatusRaw: result.orderStatus ?? order.brokerStatusRaw
    }
  });
  await recordOrderEvent(order.id, "API_RESPONSE", result.orderStatus ?? "MODIFIED", {
    requested: input,
    quantitySent: quantity,
    result: result as unknown as Record<string, unknown>
  }, client);

  return { orderId: order.id, status: result.orderStatus ?? "MODIFIED", lots, quantity };
}

export async function cancelLiveOrder(user: AuthUserDto, orderId: string, client: PrismaClient = prisma) {
  const account = await requireTradableAccount(user, client, true);
  const order = await client.liveOrder.findFirst({ where: { id: orderId, accountId: account.id } });
  if (!order) {
    throw new LiveOrderRejectedError("No such order on this account.");
  }
  if (!order.brokerOrderId) {
    throw new LiveOrderRejectedError("That order was never accepted by the broker, so there is nothing to cancel.");
  }

  const dhan = await getUserDhanClient(user.id, client);
  const result = await dhan.cancelOrder(order.brokerOrderId, "live:order:cancel");
  await client.liveOrder.update({
    where: { id: order.id },
    data: { status: mapBrokerStatus(result.orderStatus) === "CANCELLED" ? "CANCELLED" : order.status, brokerStatusRaw: result.orderStatus ?? null }
  });
  await recordOrderEvent(order.id, "API_RESPONSE", result.orderStatus ?? "CANCELLED", result as unknown as Record<string, unknown>, client);
  return { orderId: order.id, status: result.orderStatus ?? "CANCELLED" };
}

// ------------------------------------------------------------------
// Reconciliation - Dhan is the source of truth, always
// ------------------------------------------------------------------

export interface LiveReconcileResult {
  ordersChecked: number;
  ordersUpdated: number;
  positionsUpserted: number;
  positionsClosed: number;
  drift: string[];
}

export async function reconcileLiveAccount(
  user: AuthUserDto,
  client: PrismaClient = prisma
): Promise<LiveReconcileResult> {
  const account = await client.liveAccount.findFirst({ where: { userId: user.id, isActive: true } });
  if (!account) {
    throw new LiveTradingDisabledError("No live account.");
  }
  const dhan = await getUserDhanClient(user.id, client);
  const result: LiveReconcileResult = { ordersChecked: 0, ordersUpdated: 0, positionsUpserted: 0, positionsClosed: 0, drift: [] };

  const [brokerOrders, brokerPositions] = [
    await dhan.getOrderBook("live:reconcile:orders"),
    await dhan.getPositions("live:reconcile:positions")
  ];

  const byCorrelation = new Map(brokerOrders.filter((o) => o.correlationId).map((o) => [o.correlationId as string, o]));
  const byBrokerId = new Map(brokerOrders.map((o) => [o.orderId, o]));

  const localOrders = await client.liveOrder.findMany({
    where: { accountId: account.id, status: { in: ["LOCAL_PENDING", "SENT", "OPEN", "PARTIAL", "UNKNOWN"] } }
  });

  for (const local of localOrders) {
    result.ordersChecked += 1;
    const broker = byCorrelation.get(local.correlationId) ?? (local.brokerOrderId ? byBrokerId.get(local.brokerOrderId) : undefined);
    if (!broker) {
      if (local.status === "UNKNOWN") {
        result.drift.push(`Order ${local.id} is UNKNOWN and absent from the broker's book - treat as never placed.`);
      }
      continue;
    }
    const mapped = mapBrokerStatus(broker.orderStatus);
    if (mapped !== local.status || broker.filledQty !== local.filledQty) {
      await client.liveOrder.update({
        where: { id: local.id },
        data: {
          status: mapped,
          brokerStatusRaw: broker.orderStatus,
          brokerOrderId: broker.orderId || local.brokerOrderId,
          filledQty: broker.filledQty,
          avgFillPrice: broker.averageTradedPrice ?? local.avgFillPrice,
          rejectionReason: broker.omsErrorDescription ?? local.rejectionReason
        }
      });
      await recordOrderEvent(local.id, "RECONCILE", broker.orderStatus, broker as unknown as Record<string, unknown>, client);
      result.ordersUpdated += 1;
    }
  }

  // Positions: the broker's list IS the truth. Anything we think is open and
  // it does not report has been closed elsewhere.
  const seen = new Set<string>();
  for (const position of brokerPositions) {
    if (position.netQty === 0) continue;
    seen.add(position.securityId);
    const underlying = guessUnderlyingFromSymbol(position.tradingSymbol) ?? "";
    await client.livePosition.upsert({
      where: { accountId_securityId_status: { accountId: account.id, securityId: position.securityId, status: "OPEN" } },
      create: {
        accountId: account.id,
        securityId: position.securityId,
        underlyingSymbol: underlying,
        exchangeSegment: position.exchangeSegment,
        tradingSymbol: position.tradingSymbol ?? null,
        netQty: position.netQty,
        avgCostPrice: position.costPrice,
        lotSize: position.lotSize ?? null,
        multiplier: position.multiplier ?? null,
        unrealizedPnl: position.unrealizedProfit,
        realizedPnl: position.realizedProfit,
        status: "OPEN",
        reconciledAt: new Date()
      },
      update: {
        netQty: position.netQty,
        avgCostPrice: position.costPrice,
        unrealizedPnl: position.unrealizedProfit,
        realizedPnl: position.realizedProfit,
        multiplier: position.multiplier ?? null,
        reconciledAt: new Date()
      }
    });
    result.positionsUpserted += 1;
  }

  const stale = await client.livePosition.findMany({ where: { accountId: account.id, status: "OPEN" } });
  for (const position of stale) {
    if (seen.has(position.securityId)) continue;
    await client.livePosition.update({
      where: { id: position.id },
      data: { status: "CLOSED", closedAt: new Date(), reconciledAt: new Date() }
    });
    result.positionsClosed += 1;
    result.drift.push(`Position ${position.securityId} was open locally but the broker does not report it - marked closed.`);
  }

  return result;
}

export interface LiveReconcileSweep {
  accountsConsidered: number;
  accountsReconciled: number;
  accountsSkipped: number;
  ordersUpdated: number;
  positionsUpserted: number;
  positionsClosed: number;
  drift: string[];
  errors: string[];
}

/**
 * Reconcile every account that has anything worth reconciling.
 *
 * Called on a timer by the worker. Dhan is authoritative in every disagreement;
 * our rows are a cache of it. Without this the panel shows whatever was true at
 * the moment an order was placed - which is how a filled spread sat reading
 * SENT/TRANSIT with no position and no P&L.
 *
 * Idle accounts are skipped rather than polled. An account with no open
 * position and no working order has nothing to learn, and every skipped account
 * is two Dhan calls not spent - which matters because those calls come out of
 * that user's own rate budget, not a shared one.
 */
export async function reconcileAllLiveAccounts(client: PrismaClient = prisma): Promise<LiveReconcileSweep> {
  const sweep: LiveReconcileSweep = {
    accountsConsidered: 0,
    accountsReconciled: 0,
    accountsSkipped: 0,
    ordersUpdated: 0,
    positionsUpserted: 0,
    positionsClosed: 0,
    drift: [],
    errors: []
  };

  const accounts = await client.liveAccount.findMany({
    where: { isActive: true },
    select: { id: true, userId: true, user: { select: { id: true, email: true, role: true } } }
  });

  for (const account of accounts) {
    sweep.accountsConsidered += 1;

    const [workingOrders, openPositions] = [
      await client.liveOrder.count({
        where: { accountId: account.id, status: { in: ["LOCAL_PENDING", "SENT", "OPEN", "PARTIAL", "UNKNOWN"] } }
      }),
      await client.livePosition.count({ where: { accountId: account.id, status: "OPEN" } })
    ];
    if (workingOrders === 0 && openPositions === 0) {
      sweep.accountsSkipped += 1;
      continue;
    }

    try {
      const result = await reconcileLiveAccount(
        {
          id: account.user.id,
          email: account.user.email,
          role: account.user.role,
          emailVerified: true,
          disabled: false
        } as AuthUserDto,
        client
      );
      sweep.accountsReconciled += 1;
      sweep.ordersUpdated += result.ordersUpdated;
      sweep.positionsUpserted += result.positionsUpserted;
      sweep.positionsClosed += result.positionsClosed;
      sweep.drift.push(...result.drift);
    } catch (error) {
      // One account's dead credential must not stop the sweep for everyone
      // else. A token expires every 24 hours, so this is routine rather than
      // exceptional, and it is reported rather than thrown.
      sweep.errors.push(`${account.user.email}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return sweep;
}

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------

export interface LiveSummary {
  enabled: boolean;
  credential: BrokerCredentialStatus;
  account: {
    id: string;
    brokerClientId: string;
    tradingEnabled: boolean;
    maxOrderMargin: number;
    maxOpenMargin: number;
    dailyLossLimit: number;
    maxMarginUtilPct: number;
    allowUndefinedRisk: boolean;
  } | null;
  funds: DhanFundLimit | null;
  orders: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
}

export async function getLiveSummary(user: AuthUserDto, client: PrismaClient = prisma): Promise<LiveSummary> {
  const credential = await getBrokerCredentialStatus(user, client);
  const account = await client.liveAccount.findFirst({ where: { userId: user.id, isActive: true } });

  let funds: DhanFundLimit | null = null;
  if (credential.present && credential.verifiedOk) {
    try {
      const dhan = await getUserDhanClient(user.id, client);
      funds = await dhan.getFundLimit("live:summary:funds");
    } catch {
      // A funds read failing must not blank the whole panel - the user still
      // needs to see their open positions, especially if the token has died.
      funds = null;
    }
  }

  const [orders, positions] = account
    ? [
        await client.liveOrder.findMany({ where: { accountId: account.id }, orderBy: { placedAt: "desc" }, take: 50 }),
        await client.livePosition.findMany({ where: { accountId: account.id, status: "OPEN" } })
      ]
    : [[], []];

  return {
    enabled: liveTradingEnabledGlobally(),
    credential,
    account: account
      ? {
          id: account.id,
          brokerClientId: account.brokerClientId,
          tradingEnabled: account.tradingEnabled,
          maxOrderMargin: Number(account.maxOrderMargin),
          maxOpenMargin: Number(account.maxOpenMargin),
          dailyLossLimit: Number(account.dailyLossLimit),
          maxMarginUtilPct: Number(account.maxMarginUtilPct),
          allowUndefinedRisk: account.allowUndefinedRisk
        }
      : null,
    funds,
    orders: orders.map(serializeOrder),
    positions: positions.map(serializePosition)
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

// Prisma's Bytes column types as Uint8Array<ArrayBuffer>, while Node's Buffer
// is Uint8Array<ArrayBufferLike> - assignable at runtime, rejected by tsc.
// Copying into a plain Uint8Array is the honest conversion.
function toPrismaBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  // Allocating the ArrayBuffer explicitly is what pins the generic. A plain
  // `new Uint8Array(buffer)` inherits Buffer's ArrayBufferLike, which Prisma's
  // Bytes input type rejects (it could be a SharedArrayBuffer).
  const copy = new Uint8Array(new ArrayBuffer(buffer.byteLength));
  copy.set(buffer);
  return copy;
}

function serializeOrder(order: Record<string, unknown>): Record<string, unknown> {
  const decimalKeys = ["strikePrice", "notional", "price", "triggerPrice", "avgFillPrice", "quotedPrice", "quotedMargin"];
  const out: Record<string, unknown> = { ...order };
  for (const key of decimalKeys) {
    const value = out[key] as { toNumber?: () => number } | null | undefined;
    out[key] = value && typeof value.toNumber === "function" ? value.toNumber() : value ?? null;
  }
  return out;
}

function serializePosition(position: Record<string, unknown>): Record<string, unknown> {
  const decimalKeys = ["strikePrice", "avgCostPrice", "lastPrice", "unrealizedPnl", "realizedPnl"];
  const out: Record<string, unknown> = { ...position };
  for (const key of decimalKeys) {
    const value = out[key] as { toNumber?: () => number } | null | undefined;
    out[key] = value && typeof value.toNumber === "function" ? value.toNumber() : value ?? null;
  }
  return out;
}

async function recordOrderEvent(
  orderId: string,
  source: string,
  status: string,
  payload: Record<string, unknown>,
  client: PrismaClient
): Promise<void> {
  try {
    await client.liveOrderEvent.create({
      data: { orderId, source, status: status.slice(0, 32), payload: payload as never }
    });
  } catch {
    // The audit trail must never be the reason an order path fails. A missing
    // event line is recoverable; a thrown exception mid-placement is not.
  }
}

async function enforceOrderRate(accountId: string, maxPerMinute: number, client: PrismaClient): Promise<void> {
  const since = new Date(Date.now() - 60_000);
  const recent = await client.liveOrder.count({ where: { accountId, placedAt: { gte: since } } });
  if (recent >= maxPerMinute) {
    throw new LiveOrderRejectedError(
      `Rate limit: ${recent} orders already placed in the last minute (cap ${maxPerMinute}). This exists to stop a loop from emptying an account.`
    );
  }
}

/** Map Dhan's order status vocabulary onto ours. Unknown strings stay UNKNOWN. */
function mapBrokerStatus(status: string | undefined): "LOCAL_PENDING" | "SENT" | "OPEN" | "PARTIAL" | "TRADED" | "CANCELLED" | "REJECTED" | "UNKNOWN" {
  switch ((status ?? "").toUpperCase()) {
    case "TRANSIT":
    case "PENDING":
      return "SENT";
    case "OPEN":
      return "OPEN";
    case "PARTIALLY_FILLED":
    case "PART_TRADED":
      return "PARTIAL";
    case "TRADED":
    case "EXECUTED":
    case "COMPLETE":
      return "TRADED";
    case "CANCELLED":
    case "CANCELED":
      return "CANCELLED";
    case "REJECTED":
      return "REJECTED";
    default:
      return "UNKNOWN";
  }
}

/** Best-effort underlying from a broker trading symbol, e.g. "NIFTY-Sep2026-24800-CE". */
function guessUnderlyingFromSymbol(tradingSymbol: string | undefined): string | undefined {
  if (!tradingSymbol) return undefined;
  const head = tradingSymbol.split(/[-\s]/)[0];
  return head ? head.toUpperCase() : undefined;
}

export { DhanApiError };

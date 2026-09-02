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
import { closeOrderTypeFor, evaluateExit, orderCloseSequence, orderOpenSequence, type ExitLegState } from "@option-decode/trading";

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
// Structures whose loss is unbounded. All are SHORTS - a naked long is not
// here, and must never be added: buying an option risks the premium and
// nothing more, which is the definition of defined risk. The names below all
// mean the sold version, matching SimStrategyType.
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
  /** False when Dhan's basket call returned nothing usable and the standalone sum was used instead. */
  basketPriced: boolean;
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
    currencyMargin: number | null;
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

// How far a trader's limit may sit from the last traded price, either way. A
// limit is inherently safe at the exchange - a marketable one fills at the
// better prevailing price rather than at the silly number - so this is not
// protecting the fill. It catches a misplaced decimal before it reaches the
// broker AND before it corrupts the margin preview, which is priced off this
// number. Generous on purpose: 5x admits any realistic resting order.
const MAX_LIMIT_PRICE_MULTIPLE = 5;

/**
 * Fill in securityId, and price for legs that did not name one.
 *
 * Refuses rather than guessing. A leg whose contract cannot be named, or which
 * fails the liquidity gate, stops the whole ticket - the alternative is placing
 * a real order against a contract we could not price.
 *
 * A caller-supplied `price` is the trader's LIMIT and is kept. Only a leg that
 * omits one is filled from the chain's last traded price. Until 2026-09-02 the
 * lookup overwrote the price unconditionally unless the caller had ALSO sent a
 * securityId - which the browser never does by design - so every limit order
 * went out at the last print with no way to choose a level.
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
    // The trader's limit survives; only an absent price falls back to the last
    // print. Guarded against a decimal-point slip: a limit far from the market
    // is not dangerous in itself - the exchange fills a marketable limit at the
    // better prevailing price - but it silently corrupts the margin preview,
    // which is computed from this number.
    if (leg.price !== undefined) {
      if (!Number.isFinite(leg.price) || leg.price <= 0) {
        throw new LiveOrderRejectedError(
          `${leg.optionType} ${leg.strikePrice}: a limit price must be a positive premium.`
        );
      }
      if (match.lastPrice > 0) {
        const high = match.lastPrice * MAX_LIMIT_PRICE_MULTIPLE;
        const low = match.lastPrice / MAX_LIMIT_PRICE_MULTIPLE;
        if (leg.price > high || leg.price < low) {
          throw new LiveOrderRejectedError(
            `${leg.optionType} ${leg.strikePrice}: a limit of ${leg.price} is more than ${MAX_LIMIT_PRICE_MULTIPLE}x away from the last traded price of ${match.lastPrice}. Check the decimal point.`
          );
        }
      }
    }
    return { ...leg, securityId: match.securityId, price: leg.price ?? match.lastPrice };
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
  /**
   * LIMIT (default) or MARKET.
   *
   * LIMIT stays the default deliberately. A market order on an option book is
   * how you discover the spread the hard way, and the liquidity gate that lets
   * a strike through does not promise a tight one - it only refuses the worst.
   */
  orderType?: "LIMIT" | "MARKET";
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
// The existing book's requirement only moves when a position opens or closes,
// so a 1-second preview poll must not re-ask Dhan for it on every tick. Same
// window as the funds cache, and cleared by the same invalidation.
const MARGIN_BASELINE_CACHE_MS = 10_000;
const marginBaselineCache = new Map<string, { amount: number; fetchedAt: number }>();

/**
 * Margin the account's EXISTING open positions already require, quoted on the
 * same basis as an `includePosition: true` basket.
 *
 * This is the subtrahend that makes a preview incremental. `includePosition:
 * true` returns the requirement of the WHOLE resulting book rather than the
 * cost of the new basket - measured 2026-09-01, a lone long call quoted
 * Rs 672.75 standalone and Rs 42,297.32 with the flag on, and a bought call
 * cannot require Rs 42k by itself. Subtracting the book's own requirement
 * leaves what adding this basket actually costs.
 *
 * Returns null when the figure could not be established. A caller must NOT
 * read that as zero: pricing against a book worth nothing understates the
 * requirement by the whole book, and that is the direction that lets someone
 * over-leverage.
 */
async function existingBookMargin(userId: string, dhan: DhanClient): Promise<number | null> {
  const cached = marginBaselineCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < MARGIN_BASELINE_CACHE_MS) {
    return cached.amount;
  }

  const positions = await dhan.getPositions("live:margin:baseline-positions");
  // netQty 0 is a position closed earlier today that Dhan still reports. It
  // blocks no margin and must not be priced as though it did.
  const open = positions.filter((position) => position.netQty !== 0);

  // The margin calculator only takes these three segments. If the book holds
  // anything else - an equity position, say - the book cannot be priced in
  // full, and a PARTIAL baseline is worse than none: it would understate what
  // the book requires, which inflates the incremental figure derived from it.
  // Report it as unavailable and let the caller take its conservative
  // fallback rather than quietly pricing against half a book.
  const quotable = new Set<DhanFnoSegment>(["NSE_FNO", "BSE_FNO", "MCX_COMM"]);
  if (open.some((position) => !quotable.has(position.exchangeSegment as DhanFnoSegment))) {
    return null;
  }

  let amount = 0;
  if (open.length > 0) {
    const quote = await dhan.calculateMultiOrderMargin(
      open.map((position) => ({
        // netQty carries the direction: long positive, short negative.
        transactionType: position.netQty > 0 ? ("BUY" as const) : ("SELL" as const),
        // Dhan's own quantity for that position, in whatever unit its segment
        // uses - contracts on NSE/BSE, lots on MCX. Handing it straight back
        // is what stops the MCX lots-vs-contracts asymmetry reappearing here.
        quantity: Math.abs(position.netQty),
        securityId: position.securityId,
        price: position.costPrice,
        exchangeSegment: position.exchangeSegment as DhanFnoSegment,
        productType: "MARGIN" as const
      })),
      "live:margin:baseline",
      { includePosition: false }
    );
    // Zero is this endpoint's measured failure mode, not a free book.
    if (!(quote.totalMargin > 0)) {
      return null;
    }
    amount = quote.totalMargin;
  }

  marginBaselineCache.set(userId, { amount, fetchedAt: Date.now() });
  return amount;
}

/**
 * The group that most recently OPENED each contract.
 *
 * A contract can be sold, closed, and sold again the same day. When it is, the
 * OLD group's leg still matches an open position if you only compare
 * securityIds - so a settled group gets re-evaluated against a position it did
 * not open, using the entry price of a trade that is already closed. Measured
 * 2026-09-02: NIFTY 24100 CE was sold at 51.80 and closed at 06:20, then sold
 * again at 58.00 at 07:34. Both groups then looked live on the same open
 * position, giving two competing sets of triggers - a profit target at 29.00
 * from the real fill and 25.90 from the dead one.
 *
 * Keying on the newest opening trade per contract settles it: the position
 * currently open on a contract was opened by the most recent trade on it.
 *
 * `ordersNewestFirst` must be ordered by placedAt DESC. Orders with no groupId
 * are closing orders and never open anything, so they are skipped.
 */
export function newestOpeningGroupBySecurityId(
  ordersNewestFirst: Array<{ securityId: string; groupId: string | null }>
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const order of ordersNewestFirst) {
    if (!order.groupId) continue;
    if (!newest.has(order.securityId)) newest.set(order.securityId, order.groupId);
  }
  return newest;
}

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

  // Priced against the existing book. On its own this is the requirement of the
  // WHOLE resulting book, not of these legs - the subtraction below is what
  // turns it into the cost of this ticket. The per-leg calls above stay
  // standalone so that gross and net end up on the same footing once the book
  // has been removed from both.
  const basket = await dhan.calculateMultiOrderMargin(marginLegs, "live:margin:basket", {
    includePosition: true,
    includeOrder: true
  });
  // INCREMENTAL, not absolute. `basket.totalMargin` is the requirement of the
  // whole resulting book, so subtracting what the book already requires leaves
  // what THIS ticket costs to add. Both halves of the hedge comparison below
  // then exclude the existing book, which is what makes them comparable.
  //
  // Pricing it absolutely was wrong in two ways at once, both measured on
  // 2026-09-01. netMargin carried the existing book while availableBalance was
  // already net of it, so the book was subtracted twice and a fundable trade
  // was refused - the reported "insufficient funds ... but we already have the
  // hedging leg". And because net then always exceeded gross, the displayed
  // hedge benefit clamped to zero: a 24650/24850 call spread costs Rs 35,605
  // less than the naked short and the panel showed 0.0%.
  const bookMargin = await existingBookMargin(user.id, dhan);
  const basketUsable = basket.totalMargin > 0 && bookMargin !== null;
  // A ticket that REDUCES risk - buying back a short, say - legitimately
  // prices below the book it joins, i.e. it releases margin rather than
  // consuming it. That is a real answer, so it floors at zero instead of
  // falling back to the (much larger) standalone sum.
  //
  // The fallback is that standalone sum, which OVERSTATES a hedged position.
  // That is the safe direction: it can refuse a fundable trade, where an
  // understatement would admit an unfundable one.
  const netMargin = basketUsable ? Math.max(0, basket.totalMargin - (bookMargin as number)) : grossMargin;
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
    // Surfaced rather than hidden: when the basket call fails we fall back to
    // the standalone sum, which OVERSTATES a hedged position - and silently
    // showing an inflated requirement is how a fundable trade looks unfundable.
    basketPriced: basketUsable,
    productType: "MARGIN",
    funds,
    requirement: {
      total: netMargin,
      span: basket.spanMargin > 0 ? basket.spanMargin : null,
      exposure: basket.exposureMargin > 0 ? basket.exposureMargin : null,
      fo: basket.foMargin > 0 ? basket.foMargin : null,
      commodity: basket.commodityMargin > 0 ? basket.commodityMargin : null,
      currencyMargin: basket.currencyMargin > 0 ? basket.currencyMargin : null
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
  /**
   * Set when the basket was deliberately left incomplete - almost always a
   * hedge leg that did not fill, so its short legs were never sent. The orders
   * that DID go out are still listed above; this says why the rest did not,
   * and the caller must show it rather than reporting a clean placement.
   */
  abortedReason?: string;
}

// How long a leg has to FILL before the legs that depend on it are abandoned.
// Fifteen seconds is long against a marketable limit on a liquid option and
// short against a trader waiting on a confirmation.
const LEG_FILL_TIMEOUT_MS = 15_000;
const LEG_FILL_POLL_MS = 1_000;

/**
 * Block until every named order has actually TRADED.
 *
 * ACCEPTED IS NOT ENOUGH, and that distinction is the whole point of waiting.
 * Used at BOTH ends of a position's life, for the same reason each time - the
 * broker's risk system only sees a leg once it has filled, not when it has
 * been acknowledged:
 *
 * - Opening, the hedge must exist before anything is sold against it, or the
 *   account is naked with a resting buy that may never fill.
 * - Closing, the short must be flat before its wing is sold, or Dhan's RMS
 *   still sees the wing as protecting a live short and refuses. Measured
 *   2026-09-02: "RMS: This leg is part of a hedge. Close the main position or
 *   add 39684.59 funds to continue", on a close sent 90ms after the short's.
 *
 * A PARTIAL fill is treated as not filled. Half a leg is not the state either
 * caller is waiting for, and quietly accepting it would hide that.
 */
async function waitForOrderFills(
  brokerOrderIds: string[],
  dhan: DhanClient
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + LEG_FILL_TIMEOUT_MS;
  const pending = new Set(brokerOrderIds);
  let lastStatus = "no reply yet";

  while (pending.size > 0) {
    if (Date.now() >= deadline) {
      return {
        ok: false,
        detail: `it did not fill within ${Math.round(LEG_FILL_TIMEOUT_MS / 1000)}s (last seen ${lastStatus})`
      };
    }
    await new Promise((resolve) => setTimeout(resolve, LEG_FILL_POLL_MS));

    for (const brokerOrderId of [...pending]) {
      let observed: DhanBrokerOrder | undefined;
      try {
        observed = await dhan.getOrderById(brokerOrderId, "live:order:hedge-fill");
      } catch {
        // A failed probe is not a failed hedge. Keep polling until the
        // deadline rather than abandoning a wing that may be filling.
        continue;
      }
      const status = mapBrokerStatus(observed?.orderStatus);
      lastStatus = status;
      if (status === "TRADED") {
        pending.delete(brokerOrderId);
      } else if (status === "REJECTED" || status === "CANCELLED") {
        return { ok: false, detail: `the order came back ${status}` };
      }
    }
  }
  return { ok: true, detail: "filled" };
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
  const orderType = ticket.orderType === "MARKET" ? "MARKET" : "LIMIT";

  const results: LivePlacementResult["orders"] = [];

  // HEDGE FIRST, and prove it filled before selling against it.
  //
  // Whichever leg fails, the account should be left holding the safer half.
  // Selling first and then failing to buy the wing leaves it NAKED SHORT -
  // unbounded risk on a structure that was priced as defined-risk, and a
  // margin requirement measured on this account at Rs 1,39,063 naked against
  // Rs 1,03,458 as a spread. Buying first and failing to sell leaves a long
  // option, whose worst case is the premium already paid.
  //
  // A naked structure has no BUY leg, so both the reordering and the wait are
  // no-ops for it and it places exactly as before.
  const sequenced = orderOpenSequence(ticket.legs);
  const hedgeBrokerOrderIds: string[] = [];
  let hedgesConfirmed = false;
  let abortedReason: string | undefined;

  for (const leg of sequenced) {
    // The gate between the hedge and the risk. Runs once, immediately before
    // the first SELL, and only when a hedge was actually placed.
    if (leg.side === "SELL" && hedgeBrokerOrderIds.length > 0 && !hedgesConfirmed) {
      const outcome = await waitForOrderFills(hedgeBrokerOrderIds, dhan);
      if (!outcome.ok) {
        // Deliberately NOT cancelling the resting hedge. A long option is a
        // bounded, benign thing to hold, the trader may still want it, and
        // cancelling on their behalf is a second unrequested action layered on
        // a failure they have not seen yet. It is visible in the orders tab
        // and one click from cancellation there.
        abortedReason = `Short leg(s) not sent: the hedge ${outcome.detail}. The hedge order is still working - cancel it from the Orders tab if you no longer want it.`;
        break;
      }
      hedgesConfirmed = true;
    }

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
        orderType,
        lots: ticket.lots,
        lotSize,
        quantity,
        notional: leg.strikePrice * lotSize * ticket.lots,
        price: orderType === "MARKET" ? null : leg.price,
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
          orderType,
          securityId: leg.securityId,
          quantity,
          // A market order carries no price. Sending the resolved last price
          // alongside MARKET would look like a limit that was ignored.
          price: orderType === "MARKET" ? 0 : leg.price,
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
      // Only a hedge with a broker id can be waited on. One accepted without
      // an id cannot be polled, so it must not be counted as a hedge to wait
      // for - that would block the short legs until the timeout every time.
      if (leg.side === "BUY" && placed.orderId) {
        hedgeBrokerOrderIds.push(placed.orderId);
      }
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
      // Say so explicitly: the results list carries this leg's REJECTED or
      // UNKNOWN status, but nothing in it explains why the legs AFTER it are
      // simply absent, and "Placed 1 order(s)" on its own reads like success.
      abortedReason =
        `${leg.side} ${leg.optionType} ${leg.strikePrice} did not go through, so the remaining leg(s) were not sent: ${message}`;
      break;
    }
  }

  return { groupId, orders: results, abortedReason };
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
// Closing a position
// ------------------------------------------------------------------

/**
 * Square off one open position by placing the opposite order.
 *
 * MARKET by default. A limit order to close is an order that might not fill,
 * and "I asked to be out and I am not out" is the worst state this module can
 * put someone in - so the default accepts slippage in exchange for certainty.
 * A limit price is available for a deliberate, unhurried exit.
 *
 * Deliberately NOT gated on canOpen. A trader must always be able to close,
 * even when the token is too close to expiry to open anything new, even when
 * the caps would refuse a new position, and even when trading has been disabled
 * on the account since the position was opened. Refusing an exit is never the
 * safe default.
 */
export async function squareOffLivePosition(
  user: AuthUserDto,
  positionId: string,
  input: { limitPrice?: number; exitReason?: string; exitDetail?: string } = {},
  client: PrismaClient = prisma
) {
  const account = await requireTradableAccount(user, client, true);
  // A square-off with no stated reason came from a person clicking Exit.
  return squareOffForAccount(account.id, user.id, positionId, { exitReason: "MANUAL", ...input }, client);
}

/**
 * The square-off itself, without the caller-identity gate.
 *
 * Split out so the exit engine can close a position without inventing an
 * AuthUserDto to satisfy a check it has already made in a stronger form - it
 * verified autoExitEnabled on this specific account. Faking an identity to get
 * past a gate is how a gate stops meaning anything, and doing it in the one
 * code path that places unattended orders would be the worst place to start.
 *
 * The account id is passed explicitly rather than re-derived, so this cannot
 * act on an account the caller did not already resolve.
 */
async function squareOffForAccount(
  accountId: string,
  userId: string,
  positionId: string,
  input: { limitPrice?: number; exitReason?: string; exitDetail?: string } = {},
  client: PrismaClient = prisma
) {
  const account = await client.liveAccount.findUnique({ where: { id: accountId } });
  if (!account) {
    throw new LiveOrderRejectedError("No such live account.");
  }
  const position = await client.livePosition.findFirst({
    where: { id: positionId, accountId: account.id, status: "OPEN" }
  });
  if (!position) {
    throw new LiveOrderRejectedError("No such open position on this account.");
  }

  const netQty = position.netQty;
  if (!netQty) {
    throw new LiveOrderRejectedError("That position is already flat.");
  }

  // Stamp WHY before sending anything. The close is only ever DETECTED later,
  // by reconciliation noticing netQty hit 0 at the broker, and by then this
  // call is long gone - so recording the reason up front is the only way it
  // survives to the closed row. Written even if the order then fails: the row
  // stays OPEN in that case and the next close overwrites it.
  if (input.exitReason) {
    await client.livePosition.update({
      where: { id: position.id },
      data: { exitReason: input.exitReason.slice(0, 32), exitDetail: input.exitDetail?.slice(0, 255) ?? null }
    });
  }

  // Opposite side, absolute quantity. netQty is negative for a short, so a
  // short is closed by BUYing and a long by SELLing.
  const transactionType: "BUY" | "SELL" = netQty < 0 ? "BUY" : "SELL";
  const quantity = Math.abs(netQty);
  const correlationId = randomUUID().replace(/-/g, "").slice(0, 24);

  // Belt and braces on the contract. The position row is the primary source now
  // that the reconciler parses it, but a closing order that records "NIFTY 0 CE"
  // is unreadable afterwards - and that is exactly what shipped, because these
  // fields were silently null and `?? 0` hid it. So fall back to the opening
  // order, then to parsing the broker symbol, before accepting a blank.
  const opener = await client.liveOrder.findFirst({
    where: { accountId: account.id, securityId: position.securityId, status: "TRADED", legRole: { not: "CLOSE" } },
    orderBy: { placedAt: "desc" },
    select: { expiryLabel: true, optionType: true, strikePrice: true }
  });
  const parsed = parseBrokerTradingSymbol(position.tradingSymbol ?? undefined);
  const optionType = position.optionType ?? opener?.optionType ?? parsed.optionType ?? "CE";
  const strikePrice = position.strikePrice ?? opener?.strikePrice ?? parsed.strikePrice ?? 0;
  const expiryLabel = position.expiryLabel ?? opener?.expiryLabel ?? "";

  const row = await client.liveOrder.create({
    data: {
      accountId: account.id,
      groupId: null,
      legRole: "CLOSE",
      correlationId,
      underlyingSymbol: position.underlyingSymbol,
      expiryLabel,
      optionType,
      strikePrice,
      securityId: position.securityId,
      exchangeSegment: position.exchangeSegment,
      transactionType,
      productType: "MARGIN",
      orderType: input.limitPrice ? "LIMIT" : "MARKET",
      lots: 1,
      lotSize: position.lotSize ?? 1,
      // Straight from netQty, NOT recomputed through toBrokerQuantity: the
      // broker told us this quantity, in whatever unit that exchange uses, so
      // echoing it back is exact. Re-deriving it from lots would reintroduce
      // the contracts-versus-lots question on the one path where being wrong
      // means failing to close.
      quantity,
      notional: 0,
      price: input.limitPrice ?? null,
      status: "LOCAL_PENDING"
    }
  });
  await recordOrderEvent(row.id, "LOCAL", "LOCAL_PENDING", { squareOff: positionId, correlationId }, client);

  const dhan = await getUserDhanClient(userId, client);
  try {
    await client.liveOrder.update({ where: { id: row.id }, data: { status: "SENT" } });
    const placed = await dhan.placeOrder(
      {
        correlationId,
        transactionType,
        exchangeSegment: position.exchangeSegment as DhanFnoSegment,
        productType: "MARGIN",
        orderType: input.limitPrice ? "LIMIT" : "MARKET",
        securityId: position.securityId,
        quantity,
        price: input.limitPrice ?? 0,
        validity: "DAY"
      },
      "live:position:square-off"
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
    return { orderId: row.id, brokerOrderId: placed.orderId, status: mapBrokerStatus(placed.orderStatus), transactionType, quantity };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DhanApiError ? error.statusCode : undefined;
    const rejected = status !== undefined && status >= 400 && status < 500;
    await client.liveOrder.update({
      where: { id: row.id },
      data: { status: rejected ? "REJECTED" : "UNKNOWN", rejectionReason: message.slice(0, 255) }
    });
    await recordOrderEvent(row.id, "API_RESPONSE", rejected ? "REJECTED" : "UNKNOWN", { error: message }, client);
    throw new LiveOrderRejectedError(`Square-off failed: ${message}`);
  }
}

export interface LivePanicResult {
  ordersCancelled: number;
  positionsSquaredOff: number;
  failures: string[];
}

/**
 * Cancel every working order, then square off every open position.
 *
 * Orders first, deliberately: a resting order that fills midway through would
 * re-open exposure this is trying to remove.
 *
 * Never stops on the first failure. A panic that gives up halfway leaves a book
 * in a worse state than either doing nothing or finishing - so every position is
 * attempted and the failures are returned together.
 */
export async function panicCloseLiveAccount(
  user: AuthUserDto,
  client: PrismaClient = prisma
): Promise<LivePanicResult> {
  const account = await requireTradableAccount(user, client, true);
  const result: LivePanicResult = { ordersCancelled: 0, positionsSquaredOff: 0, failures: [] };

  const working = await client.liveOrder.findMany({
    where: { accountId: account.id, status: { in: ["SENT", "OPEN", "PARTIAL"] }, brokerOrderId: { not: null } }
  });
  for (const order of working) {
    try {
      await cancelLiveOrder(user, order.id, client);
      result.ordersCancelled += 1;
    } catch (error) {
      result.failures.push(`cancel ${order.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const positions = await client.livePosition.findMany({ where: { accountId: account.id, status: "OPEN" } });
  for (const position of positions) {
    if (!position.netQty) continue;
    try {
      const outcome = await squareOffLivePosition(
        user,
        position.id,
        { exitReason: "PANIC", exitDetail: "Panic close: every open position squared off at market." },
        client
      );
      // Same trap as the exit engine: a broker that accepts the call and then
      // refuses the order returns normally rather than throwing. A panic that
      // reports a position squared off when it is still open is the worst
      // possible place for that to happen.
      if (outcome.status === "REJECTED" || outcome.status === "CANCELLED") {
        result.failures.push(
          `square off ${position.tradingSymbol ?? position.securityId}: the broker ${outcome.status} the closing order`
        );
      } else {
        result.positionsSquaredOff += 1;
      }
    } catch (error) {
      result.failures.push(`square off ${position.tradingSymbol ?? position.securityId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
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
    // A netQty of 0 is how Dhan reports a position CLOSED today, and it carries
    // the realised P&L. Skipping it threw that number away and then let the
    // stale-position pass below mark our row closed with whatever realised
    // figure we last happened to see - usually zero. So a flat row updates the
    // realised P&L and closes the position, rather than being ignored.
    if (position.netQty === 0) {
      const closed = await client.livePosition.updateMany({
        where: { accountId: account.id, securityId: position.securityId, status: "OPEN" },
        data: {
          netQty: 0,
          realizedPnl: position.realizedProfit,
          unrealizedPnl: 0,
          // Parsed here too, or a position that closes before it is ever seen
          // open keeps null contract fields forever.
          optionType: parseBrokerTradingSymbol(position.tradingSymbol).optionType ?? undefined,
          strikePrice: parseBrokerTradingSymbol(position.tradingSymbol).strikePrice ?? undefined,
          status: "CLOSED",
          closedAt: new Date(),
          reconciledAt: new Date()
        }
      });
      if (closed.count) {
        // Nothing here asked for this close, so it happened elsewhere - squared
        // off in the Dhan app, or settled at expiry. Stamped rather than left
        // null so an empty reason never has to be interpreted by a reader.
        await client.livePosition.updateMany({
          where: { accountId: account.id, securityId: position.securityId, status: "CLOSED", exitReason: null },
          data: {
            exitReason: "EXTERNAL",
            exitDetail: "Closed at the broker, not by this app - squared off in Dhan or settled at expiry."
          }
        });
        result.positionsClosed += closed.count;
      }
      seen.add(position.securityId);
      continue;
    }
    seen.add(position.securityId);
    const parsed = parseBrokerTradingSymbol(position.tradingSymbol);
    const underlying = parsed.underlyingSymbol ?? "";
    // The expiry date is not in the broker's symbol - "Sep2026" carries a month
    // and no day - so it has to come from somewhere else.
    //
    // Sourcing it ONLY from the order that opened the position was wrong: a
    // position opened directly in Dhan has no such order, so its expiry stayed
    // null and the panel showed nothing for it. The app's own contract tables
    // know the answer for any contract the chain capture has ever seen, keyed
    // by the same securityId the broker reports, so they are consulted too.
    const opener = await client.liveOrder.findFirst({
      where: { accountId: account.id, securityId: position.securityId, status: "TRADED" },
      orderBy: { placedAt: "desc" },
      select: { expiryLabel: true, optionType: true, strikePrice: true }
    });
    const known = opener
      ? null
      : await client.optionContract.findFirst({
          where: { securityId: position.securityId },
          select: { optionType: true, strikePrice: true, expiry: { select: { expiryLabel: true } } }
        });
    const contract = {
      expiryLabel: opener?.expiryLabel ?? known?.expiry.expiryLabel ?? null,
      optionType: opener?.optionType ?? known?.optionType ?? parsed.optionType ?? null,
      strikePrice: opener?.strikePrice ?? known?.strikePrice ?? parsed.strikePrice ?? null
    };
    await client.livePosition.upsert({
      where: { accountId_securityId_status: { accountId: account.id, securityId: position.securityId, status: "OPEN" } },
      create: {
        accountId: account.id,
        securityId: position.securityId,
        underlyingSymbol: underlying,
        exchangeSegment: position.exchangeSegment,
        tradingSymbol: position.tradingSymbol ?? null,
        expiryLabel: contract.expiryLabel,
        optionType: contract.optionType,
        strikePrice: contract.strikePrice,
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
        // Backfilled on every sweep, so rows written before this parsed the
        // contract heal themselves rather than needing a migration.
        expiryLabel: contract.expiryLabel,
        optionType: contract.optionType,
        strikePrice: contract.strikePrice,
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
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        reconciledAt: new Date(),
        // Open locally, absent at the broker. Same reasoning as above: say so
        // rather than leaving the reason blank.
        exitReason: position.exitReason ?? "EXTERNAL",
        exitDetail:
          position.exitDetail ?? "Open locally but the broker no longer reports it - closed elsewhere."
      }
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
// Per-position stop
// ------------------------------------------------------------------

/**
 * Set or clear a stop on one position.
 *
 * This is a price level on a single contract, deliberately not another
 * structure rule. The structure rules are percentages of a credit and need a
 * whole basket this app opened; a single leg - especially one adopted from the
 * broker - has no credit for them to be percentages OF. Stretching them to
 * cover it would be a thin protection wearing the costume of a full one.
 *
 * Direction is derived from netQty, never stored: a SHORT is stopped when the
 * premium RISES to the level, a long when it FALLS to it. Deriving it means the
 * stop cannot disagree with the position it is attached to.
 *
 * NOT gated on autoExitEnabled. That switch means "manage my structures for me";
 * this is the trader naming a specific level on a specific contract, which is
 * its own instruction. A stop that silently does nothing because an unrelated
 * global flag is off is the worst possible failure for this feature - the whole
 * value of a stop is that you can stop thinking about it.
 */
export async function setPositionStop(
  user: AuthUserDto,
  positionId: string,
  stopPrice: number | null,
  // The live premium, supplied by the caller because it lives in Redis and this
  // package does not talk to Redis. Passing it in is not a style choice: the
  // first version compared against LivePosition.lastPrice, which is NEVER
  // written - the reconciler does not set it and the API overlays the mark at
  // read time - so the already-breached guard below was dead code from the
  // moment it shipped, and a stop set below the current premium on a short
  // would have closed at market on the next sweep.
  currentMark?: number,
  client: PrismaClient = prisma
) {
  const account = await requireTradableAccount(user, client, true);
  const position = await client.livePosition.findFirst({
    where: { id: positionId, accountId: account.id, status: "OPEN" }
  });
  if (!position) {
    throw new LiveOrderRejectedError("No such open position on this account.");
  }
  if (stopPrice !== null) {
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
      throw new LiveOrderRejectedError("A stop must be a positive premium level.");
    }
    // Refuse a stop that is already breached. Accepting one would fire it on
    // the next sweep and close at market - which the trader may want, but not
    // as a surprise consequence of typing a number.
    //
    // When no mark is available the guard is skipped rather than the stop
    // refused: a quiet contract the feed has nothing recent for is a bad reason
    // to prevent someone protecting a position.
    const last = currentMark !== undefined && Number.isFinite(currentMark) ? currentMark : null;
    if (last !== null) {
      const isShort = position.netQty < 0;
      if (isShort && stopPrice <= last) {
        throw new LiveOrderRejectedError(
          `This is a SHORT: the stop must be ABOVE the current premium of ${last}. A stop at or below it is already breached.`
        );
      }
      if (!isShort && stopPrice >= last) {
        throw new LiveOrderRejectedError(
          `This is a LONG: the stop must be BELOW the current premium of ${last}. A stop at or above it is already breached.`
        );
      }
    }
  }

  await client.livePosition.update({
    where: { id: position.id },
    data: { stopPrice, stopSetAt: stopPrice === null ? null : new Date() }
  });
  return { positionId: position.id, stopPrice };
}

/**
 * Fire any per-position stop whose level has been reached.
 *
 * Always MARKET. A stop that rests as an unfilled limit is not a stop, and this
 * one fires precisely when the premium has run past a level the trader chose -
 * which is when a limit at the last print does not get hit.
 *
 * Runs for EVERY open position with a stop, including ones this app never
 * opened. That is the whole point: the structure engine deliberately refuses to
 * touch adopted positions because it would be applying rules the trader never
 * chose, and a stop is the trader choosing one.
 */
async function runPositionStops(
  markFor: LiveMarkLookup,
  client: PrismaClient
): Promise<{ triggered: number; failures: string[] }> {
  const result = { triggered: 0, failures: [] as string[] };
  const withStops = await client.livePosition.findMany({
    where: { status: "OPEN", stopPrice: { not: null } }
  });

  for (const position of withStops) {
    if (!position.netQty || !position.stopPrice) continue;
    const last = markFor(position.securityId);
    // No mark, no decision. Firing a stop on a stale price is worse than
    // firing it late.
    if (last === undefined || !Number.isFinite(last)) continue;

    const stop = position.stopPrice.toNumber();
    const isShort = position.netQty < 0;
    const breached = isShort ? last >= stop : last <= stop;
    if (!breached) continue;

    const account = await client.liveAccount.findUnique({ where: { id: position.accountId } });
    if (!account || !account.isActive) continue;

    // Same duplicate guard as the structure engine: never a second closing
    // order while one is working, so a retry after a transient failure cannot
    // double the position the other way.
    const inFlight = await client.liveOrder.count({
      where: {
        accountId: position.accountId,
        securityId: position.securityId,
        legRole: "CLOSE",
        status: { in: ["LOCAL_PENDING", "SENT", "OPEN", "PARTIAL", "UNKNOWN"] }
      }
    });
    if (inFlight > 0) continue;

    const detail = `Stop at ${stop} breached: ${isShort ? "short" : "long"} premium is ${last}.`;
    try {
      await squareOffForAccount(
        position.accountId,
        account.userId,
        position.id,
        { exitReason: "STOP", exitDetail: detail },
        client
      );
      // Cleared on success so a partial fill that leaves the position open does
      // not re-arm against a level already acted on.
      await client.livePosition.update({
        where: { id: position.id },
        data: { stopPrice: null, stopSetAt: null }
      });
      result.triggered += 1;
      await recordStopEvent(position.accountId, position.id, "AUTO_CLOSED", detail, client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push(`${position.tradingSymbol ?? position.securityId}: ${message}`);
      // The stop is deliberately LEFT SET on failure, so the next sweep tries
      // again. A stop that disarms itself because the broker hiccupped is not a
      // stop.
      await recordStopEvent(position.accountId, position.id, "FAILED", `${detail} ${message}`, client);
    }
  }

  return result;
}

async function recordStopEvent(
  accountId: string,
  positionId: string,
  action: "AUTO_CLOSED" | "FAILED",
  detail: string,
  client: PrismaClient
): Promise<void> {
  try {
    await client.liveExitEvent.create({
      // groupId namespaced by position, so a per-position stop shares the audit
      // table with the structure rules without colliding with a real groupId.
      data: { accountId, groupId: `pos:${positionId}`, rule: "POSITION_STOP", action, detail: detail.slice(0, 500) }
    });
  } catch {
    // Already recorded for this position, or the audit write failed. Neither is
    // a reason to leave a breached stop unactioned.
  }
}

// ------------------------------------------------------------------
// Exit engine
// ------------------------------------------------------------------

export interface LiveExitSweep {
  groupsEvaluated: number;
  groupsSkipped: number;
  flagged: number;
  autoClosed: number;
  failures: string[];
}

/**
 * Evaluate the seller exit rules against every live structure this module
 * opened, and act according to the account's setting.
 *
 * TWO safety properties define this function.
 *
 * ONLY WHAT WE OPENED. Positions are grouped by the groupId of the orders that
 * created them. A position adopted from the broker - held before this module
 * existed, or opened in Dhan's own app - has no group and is never actioned.
 * Closing something the trader opened elsewhere, on rules they never chose, is
 * not a stop-loss; it is this app deciding it owns their account.
 *
 * FLAG BEFORE ACT. With autoExitEnabled false, which is the default, a fired
 * rule is recorded and surfaced and nothing reaches the broker. Placing closing
 * orders unattended is a much larger step than reporting that a threshold was
 * crossed, and it should be earned by watching the engine flag correctly first.
 *
 * Idempotency is the unique index on (groupId, rule): a condition that holds for
 * an hour fires one event, not one every evaluation.
 */
export async function runLiveExitEngine(
  markFor: LiveMarkLookup,
  client: PrismaClient = prisma
): Promise<LiveExitSweep> {
  const sweep: LiveExitSweep = { groupsEvaluated: 0, groupsSkipped: 0, flagged: 0, autoClosed: 0, failures: [] };

  // Per-position stops first. They are the trader's own explicit levels, they
  // cover positions the structure rules cannot reach, and running them first
  // means a breached stop is not delayed behind basket evaluation.
  const stops = await runPositionStops(markFor, client);
  sweep.autoClosed += stops.triggered;
  sweep.failures.push(...stops.failures);

  const positions = await client.livePosition.findMany({ where: { status: "OPEN" } });
  if (!positions.length) return sweep;

  // Map securityId -> the order that opened it, for the group and the entry
  // price. Orders, not positions, because groupId lives there.
  const filled = await client.liveOrder.findMany({
    where: { status: "TRADED", securityId: { in: positions.map((p) => p.securityId) } },
    orderBy: { placedAt: "desc" }
  });

  const byGroup = new Map<string, { accountId: string; orders: typeof filled }>();
  for (const order of filled) {
    if (!order.groupId) continue;
    const entry = byGroup.get(order.groupId) ?? { accountId: order.accountId, orders: [] };
    entry.orders.push(order);
    byGroup.set(order.groupId, entry);
  }

  const openSecurityIds = new Set(positions.map((p) => p.securityId));
  // `filled` is already ordered placedAt DESC, which is what this relies on.
  const newestGroupFor = newestOpeningGroupBySecurityId(filled);

  for (const [groupId, group] of byGroup) {
    // Every leg of the structure must still be open, AND this group must be the
    // one that opened it. The second half is not redundant: re-trading a
    // contract closed earlier the same day leaves the old group matching the
    // new position by securityId alone.
    //
    // A partially closed group is no longer the structure the credit was
    // computed for, and applying a whole-structure rule to half of it would be
    // arithmetic on a fiction.
    const stillOpen = group.orders.filter(
      (order) => openSecurityIds.has(order.securityId) && newestGroupFor.get(order.securityId) === groupId
    );
    if (!stillOpen.length || stillOpen.length !== group.orders.length) {
      sweep.groupsSkipped += 1;
      continue;
    }

    const legs: ExitLegState[] = [];
    let priced = true;
    for (const order of stillOpen) {
      const last = markFor(order.securityId);
      if (last === undefined || !Number.isFinite(last)) {
        // No price, no decision. Acting on a stale mark is how a stop fires on
        // a number that was true ten minutes ago.
        priced = false;
        break;
      }
      legs.push({
        side: order.transactionType === "SELL" ? "SELL" : "BUY",
        entryPrice: Number(order.avgFillPrice ?? order.price ?? 0),
        lastPrice: last
      });
    }
    if (!priced) {
      sweep.groupsSkipped += 1;
      continue;
    }

    const quantity = stillOpen[0].quantity;
    const netCredit = legs.reduce(
      (sum, leg) => sum + (leg.side === "SELL" ? leg.entryPrice : -leg.entryPrice) * quantity,
      0
    );
    const expiryLabel = stillOpen[0].expiryLabel;
    const expiryMs = new Date(`${expiryLabel}T00:00:00Z`).getTime();
    const daysToExpiry = Math.ceil((expiryMs - Date.now()) / 86_400_000);

    // Days to expiry when this group was OPENED, measured from its EARLIEST
    // leg - the group exists from the moment its first leg is placed, and a
    // hedge that filled seconds before the short is the same entry.
    //
    // This is what lets DTE_GAMMA tell drift from entry. Without it the rule
    // cannot fire at all, so if this ever becomes undefined the gamma exit
    // goes quiet rather than misfiring - the safe direction, but quiet.
    const openedMs = Math.min(...stillOpen.map((order) => order.placedAt.getTime()));
    const daysToExpiryAtEntry = Math.ceil((expiryMs - openedMs) / 86_400_000);

    sweep.groupsEvaluated += 1;
    const decision = evaluateExit({
      structure: "LIVE",
      legs,
      netCredit,
      quantity,
      daysToExpiry: Number.isFinite(daysToExpiry) ? daysToExpiry : 999,
      daysToExpiryAtEntry: Number.isFinite(daysToExpiryAtEntry) ? daysToExpiryAtEntry : undefined
    });
    if (!decision) continue;

    const account = await client.liveAccount.findUnique({ where: { id: group.accountId } });
    if (!account) continue;
    const autoExit = account.autoExitEnabled;

    try {
      // The unique index does the work: a duplicate throws and we move on,
      // rather than this having to hold a lock or re-read to check.
      await client.liveExitEvent.create({
        data: {
          accountId: group.accountId,
          groupId,
          rule: decision.rule,
          action: autoExit ? "AUTO_CLOSED" : "FLAGGED",
          detail: decision.detail.slice(0, 500)
        }
      });
    } catch {
      // Already fired for this group and rule. Nothing more to do.
      continue;
    }

    sweep.flagged += 1;
    if (!autoExit) continue;

    // --- Auto-close ---------------------------------------------------------
    const orderType = closeOrderTypeFor(decision.rule);
    // SHORT legs first, always. Closing a long wing first leaves the account
    // momentarily naked short - unbounded risk and several times the margin, on
    // a position that was defined-risk a second earlier.
    const sequenced = orderCloseSequence(
      stillOpen.map((order) => ({
        side: order.transactionType === "SELL" ? ("SELL" as const) : ("BUY" as const),
        order
      }))
    );

    let closedLegs = 0;
    const legFailures: string[] = [];
    // Cached per user by getUserDhanClient, so this costs nothing per group.
    // Needed to poll the short's fill before the wing is released.
    const dhan = await getUserDhanClient(account.userId, client);
    // Broker ids of closes placed for the SHORT legs. The wing cannot be sold
    // until these have FILLED - see the RMS rejection in waitForOrderFills.
    const shortCloseBrokerIds: string[] = [];
    let shortsFlat = false;

    for (const { order, side } of sequenced) {
      // The gate between flattening the risk and releasing its hedge. Mirrors
      // the one in placeLiveOrder, and exists because the broker's RMS only
      // recognises a leg as gone once it has filled - not when the closing
      // order was accepted.
      if (side === "BUY" && shortCloseBrokerIds.length > 0 && !shortsFlat) {
        const outcome = await waitForOrderFills(shortCloseBrokerIds, dhan);
        if (!outcome.ok) {
          // Leave the wing alone. While the short is still live the wing is
          // doing its job, and selling it is the one thing that must not
          // happen here. The next sweep retries.
          legFailures.push(`${order.securityId}: wing left open - the short close ${outcome.detail}`);
          break;
        }
        shortsFlat = true;
      }

      const openPosition = await client.livePosition.findFirst({
        where: { accountId: group.accountId, securityId: order.securityId, status: "OPEN" }
      });
      if (!openPosition || !openPosition.netQty) continue;

      // Never place a second closing order for a contract that already has one
      // working. This is what makes a retry after a failure safe: the engine can
      // try again on the next sweep without any chance of doubling the position
      // the other way, which is a far worse outcome than a stop firing late.
      const inFlight = await client.liveOrder.count({
        where: {
          accountId: group.accountId,
          securityId: order.securityId,
          legRole: "CLOSE",
          status: { in: ["LOCAL_PENDING", "SENT", "OPEN", "PARTIAL", "UNKNOWN"] }
        }
      });
      if (inFlight > 0) {
        legFailures.push(`${order.securityId}: a closing order is already working`);
        continue;
      }

      try {
        const outcome = await squareOffForAccount(
          group.accountId,
          account.userId,
          openPosition.id,
          {
            // A LIMIT close is priced at the leg's current mark. MARKET sends none.
            ...(orderType === "LIMIT" ? { limitPrice: markFor(order.securityId) } : {}),
            // The rule that fired, and the sentence explaining it, so a closed
            // position can answer "why did the system do this" without anyone
            // reading a log.
            exitReason: decision.rule,
            exitDetail: decision.detail
          },
          client
        );
        // A REJECTED order does NOT throw - squareOffForAccount only throws
        // when the request itself failed, and a broker that accepts the call
        // and then refuses the order comes back through the normal return.
        // Counting that as a close is how a still-open position got reported
        // as AUTO_CLOSED on 2026-09-02: "Closed 1/1 legs" on a 24700 CE wing
        // that Dhan had rejected and which is still open.
        if (outcome.status === "REJECTED" || outcome.status === "CANCELLED") {
          legFailures.push(`${order.securityId}: the closing order was ${outcome.status} by the broker`);
          continue;
        }
        closedLegs += 1;
        if (side === "SELL" && outcome.brokerOrderId) {
          shortCloseBrokerIds.push(outcome.brokerOrderId);
        }
      } catch (error) {
        legFailures.push(`${order.securityId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The event records what actually happened, not what was intended. A
    // partially closed structure is the state most worth being able to see
    // afterwards, so it is reported as a failure even though some legs closed.
    const allClosed = closedLegs > 0 && legFailures.length === 0;
    await client.liveExitEvent.updateMany({
      where: { groupId, rule: decision.rule },
      data: {
        action: allClosed ? "AUTO_CLOSED" : "FAILED",
        detail: `${decision.detail} Closed ${closedLegs}/${sequenced.length} legs at ${orderType}.${
          legFailures.length ? ` Failures: ${legFailures.join("; ")}` : ""
        }`.slice(0, 500)
      }
    });

    if (allClosed) {
      sweep.autoClosed += 1;
    } else {
      sweep.failures.push(
        `${groupId}: ${decision.rule} fired, closed ${closedLegs}/${sequenced.length} legs. ${legFailures.join("; ")}`
      );
    }
  }

  return sweep;
}

// ------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------

/**
 * Every option contract this deployment currently holds live, for the feed.
 *
 * Union across ALL accounts, because market data is not account-specific: the
 * same contract held by three users is one subscription, not three. Dhan caps
 * instruments per feed connection, so the union is also the only shape that
 * scales past a handful of traders.
 */
/**
 * Remember the last mark seen for a contract, so it survives the feed going
 * quiet.
 *
 * Called from the reconcile sweep rather than from the read path. The API reads
 * positions once a second and the mark changes far less often than that, so
 * writing on read would be thirty database writes for one useful value - and it
 * would put a write on the hot path of a money screen for the sake of a display
 * nicety.
 *
 * Only ever moves forward in time: a stale cached tick must not overwrite a
 * newer stored one, which is why callers pass only marks the cache considered
 * fresh.
 */
export async function persistLastPrice(
  securityId: string,
  lastPrice: number,
  client: PrismaClient = prisma
): Promise<void> {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;
  await client.livePosition.updateMany({
    where: { securityId, status: "OPEN" },
    data: { lastPrice }
  });
}

export async function listLivePositionInstruments(
  client: PrismaClient = prisma
): Promise<Array<{ exchangeSegment: string; securityId: number }>> {
  const rows = await client.livePosition.findMany({
    where: { status: "OPEN" },
    select: { securityId: true, exchangeSegment: true },
    distinct: ["securityId", "exchangeSegment"]
  });
  return rows
    .map((row) => ({ exchangeSegment: row.exchangeSegment, securityId: Number(row.securityId) }))
    .filter((row) => Number.isFinite(row.securityId) && row.securityId > 0);
}

/**
 * A live last-traded price per securityId, however the caller can supply it.
 *
 * Passed in rather than fetched here so this package stays free of Redis - the
 * tick cache belongs to the apps, and @option-decode/db has no business opening
 * a second connection to it.
 */
export type LiveMarkLookup = (securityId: string) => number | undefined;

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
    autoExitEnabled: boolean;
  } | null;
  funds: DhanFundLimit | null;
  orders: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  /** Positions closed since midnight IST, with realised P&L. */
  closedToday: Array<Record<string, unknown>>;
  /** Exit rules that have fired and not yet been acted on. */
  exitAlerts: Array<{ groupId: string; rule: string; action: string; detail: string | null; createdAt: string }>;
}

// Funds barely move, and this endpoint is polled once a second. Without a cache
// that is 60 Dhan calls a minute per user for a number that changes on fills -
// which is both wasteful and a good way to meet a rate limit.
const FUNDS_CACHE_MS = 10_000;

// Delta changes only when the option-chain capture writes a new tick, which is
// every 30 seconds. Re-reading it on a 1-second poll asks the same question
// thirty times for one answer, so it is cached just inside that window.
const DELTA_CACHE_MS = 20_000;
const deltaCache = new Map<string, { delta: number | undefined; fetchedAt: number }>();
const fundsCache = new Map<string, { funds: DhanFundLimit; fetchedAt: number }>();

export function invalidateLiveFundsCache(userId: string): void {
  fundsCache.delete(userId);
  // The existing book's margin moves on exactly the events that move funds - a
  // fill, a square-off - so one invalidation clears both. Leaving the baseline
  // stale after a fill would price the next preview against the book as it was
  // before, which is the same double-count this pair exists to avoid.
  marginBaselineCache.delete(userId);
}

/**
 * Resolves live marks for a set of held contracts.
 *
 * Async and given the contracts, so the summary can be built in ONE pass:
 * positions are read once, handed here, and priced. The first version called
 * getLiveSummary twice - once to learn what was open, once to price it - which
 * duplicated the credential lookup, the funds read and both findMany calls on
 * every request. At a one-second poll that is the whole endpoint's cost paid
 * twice for nothing.
 */
export type LiveMarkResolver = (
  contracts: Array<{ securityId: string; exchangeSegment: string }>
) => Promise<LiveMarkLookup | undefined>;

export async function getLiveSummary(
  user: AuthUserDto,
  client: PrismaClient = prisma,
  resolveMarks?: LiveMarkResolver
): Promise<LiveSummary> {
  const credential = await getBrokerCredentialStatus(user, client);
  const account = await client.liveAccount.findFirst({ where: { userId: user.id, isActive: true } });

  let funds: DhanFundLimit | null = null;
  if (credential.present && credential.verifiedOk) {
    try {
      const cached = fundsCache.get(user.id);
      if (cached && Date.now() - cached.fetchedAt < FUNDS_CACHE_MS) {
        funds = cached.funds;
      } else {
        const dhan = await getUserDhanClient(user.id, client);
        funds = await dhan.getFundLimit("live:summary:funds");
        fundsCache.set(user.id, { funds, fetchedAt: Date.now() });
      }
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

  // Closed TODAY only. The whole history would grow without bound and is not
  // what anyone opens this panel for; the question being answered is "how did
  // today go".
  // Midnight IST, expressed as the UTC instant it corresponds to. Shifting into
  // IST, truncating the date there, then shifting back is the only version of
  // this that is obviously correct - mutating a Date with setUTCHours twice is
  // not, and the first draft of this was wrong.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const startOfDayIst = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - IST_OFFSET_MS
  );

  const closedToday = account
    ? await client.livePosition.findMany({
        where: { accountId: account.id, status: "CLOSED", closedAt: { gte: startOfDayIst } },
        orderBy: { closedAt: "desc" }
      })
    : [];

  // Recent exit flags. Capped and recent-first: this is a "what needs my
  // attention now" list, not a history.
  // Which open positions the exit engine can actually act on.
  //
  // The engine is deliberately narrow - it manages only complete structures this
  // app opened - and the consequence is that a position can sit there looking
  // managed while nothing is watching it. Working that out by hand means knowing
  // the group rules, and getting it wrong means believing a naked short is
  // covered when it is not. So it is computed once here and shown.
  //
  // Coverage needs all three: the position came from an order we placed, EVERY
  // leg of that order's group is still open, and auto-exit is actually on. With
  // auto-exit off the engine records and displays but never acts, which is not
  // protection.
  const engineCoveredPositionIds = new Set<string>();
  if (account?.autoExitEnabled && positions.length) {
    const openSecurityIds = new Set(positions.map((p) => p.securityId));
    const groupOrders = await client.liveOrder.findMany({
      where: { accountId: account.id, status: "TRADED", groupId: { not: null } },
      select: { groupId: true, securityId: true }
    });
    const legsByGroup = new Map<string, string[]>();
    for (const order of groupOrders) {
      const group = order.groupId as string;
      legsByGroup.set(group, [...(legsByGroup.get(group) ?? []), order.securityId]);
    }
    const completeGroups = new Set(
      [...legsByGroup.entries()]
        .filter(([, legs]) => legs.every((securityId) => openSecurityIds.has(securityId)))
        .map(([group]) => group)
    );
    const securityToGroup = new Map(groupOrders.map((o) => [o.securityId, o.groupId as string]));
    for (const position of positions) {
      const group = securityToGroup.get(position.securityId);
      if (group && completeGroups.has(group)) {
        engineCoveredPositionIds.add(position.id);
      }
    }
  }

  // Only for structures still OPEN. A rule that fired on a spread you have
  // since closed is history, not something needing attention - and leaving it
  // on screen trains people to ignore the one banner that must never be
  // ignored. Groups are matched through the orders that opened them, since a
  // reconciled position carries no groupId of its own.
  const openGroupIds = account
    ? new Set(
        (
          await client.liveOrder.findMany({
            where: {
              accountId: account.id,
              groupId: { not: null },
              status: "TRADED",
              securityId: {
                in: (
                  await client.livePosition.findMany({
                    where: { accountId: account.id, status: "OPEN" },
                    select: { securityId: true }
                  })
                ).map((p) => p.securityId)
              }
            },
            select: { groupId: true }
          })
        ).map((o) => o.groupId as string)
      )
    : new Set<string>();

  const exitAlerts =
    account && openGroupIds.size
      ? await client.liveExitEvent.findMany({
          where: { accountId: account.id, groupId: { in: [...openGroupIds] } },
          orderBy: { createdAt: "desc" },
          take: 10
        })
      : [];

  const accountDto = account
    ? {
        id: account.id,
        brokerClientId: account.brokerClientId,
        tradingEnabled: account.tradingEnabled,
        maxOrderMargin: Number(account.maxOrderMargin),
        maxOpenMargin: Number(account.maxOpenMargin),
        dailyLossLimit: Number(account.dailyLossLimit),
        maxMarginUtilPct: Number(account.maxMarginUtilPct),
        allowUndefinedRisk: account.allowUndefinedRisk,
        autoExitEnabled: account.autoExitEnabled
      }
    : null;

  // Delta per held contract, from the option-chain capture.
  //
  // NOT from the live feed: that runs in Quote mode and carries no Greeks at
  // all, so delta is only ever as fresh as the 30-second chain snapshot. That
  // is a real limitation rather than an oversight - the LTP beside it updates
  // every second and the delta does not, and the UI says so.
  //
  // KEYED ON (underlyingSymbol, expiryLabel, optionType, strikePrice), NOT on
  // securityId. OptionContractTick has no index on securityId - the five it has
  // are snapshotId, tickTime, and two composites leading with the underlying -
  // so a securityId lookup is a full scan of ~100 million rows. The first
  // version of this did exactly that, on an endpoint polled once a second. The
  // composite below is precisely the index that exists for this shape.
  //
  // A ZERO is treated as missing, never as a real value. Dhan zeroes delta on
  // roughly three-quarters of NIFTY option ticks - 358 of 462 on a 0-DTE expiry
  // when it was last measured - so showing 0.00 as a delta would be reporting
  // absent data as a flat position.
  const deltaByContract = new Map<string, number>();
  const priceable = positions.filter(
    (p) => p.underlyingSymbol && p.expiryLabel && p.optionType && p.strikePrice
  );
  if (priceable.length) {
    for (const position of priceable) {
      const cacheKey = `${position.underlyingSymbol}|${position.expiryLabel}|${position.optionType}|${String(position.strikePrice)}`;
      const cached = deltaCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < DELTA_CACHE_MS) {
        if (cached.delta !== undefined) deltaByContract.set(position.id, cached.delta);
        continue;
      }
      const row = await client.optionContractTick.findFirst({
        where: {
          underlyingSymbol: position.underlyingSymbol,
          expiryLabel: position.expiryLabel as string,
          optionType: position.optionType as OptionType,
          strikePrice: position.strikePrice as never
        },
        orderBy: { tickTime: "desc" },
        select: { deltaValue: true }
      });
      const value = row?.deltaValue ? row.deltaValue.toNumber() : 0;
      const usable = Number.isFinite(value) && value !== 0 ? value : undefined;
      // A MISS is cached too. Three-quarters of contracts have no usable delta,
      // and without caching the absence those are the ones re-queried every
      // single second, forever - the miss is the common case here, not the
      // exception.
      deltaCache.set(cacheKey, { delta: usable, fetchedAt: Date.now() });
      if (usable !== undefined) deltaByContract.set(position.id, usable);
    }
  }

  const serializedPositions = positions.map((position) => {
    const serialized = serializePosition(position);
    const delta = deltaByContract.get(String(position.id));
    // Annotated, or the object literal narrows away the index signature the
    // callers below rely on to read securityId and exchangeSegment.
    const withCoverage: Record<string, unknown> = {
      ...serialized,
      engineCovered: engineCoveredPositionIds.has(position.id)
    };
    if (delta !== undefined) withCoverage.delta = delta;
    return withCoverage;
  });
  const markFor = resolveMarks
    ? await resolveMarks(
        serializedPositions.map((position) => ({
          securityId: String(position.securityId ?? ""),
          exchangeSegment: String(position.exchangeSegment ?? "")
        }))
      )
    : undefined;

  return {
    enabled: liveTradingEnabledGlobally(),
    credential,
    account: accountDto,
    funds,
    orders: orders.map(serializeOrder),
    positions: serializedPositions.map((position) => applyLiveMark(position, markFor)),
    closedToday: closedToday.map(serializePosition),
    exitAlerts: exitAlerts.map((event) => ({
      groupId: event.groupId,
      rule: event.rule,
      action: String(event.action),
      detail: event.detail,
      createdAt: event.createdAt.toISOString()
    }))
  };
}

/**
 * Overlay a live price onto a reconciled position and recompute its unrealised
 * P&L.
 *
 * The reconciler refreshes positions from Dhan every 20 seconds; this makes the
 * MARK as fresh as the tick feed, without a broker call per refresh. Dhan's own
 * unrealised figure is kept whenever no live tick is available, so a quiet
 * contract or a cold cache degrades to the slower number rather than to a blank.
 *
 * Sign matters: netQty is negative for a short, so (last - cost) * netQty is
 * correct in both directions without a special case.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function applyLiveMark(position: Record<string, unknown>, markFor?: LiveMarkLookup): Record<string, unknown> {
  if (!markFor) return position;
  const last = markFor(String(position.securityId ?? ""));
  if (last === undefined || !Number.isFinite(last)) return position;

  const netQty = Number(position.netQty ?? 0);
  const cost = Number(position.avgCostPrice ?? 0);
  if (!netQty) return position;

  return {
    ...position,
    lastPrice: last,
    unrealizedPnl: round2((last - cost) * netQty),
    markSource: "LIVE_FEED"
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

/**
 * Pull the contract out of a broker trading symbol, e.g. "NIFTY-Sep2026-24800-CE".
 *
 * The reconciler stored only the underlying and left optionType, strikePrice and
 * expiryLabel null - which was invisible until square-off built a closing order
 * from them and produced "NIFTY 0 CE". Everything except the expiry date is
 * recoverable from this string, so it is parsed rather than left empty.
 *
 * The expiry token ("Sep2026") has no day in it, so it cannot become the
 * YYYY-MM-DD this app uses. That comes from the order that opened the position
 * instead; here it is deliberately left undefined rather than guessed.
 */
export function parseBrokerTradingSymbol(tradingSymbol: string | undefined): {
  underlyingSymbol?: string;
  strikePrice?: number;
  optionType?: OptionType;
} {
  if (!tradingSymbol) return {};
  const parts = tradingSymbol.split("-").filter(Boolean);
  const head = parts[0]?.toUpperCase();
  const result: { underlyingSymbol?: string; strikePrice?: number; optionType?: OptionType } = {
    underlyingSymbol: head || undefined
  };
  if (parts.length < 3) return result;

  const tail = parts[parts.length - 1]?.toUpperCase();
  if (tail === "CE" || tail === "PE") {
    result.optionType = tail;
    const strike = Number(parts[parts.length - 2]);
    if (Number.isFinite(strike) && strike > 0) {
      result.strikePrice = strike;
    }
  }
  return result;
}

/** Best-effort underlying from a broker trading symbol. */
function guessUnderlyingFromSymbol(tradingSymbol: string | undefined): string | undefined {
  return parseBrokerTradingSymbol(tradingSymbol).underlyingSymbol;
}

export { DhanApiError };

// Shared Strike Matrix -> Paper Trade Pro ticket derivation.
//
// This lives in its own module rather than in either panel because BOTH now
// need it and they already point at each other: the Strike Matrix panel
// imports the store function, and Paper Trade Pro needs the builder to
// pre-fill its ticket from the matrix without waiting for a "Paper Trade
// This" click. Importing the builder back out of the matrix panel would
// close that loop into a cycle.
//
// It is also the single source of truth for the regime -> structure mapping.
// Retyping that mapping in the ticket would let the two tabs disagree about
// what the same DRCR reading means, which is exactly the class of drift this
// repo keeps a single definition to avoid.

import type { StrikeMatrixResponse } from "./dashboard-client";
import type { TradingHorizon } from "@option-decode/types";

export type SimStrategyType =
  | "SHORT_STRADDLE"
  | "BULL_PUT_SPREAD"
  | "BEAR_CALL_SPREAD"
  | "IRON_CONDOR"
  | "NAKED_CALL"
  | "NAKED_PUT"
  | "SHORT_STRANGLE"
  | "IRON_BUTTERFLY";

export type SimHorizon = "INTRADAY" | "WEEKLY" | "MONTHLY";

// --- Signal handoff from the Strike Matrix tab ("Paper Trade This") ---
// The Strike Matrix panel stores a draft here and navigates to that tab;
// the ticket pre-fills from it on mount. sessionStorage (not state) so the
// handoff survives the tab switch without threading props through
// live-dashboard.
const SIM_TICKET_DRAFT_KEY = "option-decode:sim-ticket-draft";

export interface SimTicketDraft {
  underlyingSymbol: string;
  expiry: string;
  strategyType: SimStrategyType;
  horizon: SimHorizon;
  shortPutStrike?: number;
  shortCallStrike?: number;
  wci: number | null;
  drcr: number | null;
  signalRef: string;
  note?: string;
}

export function storeSimTicketDraft(draft: SimTicketDraft): void {
  try {
    sessionStorage.setItem(SIM_TICKET_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Session storage unavailable (private mode edge cases) - the user can
    // still build the ticket manually.
  }
}

export function takeSimTicketDraft(): SimTicketDraft | null {
  try {
    const raw = sessionStorage.getItem(SIM_TICKET_DRAFT_KEY);
    if (!raw) {
      return null;
    }
    sessionStorage.removeItem(SIM_TICKET_DRAFT_KEY);
    return JSON.parse(raw) as SimTicketDraft;
  } catch {
    return null;
  }
}

// How many strikes must actually contribute to a side's DRC before that
// side's regime is allowed to pick a structure automatically.
//
// This is not defensive padding. The horizon delta bands are narrow
// (intraday 0.15-0.25, weekly 0.12-0.20, monthly 0.08-0.15) and the feed
// zeroes delta on most of the chain, so the surviving universe is routinely
// tiny: measured live on NIFTY (2026-08-11, 462 ticks) the intraday band
// held exactly ONE put and ONE call, and the weekly band held NONE. A DRCR
// built from one strike against one strike is a coin flip wearing a label,
// and letting it silently choose the structure the ticket opens on would
// give it more weight than the whole-chain Dashboard bias gets.
//
// At the threshold the regime still shows in the UI - it just does not drive
// the default. Two is the floor because one strike per side cannot express a
// ratio at all.
export const MIN_DRC_STRIKES_FOR_AUTO_DEFAULT = 2;

export interface MatrixDefault {
  draft: SimTicketDraft | null;
  // Why the draft is null, or why it should not be trusted, in words the
  // panel can show verbatim. Null when the default applied cleanly.
  fallbackReason: string | null;
  putDrcCount: number;
  callDrcCount: number;
}

// Structure follows the sides the matrix says to write: put-only -> bull put
// spread, call-only -> bear call spread. Defined-risk defaults on purpose -
// the sim ticket lets the trader switch to the naked variant deliberately.
//
// Both sides written is IRON_CONDOR everywhere in STRIKE_MATRIX_HORIZONS
// (packages/analytics/src/strike-matrix.ts) except one specific cell:
// intraday+Neutral, whose own structure text is "Sell short strangle" (no
// condor mentioned at all - unlike weekly/monthly Neutral, which list
// "iron condor(s)" as the primary structure and strangle only as a
// secondary alternative). SHORT_STRANGLE exists as a Paper Trade Pro
// strategy specifically to make that one cell buildable; if that matrix
// table's text ever changes, this condition needs to move with it.
export function buildSimDraft(underlying: string, expiry: string, horizon: TradingHorizon, data: StrikeMatrixResponse): SimTicketDraft | null {
  const { analysis } = data;
  const recommendation = analysis.recommendation;
  if (!recommendation) {
    return null;
  }
  const hasPut = recommendation.putStrike !== undefined;
  const hasCall = recommendation.callStrike !== undefined;
  if (!hasPut && !hasCall) {
    return null;
  }
  const writesBothSides = hasPut && hasCall;
  const isIntradayNeutralStrangle = writesBothSides && horizon === "intraday" && analysis.bias === "Neutral";
  const strategyType: SimTicketDraft["strategyType"] = isIntradayNeutralStrangle
    ? "SHORT_STRANGLE"
    : writesBothSides
      ? "IRON_CONDOR"
      : hasPut
        ? "BULL_PUT_SPREAD"
        : "BEAR_CALL_SPREAD";
  // Only a wall that actually clears the conviction bar (meetsThreshold)
  // counts as institutional backing - a strongly negative (unwinding) WCI
  // used to win here via Math.abs() and get stamped onto the trade as
  // conviction, which is the literal opposite of what a negative WCI means.
  //
  // Restricted to the side(s) this structure actually WRITES: taking the
  // best of both walls meant a strong put wall could lend its conviction
  // to a call-only structure (and vice versa) - a wall on a side the trade
  // never sells is not backing for that trade. Uses the minimum across the
  // written legs rather than the maximum, so a two-legged structure is
  // reported only as backed as its weakest sold leg - the same rule
  // recommendation.wallBacked applies server-side, which requires EVERY
  // written side to qualify.
  const wallWcis = [hasCall ? analysis.callWall : undefined, hasPut ? analysis.putWall : undefined]
    .filter((wall): wall is NonNullable<typeof wall> => wall?.meetsThreshold === true)
    .map((wall) => wall.wci);
  const backedOnEveryWrittenSide = wallWcis.length === (writesBothSides ? 2 : 1);
  return {
    underlyingSymbol: underlying,
    expiry,
    strategyType,
    horizon: horizon === "intraday" ? "INTRADAY" : horizon === "weekly" ? "WEEKLY" : "MONTHLY",
    shortPutStrike: recommendation.putStrike,
    shortCallStrike: recommendation.callStrike,
    wci: backedOnEveryWrittenSide ? Math.min(...wallWcis) : null,
    drcr: analysis.drcr ?? null,
    signalRef: `${underlying}:${data.expiry}:${horizon}:${data.snapshotTime}`,
    note: `${analysis.bias} bias - ${recommendation.structure}`
  };
}

// The same derivation, plus the checks that decide whether it is solid
// enough to drive the ticket's opening state on its own. "Transitional" is
// deliberately excluded: in this app it is frequently produced by having no
// usable data at all rather than by a genuinely undecided market, so acting
// on it would dress an empty band up as a market read.
export function buildMatrixDefault(underlying: string, expiry: string, horizon: TradingHorizon, data: StrikeMatrixResponse): MatrixDefault {
  const { analysis } = data;
  const putDrcCount = analysis.putDrcCount;
  const callDrcCount = analysis.callDrcCount;
  const base = { putDrcCount, callDrcCount };

  const draft = buildSimDraft(underlying, expiry, horizon, data);
  if (!draft) {
    return { ...base, draft: null, fallbackReason: "no strike passed this horizon's delta band and liquidity gate" };
  }
  if (analysis.bias === "Transitional") {
    return { ...base, draft: null, fallbackReason: "regime is Transitional, which here usually means no usable delta data" };
  }

  // Only the sides this structure actually writes need a usable sample - a
  // thin put side is irrelevant to a call-only spread.
  const writtenCounts = [
    draft.shortPutStrike !== undefined ? putDrcCount : null,
    draft.shortCallStrike !== undefined ? callDrcCount : null
  ].filter((count): count is number => count !== null);
  const thinnest = Math.min(...writtenCounts);
  if (thinnest < MIN_DRC_STRIKES_FOR_AUTO_DEFAULT) {
    return {
      ...base,
      draft: null,
      fallbackReason: `only ${putDrcCount} put / ${callDrcCount} call ${putDrcCount + callDrcCount === 1 ? "strike" : "strikes"} contributed to the regime`
    };
  }
  return { ...base, draft, fallbackReason: null };
}

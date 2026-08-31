// Seller exit rules, as pure functions.
//
// ONE definition, so the simulator and the live engine cannot drift. Two copies
// of a stop rule that are supposed to agree is the class of bug this repo keeps
// single definitions to avoid - and it matters more here than anywhere else,
// because the whole argument for trusting a live stop is that it behaves the
// way the simulated one did.
//
// Nothing here touches a database, a broker or a clock it was not given. That
// is deliberate: a rule that decides whether to close a real position must be
// testable by handing it numbers, and every threshold below has to be
// reproducible from its inputs alone.

/** Profit target as a percentage of the credit received. */
export function profitTargetPct(structure: string): number {
  // A straddle's credit is large and its gamma risk near the money is brutal,
  // so it takes profit earlier than a spread does.
  return structure === "SHORT_STRADDLE" ? 30 : 50;
}

/** Close when the cost to buy the structure back reaches this multiple of the credit. */
export const HARD_STOP_MULTIPLE = 3;

/** Days to expiry at which gamma risk outweighs the remaining theta. */
export const DTE_GAMMA_THRESHOLD_DAYS = 7;

/**
 * Fallback stop when delta is unusable.
 *
 * Dhan zeroes delta on roughly three-quarters of NIFTY option ticks, so a
 * delta-based rule silently never fires on most contracts - which is worse than
 * having no rule, because it looks like protection. When a short leg has no
 * usable delta, its premium doubling stands in for the same idea: the market
 * has moved decisively against the writer.
 */
export const PREMIUM_2X_MULTIPLE = 2;

export type LiveExitRule =
  | "PROFIT_TARGET"
  | "HARD_STOP_3X"
  | "DTE_GAMMA"
  | "DELTA_2X"
  | "PREMIUM_2X"
  | "EXPIRY_TODAY";

export interface ExitLegState {
  side: "BUY" | "SELL";
  /** Per-unit premium received (SELL) or paid (BUY) at entry. */
  entryPrice: number;
  /** Per-unit price now. */
  lastPrice: number;
  /** Absolute delta at entry, when the feed gave a usable one. */
  entryDelta?: number;
  /** Absolute delta now, when the feed gives a usable one. */
  currentDelta?: number;
}

export interface ExitInput {
  structure: string;
  legs: ExitLegState[];
  /** Whole-position credit received at entry, in rupees. Positive for a seller. */
  netCredit: number;
  /** Contracts per leg (lots x lot size, or lots on MCX). */
  quantity: number;
  daysToExpiry: number;
  horizon?: "INTRADAY" | "WEEKLY" | "MONTHLY";
}

export interface ExitDecision {
  rule: LiveExitRule;
  detail: string;
}

/**
 * Cost to buy the whole structure back right now, in rupees.
 *
 * Sold legs cost their current price to repurchase; bought legs return theirs.
 * Signs are handled here rather than at call sites so a caller cannot get a
 * hedge the wrong way round.
 */
export function costToClose(legs: ExitLegState[], quantity: number): number {
  return legs.reduce((sum, leg) => sum + (leg.side === "SELL" ? leg.lastPrice : -leg.lastPrice) * quantity, 0);
}

/**
 * The first rule that fires, or null.
 *
 * ORDER IS THE POLICY, not an implementation detail. Profit is taken before a
 * stop is considered, because a structure at target is not in trouble however
 * wide one leg has run. Everything else is a reason to be out.
 */
export function evaluateExit(input: ExitInput): ExitDecision | null {
  const { legs, netCredit, quantity, daysToExpiry, structure } = input;
  if (!legs.length || quantity <= 0) return null;

  const closeCost = costToClose(legs, quantity);
  const pnl = netCredit - closeCost;

  // --- Profit target -------------------------------------------------------
  if (netCredit > 0) {
    const targetPct = profitTargetPct(structure);
    if (pnl >= (targetPct / 100) * netCredit) {
      return {
        rule: "PROFIT_TARGET",
        detail: `P&L ${Math.round(pnl)} is ${Math.round((pnl / netCredit) * 100)}% of the ${Math.round(netCredit)} credit (target ${targetPct}%).`
      };
    }
  }

  // --- Hard stop -----------------------------------------------------------
  if (netCredit > 0 && closeCost >= HARD_STOP_MULTIPLE * netCredit) {
    return {
      rule: "HARD_STOP_3X",
      detail: `Cost to close ${Math.round(closeCost)} is ${(closeCost / netCredit).toFixed(1)}x the ${Math.round(netCredit)} credit.`
    };
  }

  // --- Expiry ---------------------------------------------------------------
  // Separate from the gamma window: a position still open ON expiry day is not
  // a risk decision any more, it is an assignment decision.
  if (daysToExpiry <= 0) {
    return { rule: "EXPIRY_TODAY", detail: "Expires today - close rather than carry assignment risk." };
  }
  if (daysToExpiry <= DTE_GAMMA_THRESHOLD_DAYS) {
    return {
      rule: "DTE_GAMMA",
      detail: `${daysToExpiry} day(s) to expiry - inside the gamma window.`
    };
  }

  // --- Short leg blown out --------------------------------------------------
  for (const leg of legs) {
    if (leg.side !== "SELL") continue;

    // Delta first, when the feed actually gave us one at BOTH ends. A zero is
    // missing data, not a real delta, so it must never satisfy this.
    if (leg.entryDelta && leg.currentDelta && leg.entryDelta > 0) {
      if (Math.abs(leg.currentDelta) >= 2 * Math.abs(leg.entryDelta)) {
        return {
          rule: "DELTA_2X",
          detail: `Short leg delta ${Math.abs(leg.currentDelta).toFixed(2)} has doubled from ${Math.abs(leg.entryDelta).toFixed(2)} at entry.`
        };
      }
      continue;
    }

    // No usable delta - fall back to premium. Stated in the detail so nobody
    // reading an exit event has to guess which rule actually fired.
    if (leg.entryPrice > 0 && leg.lastPrice >= PREMIUM_2X_MULTIPLE * leg.entryPrice) {
      return {
        rule: "PREMIUM_2X",
        detail: `Short leg premium ${leg.lastPrice.toFixed(2)} is ${(leg.lastPrice / leg.entryPrice).toFixed(1)}x its ${leg.entryPrice.toFixed(2)} entry (delta unavailable, price fallback).`
      };
    }
  }

  return null;
}

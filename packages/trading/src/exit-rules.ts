// Seller exit rules, as pure functions.
//
// ONE definition for the LIVE engine. The simulator still carries its own copy
// in sim-repository.ts, because the extraction described in
// docs/live-order-module.md S8.2 was never finished.
//
// Those two numbers now deliberately DIFFER, and must not be "consolidated".
// Live is 1 day (see DTE_GAMMA_THRESHOLD_DAYS below). The simulator's 7 does
// double duty: a monthly-horizon gamma exit AND the expiry-week physical
// delivery ramp for stock options, which begins at E-4 and would be missed
// entirely by a one-day window. Same name, two meanings, and collapsing them
// would silently disable delivery-risk handling.
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

/**
 * Days to expiry at which gamma risk outweighs the remaining theta.
 *
 * ONE, and that is a correction rather than a tuning choice. It was 7, and 7
 * made weekly selling impossible: NIFTY weeklies expire every Tuesday, so the
 * near expiry is ALWAYS within seven days, and the engine closed every weekly
 * position on the first 20-second sweep after it opened. Measured on
 * 2026-09-02 - a 24100 CE sold at 51.80 at 11:49:51 was bought back at 52.15
 * at 11:50:20, thirty seconds later, six days from expiry, for a Rs 22.75 loss
 * the trader never chose.
 *
 * The rule means "you have HELD this into the gamma window", but it is
 * evaluated against any position sitting inside the window, so at 7 days it
 * read as "you may not enter the window at all". One day preserves the intent
 * - do not carry gamma risk into expiry - while leaving the week tradeable,
 * which is what this app is actually for. The app only holds current and next
 * week's chain data, so a threshold that excluded the near weekly excluded
 * most of what it can price.
 *
 * Note the entry-versus-drift confusion is narrowed by this, not resolved: a
 * position opened WITH one day to expiry is still closed on the next sweep.
 * Firing only when openedAt precedes the window is the real fix.
 */
export const DTE_GAMMA_THRESHOLD_DAYS = 1;

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

/**
 * How urgently a fired rule wants to be out, expressed as an order type.
 *
 * MARKET where being out matters more than the price. A hard stop that rests as
 * an unfilled limit is not a stop - the whole reason it fired is that the market
 * moved decisively, which is exactly when a limit at the last print does not get
 * hit. Same for a short leg blown out on delta or premium, and for expiry day,
 * where the alternative to filling is assignment.
 *
 * LIMIT where there is no urgency and paying the spread is the larger cost. A
 * profit target is a good outcome being harvested; if it does not fill this
 * minute it fills the next, or the rule fires again. The gamma window is a
 * days-long condition, not a seconds-long one.
 *
 * Note this is the type for a CLOSING order placed once the condition has
 * already been detected - not a resting stop-loss order left with the broker.
 * Those are different things, and conflating them is how a stop ends up
 * triggering on a price that has already gone.
 */
export function closeOrderTypeFor(rule: LiveExitRule): "MARKET" | "LIMIT" {
  switch (rule) {
    case "HARD_STOP_3X":
    case "DELTA_2X":
    case "PREMIUM_2X":
    case "EXPIRY_TODAY":
      return "MARKET";
    case "PROFIT_TARGET":
    case "DTE_GAMMA":
      return "LIMIT";
  }
}

/**
 * The order legs must be closed in, most urgent first.
 *
 * SHORT legs before long ones, always. Closing a spread's long wing first leaves
 * the account momentarily NAKED SHORT - briefly unbounded risk, and a margin
 * requirement several times larger, on a position that was defined-risk a second
 * earlier. If only one of the two closes, it must be the one that removes risk
 * rather than the one that adds it.
 */
export function orderCloseSequence<T extends { side: "BUY" | "SELL" }>(legs: T[]): T[] {
  return [...legs].sort((a, b) => (a.side === "SELL" ? 0 : 1) - (b.side === "SELL" ? 0 : 1));
}

/**
 * The order legs must be OPENED in, safest first.
 *
 * BUY legs before SELL ones - the exact mirror of orderCloseSequence, and for
 * the same reason. Selling first and then failing to buy the wing leaves the
 * account NAKED SHORT: unbounded risk on a structure that was meant to be
 * defined-risk, and a margin requirement measured on this account at
 * Rs 1,39,063 naked against Rs 1,03,458 as a spread. Buying first and then
 * failing to sell leaves a long option - bounded loss, and the premium is the
 * worst case.
 *
 * Put another way: whichever leg fails, the account should be left holding the
 * safer half. On entry the hedge is the safer half; on exit it is the short.
 *
 * A naked structure has no BUY leg, so this is a no-op for it - there is no
 * hedge to establish and nothing to wait for.
 */
export function orderOpenSequence<T extends { side: "BUY" | "SELL" }>(legs: T[]): T[] {
  return [...legs].sort((a, b) => (a.side === "BUY" ? 0 : 1) - (b.side === "BUY" ? 0 : 1));
}

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

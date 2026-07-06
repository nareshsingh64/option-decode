import type { OptionType } from "@option-decode/types";

/**
 * A from-scratch Black-Scholes engine for Indian index options (NIFTY,
 * BANKNIFTY, etc. are European-style, cash-settled — the model this
 * assumes). Built specifically to answer one question the naive
 * "strike ± premium" breakeven can't: given the time value STILL left in
 * an option's premium, how far does the underlying actually need to move
 * right now to break even, as opposed to at expiry?
 *
 * Two assumptions are baked in rather than sourced live, since the app has
 * no feed for either:
 * - DEFAULT_RISK_FREE_RATE: a static approximation of the short-term India
 *   T-bill yield. Black-Scholes is not very sensitive to this input over
 *   the short (days-to-weeks) durations these are index options trade at,
 *   so a static value is a reasonable simplification.
 * - DEFAULT_IMPLIED_VOLATILITY: only used when a tick has no IV of its own
 *   (should be rare — the option chain feed provides per-strike IV in the
 *   normal case, which is what's used whenever available).
 */

export const DEFAULT_RISK_FREE_RATE = 0.065;
export const DEFAULT_IMPLIED_VOLATILITY = 0.15;

// Floor on time-to-expiry (in years) fed into the model. Black-Scholes
// divides by sqrt(T), so T=0 (exactly at/after expiry) blows up rather than
// gracefully degrading to intrinsic value. One hour is small enough to make
// the time-value contribution negligible without risking a divide-by-zero.
const MIN_YEARS_TO_EXPIRY = 1 / (365 * 24);

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// NSE index options expire at market close (15:30 IST = 10:00 UTC) on the
// expiry date, not at midnight — using midnight would overstate time value
// by up to a full trading day on the expiry date itself.
const MARKET_CLOSE_UTC_HOUR = 10;

/**
 * Years remaining until expiry, measured from `asOfMs` to 15:30 IST on the
 * expiry date. `expiryLabel` is the ISO date string ("2026-07-31") used
 * throughout this codebase as OptionChainSnapshot.expiry — see
 * expiryLabelToContractMonth() in @option-decode/db for the same parsing
 * convention. Returns the MIN_YEARS_TO_EXPIRY floor (rather than a
 * negative or zero value) if the label can't be parsed or expiry has
 * already passed.
 */
export function getYearsToExpiry(expiryLabel: string, asOfMs: number): number {
  const parsed = new Date(`${expiryLabel}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return MIN_YEARS_TO_EXPIRY;
  }

  const expiryMoment = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), MARKET_CLOSE_UTC_HOUR, 0, 0);
  const years = (expiryMoment - asOfMs) / MS_PER_YEAR;
  return Math.max(years, MIN_YEARS_TO_EXPIRY);
}

// Abramowitz-Stegun approximation of the standard normal CDF — accurate to
// ~1e-7, well within the precision that matters for a premium/spot number
// rounded to the nearest tick size.
function standardNormalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

function d1d2(spot: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number): { d1: number; d2: number } {
  const sqrtT = Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + (volatility * volatility) / 2) * yearsToExpiry) / (volatility * sqrtT);
  return { d1, d2: d1 - volatility * sqrtT };
}

/** Theoretical option price under Black-Scholes. */
export function blackScholesPrice(optionType: OptionType, spot: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number): number {
  if (spot <= 0 || strike <= 0 || volatility <= 0) {
    return 0;
  }

  const { d1, d2 } = d1d2(spot, strike, yearsToExpiry, riskFreeRate, volatility);
  const discountedStrike = strike * Math.exp(-riskFreeRate * yearsToExpiry);

  if (optionType === "CE") {
    return Math.max(0, spot * standardNormalCdf(d1) - discountedStrike * standardNormalCdf(d2));
  }
  return Math.max(0, discountedStrike * standardNormalCdf(-d2) - spot * standardNormalCdf(-d1));
}

/** Black-Scholes delta — used as a fallback whenever a tick's own delta
 * from the broker feed is missing, in place of a flat guessed constant. */
export function blackScholesDelta(optionType: OptionType, spot: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number): number {
  if (spot <= 0 || strike <= 0 || volatility <= 0) {
    return 0;
  }

  const { d1 } = d1d2(spot, strike, yearsToExpiry, riskFreeRate, volatility);
  return optionType === "CE" ? standardNormalCdf(d1) : standardNormalCdf(d1) - 1;
}

/**
 * Solves for the underlying spot price at which the option's CURRENT
 * theoretical value (i.e. with time value intact, not just intrinsic
 * value at expiry) equals `targetPremium` — the premium actually paid.
 * This is the "true" breakeven for someone planning to exit before
 * expiry, and is always a smaller required move than the naive
 * strike-plus-premium expiry breakeven, because the option's time value
 * covers part of the distance.
 *
 * Bisection rather than Newton-Raphson: Black-Scholes price is monotonic
 * in spot (strictly increasing for calls, strictly decreasing for puts),
 * so bisection is guaranteed to converge given a bracket that contains the
 * root, without needing a derivative or a good starting guess.
 */
export function solveBreakevenSpot(optionType: OptionType, strike: number, targetPremium: number, yearsToExpiry: number, riskFreeRate: number, volatility: number): number | undefined {
  if (targetPremium <= 0 || strike <= 0) {
    return undefined;
  }

  const priceAt = (spot: number) => blackScholesPrice(optionType, spot, strike, yearsToExpiry, riskFreeRate, volatility);

  let lo = Math.max(0.01, strike * 0.1);
  let hi = strike * 10;
  const priceAtLo = priceAt(lo) - targetPremium;
  const priceAtHi = priceAt(hi) - targetPremium;

  // Calls: price increases with spot, so priceAtLo should be negative and
  // priceAtHi positive. Puts: the reverse. Either way, the product of the
  // two endpoints must be negative for the root to be inside the bracket -
  // if it isn't (a degenerate/extreme input), bail out rather than return
  // a bisection result with no real guarantee behind it.
  if (priceAtLo * priceAtHi > 0) {
    return undefined;
  }

  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const priceAtMid = priceAt(mid) - targetPremium;

    if (Math.abs(priceAtMid) < 0.005) {
      return mid;
    }

    if (Math.sign(priceAtMid) === Math.sign(priceAtLo)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return (lo + hi) / 2;
}

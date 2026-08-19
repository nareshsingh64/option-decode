import {
  MCX_SESSION_CLOSE_IST_MINUTES,
  MCX_SESSION_OPEN_IST_MINUTES,
  NSE_SESSION_CLOSE_IST_MINUTES,
  NSE_SESSION_OPEN_IST_MINUTES
} from "@option-decode/types";

/**
 * Today's calendar date in IST as YYYY-MM-DD - for comparing against
 * expiry strings (always calendar dates, not instants), not for display.
 */
// Hoisted, like every other Intl formatter in this repo. Constructing one
// allocates ICU state in C++ that Node's own memory APIs cannot see; doing it
// per call inside a loop is what caused the worker's memory spikes (see
// analytics/wave-screener.ts). These two are not per-row paths, but
// isMarketSessionOpen runs on every job and every request, and there is no
// reason to pay for a formatter that never varies.
const IST_DATE_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const IST_SESSION_PARTS_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

export function todayIstDateKey(now = new Date()): string {
  return IST_DATE_KEY_FORMAT.format(now);
}

/**
 * True when `expiry` (YYYY-MM-DD) is a calendar date strictly before today
 * in IST. ISO date strings compare correctly with plain string comparison,
 * so no Date parsing/timezone arithmetic is needed. Used to reject
 * obviously-stale client-supplied expiry params (e.g. a browser tab left
 * open for weeks, still polling with a long-expired expiry) before wasting
 * a live upstream API call on a date that can only ever fail.
 */
export function isExpiryInPast(expiry: string, now = new Date()): boolean {
  return expiry < todayIstDateKey(now);
}

export function isMarketSessionOpen(segment: string, now = new Date()) {
  const istParts = IST_SESSION_PARTS_FORMAT.formatToParts(now);
  const weekday = istParts.find((part) => part.type === "weekday")?.value;
  if (weekday === "Sat" || weekday === "Sun") {
    return false;
  }

  const hour = Number(istParts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(istParts.find((part) => part.type === "minute")?.value ?? 0);
  const minutesSinceMidnight = hour * 60 + minute;

  if (segment === "MCX_COMM") {
    return minutesSinceMidnight >= MCX_SESSION_OPEN_IST_MINUTES && minutesSinceMidnight <= MCX_SESSION_CLOSE_IST_MINUTES;
  }

  return minutesSinceMidnight >= NSE_SESSION_OPEN_IST_MINUTES && minutesSinceMidnight <= NSE_SESSION_CLOSE_IST_MINUTES;
}

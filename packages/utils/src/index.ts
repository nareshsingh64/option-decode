/**
 * Today's calendar date in IST as YYYY-MM-DD - for comparing against
 * expiry strings (always calendar dates, not instants), not for display.
 */
export function todayIstDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
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
  const istParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const weekday = istParts.find((part) => part.type === "weekday")?.value;
  if (weekday === "Sat" || weekday === "Sun") {
    return false;
  }

  const hour = Number(istParts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(istParts.find((part) => part.type === "minute")?.value ?? 0);
  const minutesSinceMidnight = hour * 60 + minute;

  if (segment === "MCX_COMM") {
    return minutesSinceMidnight >= 9 * 60 && minutesSinceMidnight <= 23 * 60 + 30;
  }

  return minutesSinceMidnight >= 9 * 60 + 15 && minutesSinceMidnight <= 15 * 60 + 30;
}

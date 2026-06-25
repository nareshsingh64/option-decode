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

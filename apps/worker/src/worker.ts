import { loadConfig } from "@option-decode/config";
import { buildDemoSnapshot, saveOptionChainSnapshot } from "@option-decode/db";
import { DhanClient, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { UnderlyingDefinition } from "@option-decode/types";

const config = loadConfig();

const dhan = new DhanClient({
  baseUrl: config.DHAN_API_BASE_URL,
  clientId: config.DHAN_CLIENT_ID,
  accessToken: config.DHAN_ACCESS_TOKEN
});

console.log("Option Decode worker starting", {
  underlyings: config.feedUnderlyings,
  intervalMs: config.SNAPSHOT_INTERVAL_MS,
  dhanConfigured: Boolean(dhan),
  mockMarketFeedEnabled: config.MOCK_MARKET_FEED_ENABLED
});

async function captureOnce() {
  if (config.MOCK_MARKET_FEED_ENABLED) {
    if (!isSnapshotWindowOpen("IDX_I")) {
      console.log("Skipping mock market snapshot outside 09:15-15:30 IST storage window", {
        checkedAt: new Date().toISOString()
      });
      return;
    }

    const snapshot = buildDemoSnapshot();
    const snapshotId = await saveOptionChainSnapshot(snapshot);
    console.log("Saved mock market snapshot", {
      snapshotId,
      underlying: snapshot.underlyingSymbol,
      expiry: snapshot.expiry,
      ticks: snapshot.ticks.length
    });
    return;
  }

  const underlyings = config.feedUnderlyings
    .map((configuredUnderlying) => getUnderlyingDefinition(normalizeUnderlyingKey(configuredUnderlying)))
    .filter((underlying): underlying is UnderlyingDefinition => Boolean(underlying));
  const quoteOverrides = await getSpotPriceOverrides(underlyings.filter((underlying) => isSnapshotWindowOpen(underlying.segment)));

  for (const configuredUnderlying of config.feedUnderlyings) {
    const underlyingKey = normalizeUnderlyingKey(configuredUnderlying);
    const underlying = getUnderlyingDefinition(underlyingKey);
    if (!underlying) {
      console.warn("Skipping unsupported underlying", { underlyingKey });
      continue;
    }

    if (!isSnapshotWindowOpen(underlying.segment)) {
      console.log("Skipping market snapshot outside segment storage window", {
        underlying: underlyingKey,
        segment: underlying.segment,
        checkedAt: new Date().toISOString()
      });
      continue;
    }

    const expiries = await dhan.getExpiryList(underlying);
    const expiry = expiries[0];
    if (!expiry) {
      console.warn("Skipping underlying with no expiry", { underlyingKey });
      continue;
    }

    const snapshot = await dhan.getOptionChain({ underlying, expiry, spotPriceOverride: quoteOverrides.get(underlying.key) });
    const snapshotId = await saveOptionChainSnapshot(snapshot);
    console.log("Saved Dhan market snapshot", {
      snapshotId,
      underlying: snapshot.underlyingSymbol,
      expiry: snapshot.expiry,
      ticks: snapshot.ticks.length
    });
  }
}

async function getSpotPriceOverrides(underlyings: UnderlyingDefinition[]) {
  const quoteUnderlyings = underlyings.filter((underlying) => underlying.quoteSecurityId);
  if (!quoteUnderlyings.length) {
    return new Map<string, number>();
  }

  try {
    const quotes = await dhan.getOhlcQuotes(quoteUnderlyings);
    return new Map(
      quoteUnderlyings
        .map((underlying) => [underlying.key, quotes.get(underlying.key)?.lastPrice] as const)
        .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number")
    );
  } catch (error) {
    console.warn("Unable to fetch futures quote overrides; option-chain spot prices may use generic underlyings", error);
    return new Map<string, number>();
  }
}

function isSnapshotWindowOpen(segment: string, now = new Date()) {
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

captureOnce().catch((error: unknown) => {
  console.error("Initial market capture failed", error);
});

setInterval(() => {
  captureOnce().catch((error: unknown) => {
    console.error("Market capture failed", error);
  });
}, config.SNAPSHOT_INTERVAL_MS);

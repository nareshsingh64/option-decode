import { calculatePressureScore, generateMarketAlerts } from "@option-decode/analytics";
import { loadConfig } from "@option-decode/config";
import { buildDemoSnapshot, disablePushSubscriptionByEndpoint, getOpenPositionsForMarginGroup, getOptionChainTrackedStocks, getUserAlertThreshold, listActiveFnoStocks, listActivePushSubscriptions, listExpiriesNeedingLiveData, logDhanApiRequest, monitorPaperTradingForSnapshot, pruneMarketDataBefore, recordPositionMargin, saveOptionChainSnapshot } from "@option-decode/db";
import type { FilledPaperLeg } from "@option-decode/db";
import { DhanClient, DhanLiveFeedClient, getFnoExchangeSegment, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { DhanLiveFeedExchangeSegment, DhanLiveFeedInstrument, DhanOhlcQuote } from "@option-decode/dhan";
import type { MarketAlert, OptionChainSnapshot, UnderlyingDefinition } from "@option-decode/types";
import { isMarketSessionOpen } from "@option-decode/utils";
import { Job, Queue, QueueEvents, Worker as BullWorker } from "bullmq";
import Redis from "ioredis";
import webpush from "web-push";
import { cacheLiveTick, getLiveTick } from "./live-tick-cache.js";
import { startSimEodScheduler } from "./sim-eod-mtm.js";
import { startWaveScreener } from "./wave-screener.js";

const config = loadConfig();
const MARKET_SNAPSHOT_QUEUE = "market-snapshot";
const CAPTURE_JOB_NAME = "capture";
const SCHEDULER_ID = "market-snapshot:capture";
const SNAPSHOT_RETENTION_QUEUE = "snapshot-retention";
const RETENTION_JOB_NAME = "cleanup";
const RETENTION_SCHEDULER_ID = "snapshot-retention:cleanup";
const MARKET_SNAPSHOT_SAVED_CHANNEL = "market:snapshot:saved";
const PUSH_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const snapshotRepeatOptions = config.SNAPSHOT_CRON_PATTERN
  ? { pattern: config.SNAPSHOT_CRON_PATTERN }
  : { every: config.SNAPSHOT_INTERVAL_MS };
const redisConnection = {
  url: config.REDIS_URL,
  maxRetriesPerRequest: null
};
const redisPublisher = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true
});
const pushNotificationsEnabled = Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
// Cooldown state lives in Redis (via redisPublisher, already connected
// below), not an in-process Map - the worker restarts every 15 minutes (see
// MEMORY_LOG_INTERVAL_MS/the memory-leak mitigation timer), the same
// cadence as PUSH_ALERT_COOLDOWN_MS itself, so an in-process Map reset the
// cooldown on roughly the schedule it was meant to enforce, confirmed live.
function pushCooldownKey(userId: string, alertId: string): string {
  return `push-alert-cooldown:${userId}:${alertId}`;
}
// gammaRisk always wins the push slot when multiple critical alerts fire
// at once - it's the single highest-stakes warning the app sends (expiry-
// day pin risk) and previously lost every tie to whichever alert type
// (bearish/bullish pressure, then PCR) happened to sort earlier in
// generateMarketAlerts' fixed return order.
const PUSH_ALERT_PRIORITY: Record<string, number> = { gammaRisk: 0 };
function pushAlertPriority(alert: MarketAlert): number {
  return PUSH_ALERT_PRIORITY[alert.metric] ?? 1;
}

if (pushNotificationsEnabled) {
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY as string, config.VAPID_PRIVATE_KEY as string);
}

// 20s, not the 2 minutes this used to sample at. The thing being measured is
// a BURST, and 2-minute sampling could not resolve it: it caught the spike in
// roughly one sample in three and missed the rise and fall entirely, which is
// how "RSS grows unboundedly" survived as a description for so long.
const MEMORY_LOG_INTERVAL_MS = 20 * 1000;

/**
 * Node/V8 memory breakdown, plus the number that actually matters here.
 *
 * What this instrumentation established (production, 2026-08-11, samples
 * across a full 15-minute cycle):
 *
 *   RSS=2907MB  heapUsed=133MB  heapTotal=163MB  external=9.4MB  arrayBuffers=2.3MB
 *   RSS= 225MB  heapUsed= 82MB  heapTotal=115MB  external=7.9MB  arrayBuffers=0.7MB
 *
 * Two conclusions follow, and both contradict earlier theories in CLAUDE.md:
 *
 * 1. **It is not a JS heap problem.** heapTotal never exceeds ~165MB while
 *    RSS reaches 2.9GB. `--max-old-space-size` therefore does nothing here -
 *    the cap would never bind. Don't reach for it.
 * 2. **It is not a leak.** RSS returns to ~225MB on its own, repeatedly. The
 *    memory IS released. What the box cannot survive is the transient PEAK
 *    (~2.9GB on a 3.8GB host shared with api/web/MySQL/Redis), not a ratchet.
 *
 * `nativeGapMb` is RSS minus everything Node can account for, so the split
 * above is visible directly in the log instead of having to be recomputed by
 * hand each time. It is the quantity to watch: it swings ~100MB -> ~2.7GB.
 * `external`/`arrayBuffers` stay under 10MB throughout, which also rules out
 * the DhanLiveFeedClient ArrayBuffer theory that motivated the original
 * version of this logging - those would show up there, and they don't.
 */
function logWorkerMemory(label: string, extra?: Record<string, unknown>): void {
  const mem = process.memoryUsage();
  const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  // Everything RSS holds that Node cannot attribute to the JS heap or to
  // its own external/ArrayBuffer accounting - i.e. native allocations.
  const nativeGapMb = toMb(mem.rss - mem.heapTotal - mem.external - mem.arrayBuffers);
  console.log("Worker memory usage", {
    at: label,
    rssMb: toMb(mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers),
    nativeGapMb,
    ...extra
  });
}

setInterval(() => logWorkerMemory("interval"), MEMORY_LOG_INTERVAL_MS).unref();

const dhan = new DhanClient({
  baseUrl: config.DHAN_API_BASE_URL,
  clientId: config.DHAN_CLIENT_ID,
  accessToken: config.DHAN_ACCESS_TOKEN,
  // Fire-and-forget audit log of every Dhan request this worker makes -
  // see DhanApiRequestLog in @option-decode/db. Not awaited, and wrapped
  // so a DB hiccup here can never surface as if the Dhan call itself
  // failed.
  onRequest: (event) => {
    logDhanApiRequest(event).catch((error) => {
      console.warn("Failed to write Dhan API request audit log", { error, caller: event.caller });
    });
  }
});

console.log("Option Decode worker starting", {
  underlyings: config.feedUnderlyings,
  intervalMs: config.SNAPSHOT_INTERVAL_MS,
  cronPattern: config.SNAPSHOT_CRON_PATTERN,
  dhanConfigured: Boolean(dhan),
  mockMarketFeedEnabled: config.MOCK_MARKET_FEED_ENABLED,
  liveMarketFeedEnabled: config.LIVE_MARKET_FEED_ENABLED,
  queue: MARKET_SNAPSHOT_QUEUE,
  retentionDays: config.SNAPSHOT_RETENTION_DAYS,
  pushNotificationsEnabled
});

// Dhan Live Market Feed (WebSocket) - see @option-decode/dhan/live-feed.ts
// for the protocol implementation and its own header comment for scope
// (Quote mode only, no Greeks, not a replacement for option-chain REST
// capture). Construction is always cheap/side-effect-free (no connection
// opens until .connect() is called below, gated on
// LIVE_MARKET_FEED_ENABLED) - keeping the client itself unconditional
// avoids threading an `| undefined` through every call site that reads
// from its tick cache.
const LIVE_FEED_RESYNC_INTERVAL_MS = 30 * 60 * 1000;
const KNOWN_LIVE_FEED_SEGMENTS = new Set<DhanLiveFeedExchangeSegment>(["IDX_I", "NSE_EQ", "NSE_FNO", "NSE_CURRENCY", "BSE_EQ", "MCX_COMM", "BSE_CURRENCY", "BSE_FNO"]);

function toLiveFeedSegment(segment: string): DhanLiveFeedExchangeSegment | undefined {
  return KNOWN_LIVE_FEED_SEGMENTS.has(segment as DhanLiveFeedExchangeSegment) ? (segment as DhanLiveFeedExchangeSegment) : undefined;
}

const liveFeed = new DhanLiveFeedClient({
  accessToken: config.DHAN_ACCESS_TOKEN,
  clientId: config.DHAN_CLIENT_ID,
  onTick: (tick) => {
    cacheLiveTick(redisPublisher, tick).catch((error) => {
      console.warn("Failed to cache Dhan live feed tick", { error, segment: tick.exchangeSegment, securityId: tick.securityId });
    });
  },
  onStatus: (status) => {
    console.log("Dhan live feed status", status);
  }
});

// Builds the desired subscription set from the same two universes REST
// polling already covers - config.feedUnderlyings (resolved through
// resolveQuoteUnderlyings so MCX commodities subscribe to their futures
// proxy contract, exactly like getOhlcQuotes/getSpotPriceOverrides
// already do) plus the active F&O stock universe (NSE_EQ). Safe to call
// repeatedly - DhanLiveFeedClient.subscribe() is additive/idempotent, so
// this also picks up F&O universe changes and MCX futures month-rollovers
// on each periodic call without needing to diff anything itself.
async function resyncLiveFeedSubscriptions() {
  try {
    const underlyings = config.feedUnderlyings
      .map((configuredUnderlying) => getUnderlyingDefinition(normalizeUnderlyingKey(configuredUnderlying)))
      .filter((underlying): underlying is UnderlyingDefinition => Boolean(underlying));
    const resolvedUnderlyings = await dhan.resolveQuoteUnderlyings(underlyings);
    const indexInstruments: DhanLiveFeedInstrument[] = resolvedUnderlyings
      .map((underlying) => {
        const segment = toLiveFeedSegment(underlying.quoteSegment ?? underlying.segment);
        return segment ? { exchangeSegment: segment, securityId: underlying.quoteSecurityId ?? underlying.securityId } : undefined;
      })
      .filter((instrument): instrument is DhanLiveFeedInstrument => Boolean(instrument));

    const stocks = await listActiveFnoStocks();
    const stockInstruments: DhanLiveFeedInstrument[] = stocks
      .filter((stock): stock is typeof stock & { securityId: number } => stock.securityId !== undefined)
      .map((stock) => ({ exchangeSegment: "NSE_EQ" as const, securityId: stock.securityId }));

    liveFeed.subscribe([...indexInstruments, ...stockInstruments]);
  } catch (error) {
    console.warn("Unable to resync Dhan live feed subscriptions", { error });
  }
}

type MarketSnapshotJobData = {
  trigger: "startup" | "scheduled";
};

// Front-month/front-week expiry lists change at most once a week (index
// weeklies) or once a month (stocks/MCX commodities), and only overnight
// after the prior expiry settles - never mid-session. Fetching this fresh
// from Dhan on every 30s captureOnce() cycle, for every underlying, was
// pure waste: the DhanApiRequestLog audit (2026-07-29) showed
// worker:index-capture:expiry-list alone was ~26% of all Dhan traffic.
// Cache it in-process per underlying; worst case staleness is a brand-new
// expiry taking up to EXPIRY_LIST_CACHE_MS to appear, which is harmless
// since the existing front expiry stays valid until it actually settles.
// A failed fetch is never cached, so a 429 here just retries next cycle
// same as before.
const EXPIRY_LIST_CACHE_MS = 60 * 60 * 1000;
const expiryListCache = new Map<string, { expiresAt: number; value: string[] }>();

async function getCachedExpiryList(underlying: UnderlyingDefinition, caller: string): Promise<string[]> {
  const cached = expiryListCache.get(underlying.key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const expiries = await dhan.getExpiryList(underlying, caller);
  expiryListCache.set(underlying.key, { expiresAt: Date.now() + EXPIRY_LIST_CACHE_MS, value: expiries });
  return expiries;
}

async function captureOnce() {
  if (config.MOCK_MARKET_FEED_ENABLED) {
    if (!isMarketSessionOpen("IDX_I")) {
      console.log("Skipping mock market snapshot outside the NSE 09:14-15:41 IST storage window", {
        checkedAt: new Date().toISOString()
      });
      return;
    }

    const snapshot = buildDemoSnapshot();
    const snapshotId = await saveOptionChainSnapshot(snapshot);
    await monitorPaperTrading(snapshot);
    await publishSnapshotSaved(snapshotId, snapshot);
    await sendCriticalPushAlerts(snapshot);
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
  const quoteOverrides = await getSpotPriceOverrides(underlyings.filter((underlying) => isMarketSessionOpen(underlying.segment)));

  for (const configuredUnderlying of config.feedUnderlyings) {
    const underlyingKey = normalizeUnderlyingKey(configuredUnderlying);
    const underlying = getUnderlyingDefinition(underlyingKey);
    if (!underlying) {
      console.warn("Skipping unsupported underlying", { underlyingKey });
      continue;
    }

    if (!isMarketSessionOpen(underlying.segment)) {
      console.log("Skipping market snapshot outside segment storage window", {
        underlying: underlyingKey,
        segment: underlying.segment,
        checkedAt: new Date().toISOString()
      });
      continue;
    }

    // This primary current-expiry capture used to be unguarded, unlike
    // every other step in this function (next-expiry below, extra
    // expiries for paper trading, stock option chains). One Dhan failure
    // here (e.g. a 429) would propagate all the way out of captureOnce(),
    // failing the WHOLE BullMQ job and triggering its full retry (attempts:
    // 3) - which re-runs captureOnce() from the top, re-fetching every
    // underlying that had already succeeded this cycle. A single rate-limit
    // hit on one underlying was turning into up to 3x the Dhan traffic for
    // the entire cycle, which is what was sustaining a self-reinforcing
    // 429 pattern in production (2026-07-29, see incident notes). Now a
    // failure here just skips this one underlying for this one cycle, the
    // same resilience already used everywhere else in this function.
    let expiries: string[];
    let expiry: string | undefined;
    try {
      expiries = await getCachedExpiryList(underlying, "worker:index-capture:expiry-list");
      expiry = expiries[0];
    } catch (error) {
      console.warn("Unable to fetch expiry list for underlying; skipping this cycle", { underlyingKey, error });
      continue;
    }
    if (!expiry) {
      console.warn("Skipping underlying with no expiry", { underlyingKey });
      continue;
    }

    let snapshot: OptionChainSnapshot;
    try {
      snapshot = await dhan.getOptionChain({ underlying, expiry, spotPriceOverride: quoteOverrides.get(underlying.key), caller: "worker:index-capture:current" });
      const snapshotId = await saveOptionChainSnapshot(snapshot);
      await monitorPaperTrading(snapshot);
      await publishSnapshotSaved(snapshotId, snapshot);
      await sendCriticalPushAlerts(snapshot);
      console.log("Saved Dhan market snapshot", {
        snapshotId,
        underlying: snapshot.underlyingSymbol,
        expiry: snapshot.expiry,
        ticks: snapshot.ticks.length
      });
    } catch (error) {
      console.warn("Unable to capture primary expiry for underlying; skipping this cycle", { underlyingKey, expiry, error });
      continue;
    }

    const capturedExpiries = new Set([expiry]);

    // The Dashboard/Strike Matrix expiry picker (getExpiriesOrEmpty in
    // apps/api/src/server.ts) only offers expiries we've already captured
    // snapshot history for - it doesn't fall back to Dhan's live expiry
    // list once we have ANY stored history. Without this, the next week's
    // expiry never becomes selectable there until the current nearest
    // expiry rolls off and it becomes expiries[0] itself, even though Dhan
    // already lists it as tradable well before then. Keep the next-nearest
    // expiry's snapshot history warm too so it shows up in advance.
    //
    // Skipped for MCX commodities (CRUDEOIL/NATURALGAS/COPPER/SILVER):
    // next-month contract interest is far lower than NIFTY/BANKNIFTY's
    // next-week view, and these four are last in config.feedUnderlyings,
    // so they're the ones that pay whenever the cycle's Dhan call budget
    // runs out. Dropping this second call for all four frees up real
    // headroom before COPPER/SILVER's turn (2026-07-29 incident - see
    // captureOnce's primary-capture try/catch above for the other half of
    // that fix).
    const nextExpiry = underlying.segment === "MCX_COMM" ? undefined : expiries[1];
    if (nextExpiry) {
      try {
        const nextSnapshot = await dhan.getOptionChain({ underlying, expiry: nextExpiry, spotPriceOverride: quoteOverrides.get(underlying.key), caller: "worker:index-capture:next" });
        const nextSnapshotId = await saveOptionChainSnapshot(nextSnapshot);
        await monitorPaperTrading(nextSnapshot);
        await publishSnapshotSaved(nextSnapshotId, nextSnapshot);
        console.log("Saved Dhan market snapshot for next expiry", {
          snapshotId: nextSnapshotId,
          underlying: nextSnapshot.underlyingSymbol,
          expiry: nextSnapshot.expiry,
          ticks: nextSnapshot.ticks.length
        });
        capturedExpiries.add(nextExpiry);
      } catch (error) {
        console.warn("Unable to capture next expiry for dashboard availability", { underlying: underlying.key, expiry: nextExpiry, error });
      }
    }

    await captureExtraExpiriesForPaperTrading(underlying, capturedExpiries, quoteOverrides.get(underlying.key));
  }

  await captureStockOptionChains();
}

// Paper trades can now target any expiry (see the Paper Order Ticket's
// expiry picker), not just this underlying's nearest one - but the loop
// above only ever fetches/stores that nearest expiry. Without this, a
// pending order or open position sitting on a later expiry would have no
// live tick data to check against: no LTP to show, and no way for it to
// ever fill (refreshPendingPaperOrders/refreshOpenPositionPrices both read
// straight from the OptionContractTick table). So for every OTHER expiry
// that currently has a pending order or open position, fetch and store its
// live chain too, then run the same paper-trading monitor pass on it.
async function captureExtraExpiriesForPaperTrading(underlying: UnderlyingDefinition, alreadyCapturedExpiries: Set<string>, spotPriceOverride?: number) {
  let extraExpiries: string[];
  try {
    extraExpiries = await listExpiriesNeedingLiveData(underlying.key);
  } catch (error) {
    console.warn("Unable to list expiries needing live data for paper trading", { underlying: underlying.key, error });
    return;
  }

  for (const expiry of extraExpiries) {
    if (alreadyCapturedExpiries.has(expiry)) {
      continue;
    }

    try {
      const snapshot = await dhan.getOptionChain({ underlying, expiry, spotPriceOverride, caller: "worker:paper-trading:extra-expiry" });
      const snapshotId = await saveOptionChainSnapshot(snapshot);
      await monitorPaperTrading(snapshot);
      console.log("Saved extra Dhan market snapshot for open paper trading activity", {
        snapshotId,
        underlying: snapshot.underlyingSymbol,
        expiry: snapshot.expiry,
        ticks: snapshot.ticks.length
      });
    } catch (error) {
      console.warn("Unable to capture extra expiry for open paper trading activity", { underlying: underlying.key, expiry, error });
    }
  }
}

// Framework for capturing full option chains for the highest-weighted F&O
// stocks, gated behind STOCK_OPTION_CHAIN_CAPTURE_ENABLED (default false)
// and getOptionChainTrackedStocks (empty until indexWeightPercent is
// seeded for at least one stock) - see fno-stock-repository.ts and
// config/src/index.ts. Both guards mean this is a complete no-op today.
//
// Segment note: UnderlyingSeg here must be the UNDERLYING's own segment
// (mirrors how NIFTY/BANKNIFTY pass "IDX_I", their own index segment, not
// a derivatives segment) - for an equity underlying that's "NSE_EQ", the
// same segment resolveNseEquitySecurityIds already resolved FnoStock's
// securityId against. This is distinct from getFnoExchangeSegment
// ("NSE_FNO"), which is only for the margin-calculator API acting on the
// option CONTRACT itself, not for looking up its underlying's chain.
//
// Only the nearest expiry is captured per stock (unlike the index loop's
// current+next), and calls are staggered with a fixed gap rather than
// fired together, to keep this from adding a burst of up to
// STOCK_OPTION_CHAIN_MAX_STOCKS simultaneous requests on top of the
// existing index capture load within the same cycle.
const STOCK_OPTION_CHAIN_SEGMENT = "NSE_EQ";
const STOCK_CAPTURE_STAGGER_MS = 500;

async function captureStockOptionChains() {
  if (!config.STOCK_OPTION_CHAIN_CAPTURE_ENABLED) {
    return;
  }

  if (!isMarketSessionOpen(STOCK_OPTION_CHAIN_SEGMENT)) {
    return;
  }

  const trackedStocks = await getOptionChainTrackedStocks(config.STOCK_OPTION_CHAIN_WEIGHT_THRESHOLD_PERCENT, config.STOCK_OPTION_CHAIN_MAX_STOCKS);
  if (!trackedStocks.length) {
    return;
  }

  console.log("Capturing option chains for weighted F&O stocks", {
    count: trackedStocks.length,
    symbols: trackedStocks.map((stock) => stock.symbol)
  });

  for (const stock of trackedStocks) {
    const underlying: UnderlyingDefinition = {
      key: stock.symbol,
      symbol: stock.symbol,
      displayName: stock.displayName,
      securityId: stock.securityId,
      segment: STOCK_OPTION_CHAIN_SEGMENT,
      // Cosmetic only at this layer - normalizeOptionChain embeds this on
      // each in-memory tick, but saveOptionChainSnapshot doesn't persist
      // it; the API re-resolves the real lot size from FnoLotSize per
      // request (see getLotSizeForExpiry), so an unresolved value here
      // never reaches the UI.
      lotSize: stock.lotSize ?? 1
    };

    try {
      const expiries = await getCachedExpiryList(underlying, "worker:stock-capture:expiry-list");
      const expiry = expiries[0];
      if (!expiry) {
        console.warn("Skipping weighted F&O stock with no expiry", { symbol: stock.symbol });
        continue;
      }

      const snapshot = await dhan.getOptionChain({ underlying, expiry, caller: "worker:stock-capture" });
      const snapshotId = await saveOptionChainSnapshot(snapshot);
      await monitorPaperTrading(snapshot);
      console.log("Saved Dhan option chain snapshot for weighted F&O stock", {
        snapshotId,
        symbol: stock.symbol,
        indexWeightPercent: stock.indexWeightPercent,
        expiry: snapshot.expiry,
        ticks: snapshot.ticks.length
      });
    } catch (error) {
      console.warn("Unable to capture option chain for weighted F&O stock", { symbol: stock.symbol, error });
    }

    await sleep(STOCK_CAPTURE_STAGGER_MS);
  }
}

async function runRetentionOnce() {
  const detailCutoff = new Date(Date.now() - config.SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // Guarded rather than trusted: a snapshot's ticks can't be allowed to
  // outlive the snapshot row itself, so if SPOT_PRICE_RETENTION_DAYS is ever
  // misconfigured below SNAPSHOT_RETENTION_DAYS, treat it as equal instead
  // of letting snapshotCutoff land more recent than detailCutoff.
  const spotPriceRetentionDays = Math.max(config.SPOT_PRICE_RETENTION_DAYS, config.SNAPSHOT_RETENTION_DAYS);
  const snapshotCutoff = new Date(Date.now() - spotPriceRetentionDays * 24 * 60 * 60 * 1000);

  // pruneMarketDataBefore drains both phases internally (up to 50 batches
  // each) until each cutoff's backlog is empty, so a single call is enough.
  const total = await pruneMarketDataBefore(detailCutoff, snapshotCutoff, config.SNAPSHOT_RETENTION_BATCH_SIZE);

  console.log("Snapshot retention cleanup completed", {
    detailCutoff: detailCutoff.toISOString(),
    snapshotCutoff: snapshotCutoff.toISOString(),
    detailRetentionDays: config.SNAPSHOT_RETENTION_DAYS,
    spotPriceRetentionDays,
    ...total
  });
}

async function sendCriticalPushAlerts(snapshot: OptionChainSnapshot) {
  if (!pushNotificationsEnabled) {
    return;
  }

  const subscriptions = await listActivePushSubscriptions();
  if (!subscriptions.length) {
    return;
  }
  await ensureRedisPublisherConnected();

  const pressure = calculatePressureScore(snapshot);
  const userIds = [...new Set(subscriptions.map((subscription) => subscription.userId))];
  // Each user's own configured alert thresholds (Alert Center settings)
  // decide what even counts as "critical" for them - previously this call
  // always used the hardcoded defaults, so pushes ignored per-user
  // thresholds while the in-app Alert Center honoured them.
  const thresholdsByUserId = new Map(
    await Promise.all(userIds.map(async (userId) => [userId, (await getUserAlertThreshold(userId, snapshot.underlyingSymbol)) ?? undefined] as const))
  );

  const alertByUserId = new Map<string, MarketAlert>();
  for (const userId of userIds) {
    const best = generateMarketAlerts(snapshot, pressure, new Date(), thresholdsByUserId.get(userId))
      .filter((alert) => alert.severity === "critical")
      .sort((a, b) => pushAlertPriority(a) - pushAlertPriority(b))[0];
    if (best) {
      alertByUserId.set(userId, best);
    }
  }
  if (!alertByUserId.size) {
    return;
  }

  const results = await Promise.allSettled(
    subscriptions
      .filter((subscription) => alertByUserId.has(subscription.userId))
      .map(async (subscription) => {
        const alert = alertByUserId.get(subscription.userId) as MarketAlert;
        const cooldownKey = pushCooldownKey(subscription.userId, alert.id);
        const acquired = await redisPublisher.set(cooldownKey, "1", "PX", PUSH_ALERT_COOLDOWN_MS, "NX");
        if (acquired !== "OK") {
          return;
        }
        try {
          await webpush.sendNotification({
            endpoint: subscription.endpoint,
            keys: subscription.keys
          }, JSON.stringify(toPushPayload(snapshot, alert)));
        } catch (error) {
          // Nothing was actually delivered - release the cooldown so a
          // later cycle can retry rather than silently going quiet for 15
          // minutes over a transient send failure.
          await redisPublisher.del(cooldownKey);
          if (isExpiredPushSubscription(error)) {
            await disablePushSubscriptionByEndpoint(subscription.endpoint);
          }
          throw error;
        }
      })
  );
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) {
    console.warn("Some push notifications failed", {
      underlying: snapshot.underlyingSymbol,
      failed,
      total: results.length
    });
  }
}

function toPushPayload(snapshot: OptionChainSnapshot, alert: MarketAlert) {
  return {
    title: alert.title,
    body: alert.message,
    tag: alert.id,
    url: `${config.APP_PUBLIC_URL}/app?view=alerts&underlying=${encodeURIComponent(snapshot.underlyingSymbol)}`,
    createdAt: alert.createdAt
  };
}

function isExpiredPushSubscription(error: unknown) {
  return typeof error === "object" && error !== null && "statusCode" in error && [404, 410].includes(Number((error as { statusCode?: number }).statusCode));
}

async function monitorPaperTrading(snapshot: { underlyingSymbol: string; expiry: string }) {
  try {
    const result = await monitorPaperTradingForSnapshot(snapshot.underlyingSymbol, snapshot.expiry);
    if (result.filledOrders || result.checkedPositions || result.closedPositions) {
      console.log("Paper trading monitor completed", {
        underlying: snapshot.underlyingSymbol,
        expiry: snapshot.expiry,
        filledOrders: result.filledOrders,
        checkedPositions: result.checkedPositions,
        closedPositions: result.closedPositions
      });
    }
    if (result.filledLegs.length) {
      await recordMarginForFilledLegs(result.filledLegs);
    }
  } catch (error) {
    console.error("Paper trading monitor failed after market snapshot", {
      underlying: snapshot.underlyingSymbol,
      expiry: snapshot.expiry,
      error
    });
  }
}

// Informational-only margin lookup (per user request - never blocks or
// resizes a paper trade). Runs after a fill is already committed: on any
// failure (rate limit, missing Dhan credentials, mock market feed) this
// just skips leaving no margin figure for this cycle, rather than failing
// the fill itself. Groups legs by groupId so a multi-leg (hedge) ticket
// gets priced as one combined margin request, matching how Dhan itself
// prices a hedged position.
async function recordMarginForFilledLegs(filledLegs: FilledPaperLeg[]) {
  const processedGroupIds = new Set<string>();

  for (const leg of filledLegs) {
    if (leg.groupId) {
      if (processedGroupIds.has(leg.groupId)) {
        continue;
      }
      processedGroupIds.add(leg.groupId);
    }

    try {
      const groupLegs = await getOpenPositionsForMarginGroup(leg.positionId, leg.groupId);
      const scriptLegs = groupLegs.filter((groupLeg) => groupLeg.securityId);
      if (!scriptLegs.length) {
        // Most common cause: the fill came from mock/demo ticks (no real
        // Dhan securityId ever attached), not a real Dhan option-chain
        // snapshot. Logged (unlike a Dhan API failure) because this isn't
        // transient - it won't resolve on the next snapshot cycle either.
        console.warn("Margin lookup skipped: no leg in this group has a known Dhan securityId", {
          positionId: leg.positionId,
          groupId: leg.groupId,
          underlyingSymbol: leg.underlyingSymbol,
          expiryLabel: leg.expiryLabel,
          mockMarketFeedEnabled: config.MOCK_MARKET_FEED_ENABLED
        });
        continue;
      }

      const margin = await dhan.calculateMultiOrderMargin(
        scriptLegs.map((groupLeg) => ({
          transactionType: groupLeg.action === "SELL" ? "SELL" : "BUY",
          quantity: groupLeg.quantity,
          securityId: groupLeg.securityId as string,
          price: groupLeg.entryPrice,
          exchangeSegment: getFnoExchangeSegment(groupLeg.underlyingSymbol)
        })),
        "worker:paper-trading:margin"
      );

      await recordPositionMargin(
        groupLegs.map((groupLeg) => groupLeg.id),
        margin.totalMargin,
        {
          spanMargin: margin.spanMargin,
          exposureMargin: margin.exposureMargin,
          foMargin: margin.foMargin,
          commodityMargin: margin.commodityMargin,
          currency: margin.currency,
          hedgeBenefit: margin.hedgeBenefit ?? null,
          legCount: scriptLegs.length
        }
      );
    } catch (error) {
      console.warn("Margin lookup skipped for filled paper trade (informational only)", {
        positionId: leg.positionId,
        groupId: leg.groupId,
        error: error instanceof Error ? error.message : error
      });
    }
  }
}

async function ensureRedisPublisherConnected() {
  if (redisPublisher.status === "wait") {
    await redisPublisher.connect();
  }
}

async function publishSnapshotSaved(snapshotId: string, snapshot: { underlyingSymbol: string; expiry: string; snapshotTime: string }) {
  try {
    await ensureRedisPublisherConnected();

    await redisPublisher.publish(MARKET_SNAPSHOT_SAVED_CHANNEL, JSON.stringify({
      snapshotId,
      underlying: snapshot.underlyingSymbol,
      expiry: snapshot.expiry,
      snapshotTime: snapshot.snapshotTime,
      serverTime: new Date().toISOString()
    }));
  } catch (error) {
    console.warn("Unable to publish market snapshot notification", {
      snapshotId,
      underlying: snapshot.underlyingSymbol,
      expiry: snapshot.expiry,
      error
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// BullMQ's repeatable "every 30000ms" job fires this on a fixed :00/:30
// clock-second grid, so this OHLC call left the process every single cycle
// at almost the exact same instant, every day, for as long as the worker
// has been running. In production this consistently got HTTP 429 (Dhan
// error 805, "too many requests or connections") on nearly every attempt,
// while the API's own Market Quote calls (same account, same code path,
// same request shape confirmed via manual replica) succeeded fine, and a
// one-off manual retry moments later also succeeded. That points at
// something specific to firing on a predictable, unjittered clock
// boundary every cycle rather than a genuinely broken payload or account
// block, so this: (1) starts with a small random jitter so it stops
// landing on the exact same instant every cycle, and (2) retries once
// after a short backoff on failure, per Dhan's own documented rate-limit
// guidance (docs.dhanhq.co/api/v2/guides/rate-limits).
async function getSpotPriceOverrides(underlyings: UnderlyingDefinition[]) {
  const resolvedUnderlyings = await dhan.resolveQuoteUnderlyings(underlyings);
  const quoteUnderlyings = resolvedUnderlyings.filter((underlying) => underlying.quoteSecurityId);
  if (!quoteUnderlyings.length) {
    return new Map<string, number>();
  }

  const overrides = new Map<string, number>();
  let remaining = quoteUnderlyings;

  // Prefer the live feed's cached tick (see live-tick-cache.ts) over a
  // fresh REST call - only the underlyings the feed doesn't have fresh
  // data for (feed not yet warmed up, or genuinely down) fall through to
  // the existing REST path below, unchanged.
  if (config.LIVE_MARKET_FEED_ENABLED) {
    const stillNeeded: typeof quoteUnderlyings = [];
    for (const underlying of quoteUnderlyings) {
      const segment = toLiveFeedSegment(underlying.quoteSegment ?? underlying.segment);
      const securityId = underlying.quoteSecurityId ?? underlying.securityId;
      const tick = segment ? await getLiveTick(redisPublisher, segment, securityId) : undefined;
      if (tick?.ltp !== undefined) {
        overrides.set(underlying.key, tick.ltp);
      } else {
        stillNeeded.push(underlying);
      }
    }
    remaining = stillNeeded;
  }

  if (!remaining.length) {
    return overrides;
  }

  await sleep(Math.floor(Math.random() * 2000));

  const mergeInto = (quotes: Map<string, DhanOhlcQuote>) => {
    for (const underlying of remaining) {
      const lastPrice = quotes.get(underlying.key)?.lastPrice;
      if (typeof lastPrice === "number") {
        overrides.set(underlying.key, lastPrice);
      }
    }
    return overrides;
  };

  try {
    return mergeInto(await dhan.getOhlcQuotes(remaining, "worker:spot-price-override"));
  } catch (firstError) {
    console.warn("Futures quote override fetch failed, retrying once after backoff", { error: firstError instanceof Error ? firstError.message : firstError });
    await sleep(2500);
    try {
      return mergeInto(await dhan.getOhlcQuotes(remaining, "worker:spot-price-override"));
    } catch (error) {
      console.warn("Unable to fetch futures quote overrides; option-chain spot prices may use generic underlyings", error);
      return overrides;
    }
  }
}

async function startWorker() {
  const queue = new Queue<MarketSnapshotJobData>(MARKET_SNAPSHOT_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000
      },
      removeOnComplete: {
        age: 60 * 60 * 24,
        count: 200
      },
      removeOnFail: {
        age: 60 * 60 * 24 * 7,
        count: 500
      }
    }
  });
  const retentionQueue = new Queue(SNAPSHOT_RETENTION_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: "exponential",
        delay: 30000
      },
      removeOnComplete: {
        age: 60 * 60 * 24 * 7,
        count: 30
      },
      removeOnFail: {
        age: 60 * 60 * 24 * 14,
        count: 50
      }
    }
  });
  const queueEvents = new QueueEvents(MARKET_SNAPSHOT_QUEUE, { connection: redisConnection });
  const retentionQueueEvents = new QueueEvents(SNAPSHOT_RETENTION_QUEUE, { connection: redisConnection });
  const worker = new BullWorker<MarketSnapshotJobData>(
    MARKET_SNAPSHOT_QUEUE,
    async (job: Job<MarketSnapshotJobData>) => {
      console.log("Processing market snapshot job", {
        jobId: job.id,
        name: job.name,
        trigger: job.data.trigger,
        attempt: job.attemptsMade + 1
      });
      // Sampled either side of the job, not just on the 20s interval: the
      // interval says a ~2.5GB native burst happens, but cannot say which
      // work caused it. A before/after pair per job does, and the capture
      // job is the first suspect simply because it is what runs on this
      // cadence. If the delta lands here, the search narrows to captureOnce;
      // if it doesn't, the burst belongs to the wave screener or the live
      // feed and this rules the capture path out - which is worth as much.
      logWorkerMemory("capture:before", { jobId: job.id });
      const startedAt = Date.now();
      try {
        await captureOnce();
      } finally {
        logWorkerMemory("capture:after", { jobId: job.id, tookMs: Date.now() - startedAt });
      }
    },
    {
      connection: redisConnection,
      concurrency: 1,
      limiter: {
        max: 1,
        duration: Math.max(1000, Math.floor(config.SNAPSHOT_INTERVAL_MS / 2))
      }
    }
  );
  const retentionWorker = new BullWorker(
    SNAPSHOT_RETENTION_QUEUE,
    async (job: Job) => {
      console.log("Processing snapshot retention job", {
        jobId: job.id,
        name: job.name,
        attempt: job.attemptsMade + 1
      });
      await runRetentionOnce();
    },
    {
      connection: redisConnection,
      concurrency: 1
    }
  );

  queueEvents.on("completed", ({ jobId }) => {
    console.log("Market snapshot job completed", { jobId });
  });
  queueEvents.on("failed", ({ jobId, failedReason }) => {
    console.error("Market snapshot job failed", { jobId, failedReason });
  });
  worker.on("failed", (job, error) => {
    console.error("Market snapshot worker failure", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error
    });
  });
  worker.on("error", (error) => {
    console.error("Market snapshot worker error", error);
  });
  retentionQueueEvents.on("completed", ({ jobId }) => {
    console.log("Snapshot retention job completed", { jobId });
  });
  retentionQueueEvents.on("failed", ({ jobId, failedReason }) => {
    console.error("Snapshot retention job failed", { jobId, failedReason });
  });
  retentionWorker.on("failed", (job, error) => {
    console.error("Snapshot retention worker failure", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error
    });
  });
  retentionWorker.on("error", (error) => {
    console.error("Snapshot retention worker error", error);
  });

  await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), worker.waitUntilReady(), retentionQueue.waitUntilReady(), retentionQueueEvents.waitUntilReady(), retentionWorker.waitUntilReady()]);
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    snapshotRepeatOptions,
    {
      name: CAPTURE_JOB_NAME,
      data: { trigger: "scheduled" },
      opts: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000
        }
      }
    }
  );
  await retentionQueue.upsertJobScheduler(
    RETENTION_SCHEDULER_ID,
    { pattern: config.SNAPSHOT_RETENTION_CRON_PATTERN },
    {
      name: RETENTION_JOB_NAME,
      data: {},
      opts: {
        attempts: 2,
        backoff: {
          type: "exponential",
          delay: 30000
        }
      }
    }
  );
  await queue.add(
    CAPTURE_JOB_NAME,
    { trigger: "startup" },
    {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000
      },
      removeOnComplete: true
    }
  );

  console.log("Market snapshot BullMQ scheduler registered", {
    queue: MARKET_SNAPSHOT_QUEUE,
    schedulerId: SCHEDULER_ID,
    repeat: snapshotRepeatOptions
  });
  console.log("Snapshot retention BullMQ scheduler registered", {
    queue: SNAPSHOT_RETENTION_QUEUE,
    schedulerId: RETENTION_SCHEDULER_ID,
    pattern: config.SNAPSHOT_RETENTION_CRON_PATTERN,
    retentionDays: config.SNAPSHOT_RETENTION_DAYS
  });

  // Paper Trading Pro seller simulator: self-contained EOD MTM scheduler
  // (own queue/worker) - see sim-eod-mtm.ts.
  const simEodScheduler = await startSimEodScheduler(redisConnection);

  // Elliott Wave background screener: self-contained universe sync + stock
  // quote capture + scan schedulers - see wave-screener.ts.
  const waveScreener = await startWaveScreener(redisConnection, dhan, config.MOCK_MARKET_FEED_ENABLED, config.feedUnderlyings, config.LIVE_MARKET_FEED_ENABLED, redisPublisher);

  // Dhan Live Market Feed (WebSocket) - off by default (LIVE_MARKET_FEED_ENABLED),
  // and never opened in mock mode (no real Dhan credentials to connect
  // with, same reasoning as the REST calls skipped elsewhere in mock mode).
  let liveFeedResyncTimer: ReturnType<typeof setInterval> | undefined;
  if (config.LIVE_MARKET_FEED_ENABLED && !config.MOCK_MARKET_FEED_ENABLED) {
    liveFeed.connect();
    await resyncLiveFeedSubscriptions();
    liveFeedResyncTimer = setInterval(() => {
      resyncLiveFeedSubscriptions().catch((error) => {
        console.warn("Dhan live feed subscription resync failed", { error });
      });
    }, LIVE_FEED_RESYNC_INTERVAL_MS);
  }

  async function shutdown(signal: NodeJS.Signals) {
    console.log("Shutting down market snapshot worker", { signal });
    if (liveFeedResyncTimer) {
      clearInterval(liveFeedResyncTimer);
    }
    liveFeed.close();
    await Promise.allSettled([worker.close(), retentionWorker.close(), queueEvents.close(), retentionQueueEvents.close(), queue.close(), retentionQueue.close(), simEodScheduler.close(), waveScreener.close(), redisPublisher.quit()]);
    process.exit(0);
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startWorker().catch((error: unknown) => {
  console.error("Unable to start market snapshot BullMQ worker", error);
  process.exit(1);
});

import { calculatePressureScore, generateMarketAlerts } from "@option-decode/analytics";
import { loadConfig } from "@option-decode/config";
import { buildDemoSnapshot, disablePushSubscriptionByEndpoint, getOpenPositionsForMarginGroup, listActivePushSubscriptions, listExpiriesNeedingLiveData, monitorPaperTradingForSnapshot, pruneMarketDataBefore, recordPositionMargin, saveOptionChainSnapshot } from "@option-decode/db";
import type { FilledPaperLeg } from "@option-decode/db";
import { DhanClient, getFnoExchangeSegment, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { DhanOhlcQuote } from "@option-decode/dhan";
import type { MarketAlert, OptionChainSnapshot, UnderlyingDefinition } from "@option-decode/types";
import { isMarketSessionOpen } from "@option-decode/utils";
import { Job, Queue, QueueEvents, Worker as BullWorker } from "bullmq";
import Redis from "ioredis";
import webpush from "web-push";

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
const pushAlertLastSentAt = new Map<string, number>();

if (pushNotificationsEnabled) {
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY as string, config.VAPID_PRIVATE_KEY as string);
}

const dhan = new DhanClient({
  baseUrl: config.DHAN_API_BASE_URL,
  clientId: config.DHAN_CLIENT_ID,
  accessToken: config.DHAN_ACCESS_TOKEN
});

console.log("Option Decode worker starting", {
  underlyings: config.feedUnderlyings,
  intervalMs: config.SNAPSHOT_INTERVAL_MS,
  cronPattern: config.SNAPSHOT_CRON_PATTERN,
  dhanConfigured: Boolean(dhan),
  mockMarketFeedEnabled: config.MOCK_MARKET_FEED_ENABLED,
  queue: MARKET_SNAPSHOT_QUEUE,
  retentionDays: config.SNAPSHOT_RETENTION_DAYS,
  pushNotificationsEnabled
});

type MarketSnapshotJobData = {
  trigger: "startup" | "scheduled";
};

async function captureOnce() {
  if (config.MOCK_MARKET_FEED_ENABLED) {
    if (!isMarketSessionOpen("IDX_I")) {
      console.log("Skipping mock market snapshot outside 09:15-15:30 IST storage window", {
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

    const expiries = await dhan.getExpiryList(underlying);
    const expiry = expiries[0];
    if (!expiry) {
      console.warn("Skipping underlying with no expiry", { underlyingKey });
      continue;
    }

    const snapshot = await dhan.getOptionChain({ underlying, expiry, spotPriceOverride: quoteOverrides.get(underlying.key) });
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

    const capturedExpiries = new Set([expiry]);

    // The Dashboard/Strike Matrix expiry picker (getExpiriesOrEmpty in
    // apps/api/src/server.ts) only offers expiries we've already captured
    // snapshot history for - it doesn't fall back to Dhan's live expiry
    // list once we have ANY stored history. Without this, the next week's
    // expiry never becomes selectable there until the current nearest
    // expiry rolls off and it becomes expiries[0] itself, even though Dhan
    // already lists it as tradable well before then. Keep the next-nearest
    // expiry's snapshot history warm too so it shows up in advance.
    const nextExpiry = expiries[1];
    if (nextExpiry) {
      try {
        const nextSnapshot = await dhan.getOptionChain({ underlying, expiry: nextExpiry, spotPriceOverride: quoteOverrides.get(underlying.key) });
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
      const snapshot = await dhan.getOptionChain({ underlying, expiry, spotPriceOverride });
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

async function runRetentionOnce() {
  const cutoff = new Date(Date.now() - config.SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const total = {
    snapshots: 0,
    ticks: 0,
    pressureScores: 0
  };

  for (let batch = 0; batch < 50; batch += 1) {
    const result = await pruneMarketDataBefore(cutoff, config.SNAPSHOT_RETENTION_BATCH_SIZE);
    total.snapshots += result.snapshots;
    total.ticks += result.ticks;
    total.pressureScores += result.pressureScores;

    if (result.snapshots < config.SNAPSHOT_RETENTION_BATCH_SIZE) {
      break;
    }
  }

  console.log("Snapshot retention cleanup completed", {
    cutoff: cutoff.toISOString(),
    retentionDays: config.SNAPSHOT_RETENTION_DAYS,
    ...total
  });
}

async function sendCriticalPushAlerts(snapshot: OptionChainSnapshot) {
  if (!pushNotificationsEnabled) {
    return;
  }

  const pressure = calculatePressureScore(snapshot);
  const criticalAlert = generateMarketAlerts(snapshot, pressure).find((alert) => alert.severity === "critical");
  if (!criticalAlert) {
    return;
  }
  const cooldownKey = criticalAlert.id;
  const now = Date.now();
  const lastSentAt = pushAlertLastSentAt.get(cooldownKey) ?? 0;
  if (now - lastSentAt < PUSH_ALERT_COOLDOWN_MS) {
    return;
  }

  const subscriptions = await listActivePushSubscriptions();
  if (!subscriptions.length) {
    return;
  }

  const payload = JSON.stringify(toPushPayload(snapshot, criticalAlert));
  const results = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: subscription.keys
        }, payload);
      } catch (error) {
        if (isExpiredPushSubscription(error)) {
          await disablePushSubscriptionByEndpoint(subscription.endpoint);
        }
        throw error;
      }
    })
  );
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed < subscriptions.length) {
    pushAlertLastSentAt.set(cooldownKey, now);
  }
  if (failed) {
    console.warn("Some push notifications failed", {
      underlying: snapshot.underlyingSymbol,
      failed,
      total: subscriptions.length
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
        }))
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

async function publishSnapshotSaved(snapshotId: string, snapshot: { underlyingSymbol: string; expiry: string; snapshotTime: string }) {
  try {
    if (redisPublisher.status === "wait") {
      await redisPublisher.connect();
    }

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

  await sleep(Math.floor(Math.random() * 2000));

  const toMap = (quotes: Map<string, DhanOhlcQuote>) =>
    new Map(
      quoteUnderlyings
        .map((underlying) => [underlying.key, quotes.get(underlying.key)?.lastPrice] as const)
        .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number")
    );

  try {
    return toMap(await dhan.getOhlcQuotes(quoteUnderlyings));
  } catch (firstError) {
    console.warn("Futures quote override fetch failed, retrying once after backoff", { error: firstError instanceof Error ? firstError.message : firstError });
    await sleep(2500);
    try {
      return toMap(await dhan.getOhlcQuotes(quoteUnderlyings));
    } catch (error) {
      console.warn("Unable to fetch futures quote overrides; option-chain spot prices may use generic underlyings", error);
      return new Map<string, number>();
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
      await captureOnce();
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

  async function shutdown(signal: NodeJS.Signals) {
    console.log("Shutting down market snapshot worker", { signal });
    await Promise.allSettled([worker.close(), retentionWorker.close(), queueEvents.close(), retentionQueueEvents.close(), queue.close(), retentionQueue.close(), redisPublisher.quit()]);
    process.exit(0);
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startWorker().catch((error: unknown) => {
  console.error("Unable to start market snapshot BullMQ worker", error);
  process.exit(1);
});

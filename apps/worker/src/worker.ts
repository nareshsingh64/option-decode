import { loadConfig } from "@option-decode/config";
import { buildDemoSnapshot, saveOptionChainSnapshot } from "@option-decode/db";
import { DhanClient, getUnderlyingDefinition, normalizeUnderlyingKey } from "@option-decode/dhan";
import type { UnderlyingDefinition } from "@option-decode/types";
import { isMarketSessionOpen } from "@option-decode/utils";
import { Job, Queue, QueueEvents, Worker as BullWorker } from "bullmq";
import Redis from "ioredis";

const config = loadConfig();
const MARKET_SNAPSHOT_QUEUE = "market-snapshot";
const CAPTURE_JOB_NAME = "capture";
const SCHEDULER_ID = "market-snapshot:capture";
const MARKET_SNAPSHOT_SAVED_CHANNEL = "market:snapshot:saved";
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
  queue: MARKET_SNAPSHOT_QUEUE
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
    await publishSnapshotSaved(snapshotId, snapshot);
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
    await publishSnapshotSaved(snapshotId, snapshot);
    console.log("Saved Dhan market snapshot", {
      snapshotId,
      underlying: snapshot.underlyingSymbol,
      expiry: snapshot.expiry,
      ticks: snapshot.ticks.length
    });
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

async function getSpotPriceOverrides(underlyings: UnderlyingDefinition[]) {
  const resolvedUnderlyings = await dhan.resolveQuoteUnderlyings(underlyings);
  const quoteUnderlyings = resolvedUnderlyings.filter((underlying) => underlying.quoteSecurityId);
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
  const queueEvents = new QueueEvents(MARKET_SNAPSHOT_QUEUE, { connection: redisConnection });
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

  await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), worker.waitUntilReady()]);
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

  async function shutdown(signal: NodeJS.Signals) {
    console.log("Shutting down market snapshot worker", { signal });
    await Promise.allSettled([worker.close(), queueEvents.close(), queue.close(), redisPublisher.quit()]);
    process.exit(0);
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startWorker().catch((error: unknown) => {
  console.error("Unable to start market snapshot BullMQ worker", error);
  process.exit(1);
});

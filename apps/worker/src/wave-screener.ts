// Elliott Wave background screener (Phase 2 of the Elliott Wave tab) - see
// docs/DECODE OPTION & ELLIOTT WAVE KNOWLEDGE FILE, section 4 "Automated
// Wave Screener Setup". Three independent, self-contained schedules (same
// pattern as sim-eod-mtm.ts) so a slow/failed run of one never blocks
// another:
//
//   1. Daily F&O stock universe sync (before market open).
//   2. Per-minute LTP+volume capture for that universe, during market hours.
//   3. A periodic scan across indices + stocks that runs the wave engine
//      and the two screener conditions, persisting new alerts.
//
// Indices/commodities are screened straight off the existing
// OptionChainSnapshot spot-price history (getSpotPriceHistory) - only F&O
// stocks need the new WavePricePoint capture, since that's the only place
// this app doesn't already have a live price series.

import { calculateElliottWave, calculateRsi, calculateRvol, evaluateWaveScreener, WAVE_ZIGZAG_PRESETS } from "@option-decode/analytics";
import { getSpotPriceHistory, getWavePriceHistory, listActiveFnoStocks, recordWaveAlertIfNew, recordWavePricePoints, syncFnoStockUniverse } from "@option-decode/db";
import { getUnderlyingDefinition } from "@option-decode/dhan";
import { runExclusive } from "./heavy-job-lock.js";
import { logWorkerMemory } from "./worker-memory.js";
import type { DhanClient } from "@option-decode/dhan";
import type { SpotPricePoint } from "@option-decode/types";
import { isMarketSessionOpen } from "@option-decode/utils";
import { Job, Queue, QueueEvents, Worker as BullWorker } from "bullmq";
import type Redis from "ioredis";
import { getLiveTicks } from "./live-tick-cache.js";

const UNIVERSE_SYNC_QUEUE = "wave-fno-universe-sync";
const UNIVERSE_SYNC_JOB_NAME = "sync";
const UNIVERSE_SYNC_SCHEDULER_ID = "wave-fno-universe-sync:sync";
// 07:30 IST, weekdays - ahead of the 09:14 NSE open, so the day's F&O
// universe and security-id resolution are settled before quote capture and
// the screener need them.
const UNIVERSE_SYNC_CRON_PATTERN = "30 7 * * 1-5";
const UNIVERSE_SYNC_TIMEZONE = "Asia/Kolkata";

const QUOTE_CAPTURE_QUEUE = "wave-stock-quote-capture";
const QUOTE_CAPTURE_JOB_NAME = "capture";
const QUOTE_CAPTURE_SCHEDULER_ID = "wave-stock-quote-capture:capture";
const QUOTE_CAPTURE_INTERVAL_MS = 60_000;

const SCREENER_SCAN_QUEUE = "wave-screener-scan";
const SCREENER_SCAN_JOB_NAME = "scan";
const SCREENER_SCAN_SCHEDULER_ID = "wave-screener-scan:scan";
// Slower than quote capture on purpose - a wave count doesn't meaningfully
// change every 60s, and this keeps Dhan/DB load down since it's re-reading
// history for the whole universe every run, not just the latest tick.
const SCREENER_SCAN_INTERVAL_MS = 3 * 60_000;
// Every Nth symbol of the ~216-symbol scan universe, so one scan produces a
// handful of samples rather than 216 log blocks.
const SCAN_MEMORY_SAMPLE_EVERY = 40;
// Pause every Nth symbol so the allocator gets an idle moment mid-scan.
//
// Measured cause (production 2026-08-12): ONE scan takes RSS from 276MB to
// 2,134MB, climbing monotonically across the ~216 per-symbol history
// queries and falling back afterwards. No single symbol dominates - the
// pages simply are not returned while the loop runs back to back.
//
// The pause alone is not expected to be sufficient, and is shipped WITH
// MALLOC_CONF on the worker unit. jemalloc only reclaims dirty pages on a
// decay timer (10s by default) and, without a background thread, only
// during later allocation activity in that arena - so an idle moment gives
// it the opportunity and background_thread + a 2s decay give it something
// to do with it. Either alone is half a fix.
//
// ~8 pauses per scan at 100ms is under a second added to a job that runs
// every 3 minutes. It does hold heavy-job-lock.ts for that extra second, so
// if capture jobs start reporting waits, this is the first number to lower.
const SCAN_YIELD_EVERY = 25;
const SCAN_YIELD_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Only screening the intraday horizon today - see WAVE_ZIGZAG_PRESETS. The
// tab's own manual analysis still lets a user pick weekly/monthly; extending
// the background screener to those horizons is a straightforward follow-up
// (different lookback window + cooldown per horizon) once intraday alerting
// has been validated against real data.
const SCREENER_HORIZON = "intraday" as const;
const SCREENER_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
// Suppresses re-alerting the same underlying+condition while it continues to
// hold across consecutive scan cycles (a Wave 2 pullback can sit in the
// Fibonacci zone for an hour or more).
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const RSI_PERIOD = 14;

interface WaveScreenerHandles {
  close(): Promise<void>;
}

export async function startWaveScreener(
  redisConnection: { url: string; maxRetriesPerRequest: null },
  dhan: DhanClient,
  mockMarketFeedEnabled: boolean,
  feedUnderlyings: string[],
  liveMarketFeedEnabled: boolean,
  tickCacheRedis: Redis
): Promise<WaveScreenerHandles> {
  const universeSyncQueue = new Queue(UNIVERSE_SYNC_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { age: 60 * 60 * 24 * 14, count: 30 },
      removeOnFail: { age: 60 * 60 * 24 * 30, count: 50 }
    }
  });
  const universeSyncWorker = new BullWorker(
    UNIVERSE_SYNC_QUEUE,
    async (job: Job) => {
      console.log("Processing F&O stock universe sync job", { jobId: job.id, attempt: job.attemptsMade + 1 });
      const result = await syncFnoStockUniverse();
      console.log("F&O stock universe sync finished", result);
      if (result.unresolvedSymbols.length) {
        console.warn("Some F&O stock symbols could not be resolved to an NSE_EQ security id", {
          count: result.unresolvedSymbols.length,
          symbols: result.unresolvedSymbols.slice(0, 20)
        });
      }
    },
    { connection: redisConnection, concurrency: 1 }
  );
  universeSyncWorker.on("failed", (job, error) => {
    console.error("F&O stock universe sync failed", { jobId: job?.id, error });
  });

  const quoteCaptureQueue = new Queue(QUOTE_CAPTURE_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { age: 60 * 60 * 6, count: 50 },
      removeOnFail: { age: 60 * 60 * 24, count: 100 }
    }
  });
  const quoteCaptureWorker = new BullWorker(
    QUOTE_CAPTURE_QUEUE,
    async (_job: Job) => {
      // Serialised with the option-chain capture jobs and instrumented -
      // this path overlapped only 6.7% of captures but accounted for 54%
      // of their >500MB bursts (production, 2026-08-12). See
      // heavy-job-lock.ts.
      return runExclusive("wave:quote-capture", async () => {
        logWorkerMemory("wave:quote-capture:before");
        const startedAt = Date.now();
        try {
      // getEquityQuotes needs authenticated Dhan API access, unlike the
      // universe sync (that hits Dhan's public lot-size page and scrip
      // master CSV, no credentials required) - skip it the same way
      // captureOnce() skips real option-chain calls in mock mode, rather
      // than letting every cycle fail with a missing-credentials error.
      if (mockMarketFeedEnabled || !isMarketSessionOpen("NSE_EQ")) {
        return;
      }

      const stocks = await listActiveFnoStocks();
      const resolvable = stocks.filter((stock): stock is typeof stock & { securityId: number } => stock.securityId !== undefined);
      if (!resolvable.length) {
        return;
      }

      const now = new Date();
      const points: Array<{ underlyingSymbol: string; time: Date; price: number; volume?: number }> = [];
      let stillNeeded = resolvable;

      // Prefer the live feed's cached ticks (see live-tick-cache.ts, fed by
      // worker.ts's DhanLiveFeedClient) over a REST round trip - only
      // stocks the feed doesn't have fresh data for yet fall through to
      // the original getEquityQuotes REST call below.
      if (liveMarketFeedEnabled) {
        const liveTicks = await getLiveTicks(
          tickCacheRedis,
          resolvable.map((stock) => ({ segment: "NSE_EQ" as const, securityId: stock.securityId }))
        );
        const missing: typeof resolvable = [];
        for (const stock of resolvable) {
          const tick = liveTicks.get(`NSE_EQ:${stock.securityId}`);
          if (tick?.ltp !== undefined) {
            points.push({ underlyingSymbol: stock.symbol, time: now, price: tick.ltp, volume: tick.volume });
          } else {
            missing.push(stock);
          }
        }
        stillNeeded = missing;
      }

      if (stillNeeded.length) {
        const quotes = await dhan.getEquityQuotes(
          stillNeeded.map((stock) => ({ symbol: stock.symbol, securityId: stock.securityId })),
          "worker:wave-screener:quote-capture"
        );
        for (const stock of stillNeeded) {
          const quote = quotes.get(stock.symbol);
          if (quote?.lastPrice) {
            points.push({ underlyingSymbol: stock.symbol, time: now, price: quote.lastPrice, volume: quote.volume });
          }
        }
      }

      const stored = await recordWavePricePoints(points);
      if (stored > 0) {
        console.log("Captured F&O stock quotes for Elliott Wave screener", { requested: resolvable.length, viaLiveFeed: resolvable.length - stillNeeded.length, viaRest: stillNeeded.length, stored });
        }
        } finally {
          logWorkerMemory("wave:quote-capture:after", { tookMs: Date.now() - startedAt });
        }
      });
    },
    { connection: redisConnection, concurrency: 1 }
  );
  quoteCaptureWorker.on("failed", (job, error) => {
    console.error("F&O stock quote capture failed", { jobId: job?.id, error });
  });
  quoteCaptureWorker.on("error", (error) => {
    console.error("F&O stock quote capture worker error", error);
  });

  const screenerScanQueue = new Queue(SCREENER_SCAN_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 60 * 60 * 6, count: 50 },
      removeOnFail: { age: 60 * 60 * 24, count: 100 }
    }
  });
  const screenerScanWorker = new BullWorker(
    SCREENER_SCAN_QUEUE,
    async (_job: Job) => {
      // Serialised with the option-chain capture jobs and instrumented -
      // this path overlapped only 6.7% of captures but accounted for 54%
      // of their >500MB bursts (production, 2026-08-12). See
      // heavy-job-lock.ts.
      return runExclusive("wave:screener-scan", async () => {
        logWorkerMemory("wave:screener-scan:before");
        const startedAt = Date.now();
        try {
      // Unlike quote capture (NSE_EQ only - stocks only trade NSE hours),
      // the universe here also includes MCX commodities, which trade
      // 09:00-23:30 IST - well past NSE's 15:41 close. Gating this on
      // NSE_EQ alone silently stopped screening CRUDEOIL/NATURALGAS/COPPER/
      // SILVER for the back half of every trading day even though fresh
      // data kept arriving for them the whole time.
      if (!isMarketSessionOpen("NSE_EQ") && !isMarketSessionOpen("MCX_COMM")) {
        return;
      }

      // Only scan indices/commodities actually being captured (FEED_UNDERLYINGS),
      // not every symbol Dhan happens to support - an underlying that isn't
      // fed has no OptionChainSnapshot history to screen anyway.
      const indexSymbols = feedUnderlyings;
      const stockSymbols = (await listActiveFnoStocks()).map((stock) => stock.symbol);
      const zigZagPercent = WAVE_ZIGZAG_PRESETS[SCREENER_HORIZON];
      const sinceMs = Date.now() - SCREENER_LOOKBACK_MS;
      let alertsCreated = 0;

      const scanUniverse = [...indexSymbols, ...stockSymbols];
      let scanned = 0;

      for (const symbol of scanUniverse) {
        // Sampled through the loop, not just either side of the job. This
        // scan runs every 3 minutes and RSS spikes ~1.5GB on exactly that
        // cadence (5 spikes per 15-minute generation, production
        // 2026-08-12), but the loop is already one symbol at a time and
        // `points` goes out of scope each iteration - so nothing here is
        // retaining 216 histories at once, and "batch it" would have been
        // fixing a problem that does not exist.
        //
        // What these samples decide: a steady climb across the loop means
        // the allocator is not returning pages during ~216 back-to-back
        // queries (a periodic yield would help), whereas a jump at one
        // point means a single symbol or step is responsible. Those need
        // opposite fixes, which is why this measures before anything is
        // changed.
        if (scanned % SCAN_MEMORY_SAMPLE_EVERY === 0) {
          logWorkerMemory("wave:screener-scan:progress", { scanned, universeSize: scanUniverse.length });
        }
        if (scanned > 0 && scanned % SCAN_YIELD_EVERY === 0) {
          await sleep(SCAN_YIELD_MS);
        }
        scanned += 1;

        try {
          const isIndex = Boolean(getUnderlyingDefinition(symbol));
          const points: SpotPricePoint[] = isIndex ? await getSpotPriceHistory(symbol, sinceMs) : await getWavePriceHistory(symbol, sinceMs);
          if (points.length < 10) {
            continue;
          }

          const analysis = calculateElliottWave(symbol, points, zigZagPercent);
          const rsi = calculateRsi(points.map((point) => point.price), RSI_PERIOD);
          const rvol = calculateRvol(points);
          const signal = evaluateWaveScreener(analysis, rsi, rvol);
          if (!signal) {
            continue;
          }

          const created = await recordWaveAlertIfNew(
            {
              underlyingSymbol: symbol,
              alertType: signal.alertType,
              horizon: SCREENER_HORIZON,
              stage: signal.stage,
              direction: signal.direction,
              message: signal.message,
              triggeredPrice: signal.triggeredPrice,
              fibRetracementPercent: signal.fibRetracementPercent,
              rvol: signal.rvol,
              rsi: signal.rsi
            },
            ALERT_COOLDOWN_MS
          );
          if (created) {
            alertsCreated += 1;
          }
        } catch (error) {
          console.warn("Elliott Wave screener scan failed for symbol", { symbol, error: error instanceof Error ? error.message : error });
        }
      }

        if (alertsCreated > 0) {
          console.log("Elliott Wave screener scan created new alerts", { alertsCreated, universeSize: indexSymbols.length + stockSymbols.length });
        }
        } finally {
          logWorkerMemory("wave:screener-scan:after", { tookMs: Date.now() - startedAt });
        }
      });
    },
    { connection: redisConnection, concurrency: 1 }
  );
  screenerScanWorker.on("failed", (job, error) => {
    console.error("Elliott Wave screener scan failed", { jobId: job?.id, error });
  });
  screenerScanWorker.on("error", (error) => {
    console.error("Elliott Wave screener scan worker error", error);
  });

  const universeSyncQueueEvents = new QueueEvents(UNIVERSE_SYNC_QUEUE, { connection: redisConnection });
  await Promise.all([
    universeSyncQueue.waitUntilReady(),
    universeSyncWorker.waitUntilReady(),
    universeSyncQueueEvents.waitUntilReady(),
    quoteCaptureQueue.waitUntilReady(),
    quoteCaptureWorker.waitUntilReady(),
    screenerScanQueue.waitUntilReady(),
    screenerScanWorker.waitUntilReady()
  ]);

  await universeSyncQueue.upsertJobScheduler(
    UNIVERSE_SYNC_SCHEDULER_ID,
    { pattern: UNIVERSE_SYNC_CRON_PATTERN, tz: UNIVERSE_SYNC_TIMEZONE },
    { name: UNIVERSE_SYNC_JOB_NAME, data: {}, opts: { attempts: 2, backoff: { type: "exponential", delay: 60_000 } } }
  );
  await quoteCaptureQueue.upsertJobScheduler(
    QUOTE_CAPTURE_SCHEDULER_ID,
    { every: QUOTE_CAPTURE_INTERVAL_MS },
    { name: QUOTE_CAPTURE_JOB_NAME, data: {}, opts: { attempts: 2 } }
  );
  await screenerScanQueue.upsertJobScheduler(
    SCREENER_SCAN_SCHEDULER_ID,
    { every: SCREENER_SCAN_INTERVAL_MS },
    { name: SCREENER_SCAN_JOB_NAME, data: {}, opts: { attempts: 1 } }
  );

  console.log("Elliott Wave screener BullMQ schedulers registered", {
    universeSync: { queue: UNIVERSE_SYNC_QUEUE, pattern: UNIVERSE_SYNC_CRON_PATTERN },
    quoteCapture: { queue: QUOTE_CAPTURE_QUEUE, intervalMs: QUOTE_CAPTURE_INTERVAL_MS },
    screenerScan: { queue: SCREENER_SCAN_QUEUE, intervalMs: SCREENER_SCAN_INTERVAL_MS, horizon: SCREENER_HORIZON }
  });

  return {
    async close() {
      await Promise.allSettled([
        universeSyncWorker.close(),
        universeSyncQueueEvents.close(),
        universeSyncQueue.close(),
        quoteCaptureWorker.close(),
        quoteCaptureQueue.close(),
        screenerScanWorker.close(),
        screenerScanQueue.close()
      ]);
    }
  };
}

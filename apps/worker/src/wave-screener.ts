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
import type { DhanClient } from "@option-decode/dhan";
import type { SpotPricePoint } from "@option-decode/types";
import { isMarketSessionOpen } from "@option-decode/utils";
import { Job, Queue, QueueEvents, Worker as BullWorker } from "bullmq";

const UNIVERSE_SYNC_QUEUE = "wave-fno-universe-sync";
const UNIVERSE_SYNC_JOB_NAME = "sync";
const UNIVERSE_SYNC_SCHEDULER_ID = "wave-fno-universe-sync:sync";
// 07:30 IST, weekdays - ahead of the 09:15 NSE open, so the day's F&O
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

export async function startWaveScreener(redisConnection: { url: string; maxRetriesPerRequest: null }, dhan: DhanClient, mockMarketFeedEnabled: boolean, feedUnderlyings: string[]): Promise<WaveScreenerHandles> {
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

      const quotes = await dhan.getEquityQuotes(resolvable.map((stock) => ({ symbol: stock.symbol, securityId: stock.securityId })));
      const now = new Date();
      const points = resolvable
        .map((stock) => {
          const quote = quotes.get(stock.symbol);
          if (!quote?.lastPrice) {
            return undefined;
          }
          return { underlyingSymbol: stock.symbol, time: now, price: quote.lastPrice, volume: quote.volume };
        })
        .filter((point): point is NonNullable<typeof point> => point !== undefined);

      const stored = await recordWavePricePoints(points);
      if (stored > 0) {
        console.log("Captured F&O stock quotes for Elliott Wave screener", { requested: resolvable.length, quoted: quotes.size, stored });
      }
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
      if (!isMarketSessionOpen("NSE_EQ")) {
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

      for (const symbol of [...indexSymbols, ...stockSymbols]) {
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

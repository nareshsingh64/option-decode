// Paper Trading Pro (seller strategy simulator) - EOD mark-to-market job.
//
// Self-contained BullMQ queue/worker/scheduler so the existing
// market-snapshot and retention pipelines are untouched. Runs once per
// weekday shortly after NSE close (15:45 IST): marks every open SimTrade
// against the latest option-chain ticks, writes a SimMtmSnapshot row
// (idempotent per trade per day), evaluates the seller exit rules
// (profit target / 3x hard stop / DTE<=7 gamma window) as FLAGGED events,
// and settles trades whose expiry has passed at intrinsic value.

import { runSimEodMarkToMarket, runSimIntradayEngine } from "@option-decode/db";
import { isMarketSessionOpen } from "@option-decode/utils";
import { Job, Queue, QueueEvents, Worker as BullWorker } from "bullmq";

const SIM_EOD_QUEUE = "sim-eod-mtm";
const SIM_EOD_JOB_NAME = "mark";
const SIM_EOD_SCHEDULER_ID = "sim-eod-mtm:mark";
// 15:45 IST, Monday-Friday. BullMQ evaluates the pattern in the tz below,
// so this is correct regardless of the host's timezone.
const SIM_EOD_CRON_PATTERN = "45 15 * * 1-5";
const SIM_EOD_TIMEZONE = "Asia/Kolkata";

// Phase 2: intraday engine (automated exits + 5-min MTM sampling). Fires
// every minute; the handler itself no-ops outside the NSE session so the
// schedule stays trivially simple.
const SIM_INTRADAY_QUEUE = "sim-intraday-engine";
const SIM_INTRADAY_JOB_NAME = "evaluate";
const SIM_INTRADAY_SCHEDULER_ID = "sim-intraday-engine:evaluate";
const SIM_INTRADAY_INTERVAL_MS = 60_000;

interface SimEodHandles {
  close(): Promise<void>;
}

export async function startSimEodScheduler(redisConnection: { url: string; maxRetriesPerRequest: null }): Promise<SimEodHandles> {
  const queue = new Queue(SIM_EOD_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
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
  const queueEvents = new QueueEvents(SIM_EOD_QUEUE, { connection: redisConnection });
  const worker = new BullWorker(
    SIM_EOD_QUEUE,
    async (job: Job) => {
      console.log("Processing sim EOD mark-to-market job", {
        jobId: job.id,
        name: job.name,
        attempt: job.attemptsMade + 1
      });
      const result = await runSimEodMarkToMarket();
      console.log("Sim EOD mark-to-market finished", result);
    },
    {
      connection: redisConnection,
      concurrency: 1
    }
  );

  queueEvents.on("completed", ({ jobId }) => {
    console.log("Sim EOD mark-to-market job completed", { jobId });
  });
  queueEvents.on("failed", ({ jobId, failedReason }) => {
    console.error("Sim EOD mark-to-market job failed", { jobId, failedReason });
  });
  worker.on("failed", (job, error) => {
    console.error("Sim EOD mark-to-market worker failure", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error
    });
  });
  worker.on("error", (error) => {
    console.error("Sim EOD mark-to-market worker error", error);
  });

  // Intraday engine: own queue so a slow EOD run can never block or delay
  // exit-rule evaluation, and vice versa.
  const intradayQueue = new Queue(SIM_INTRADAY_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: {
        age: 60 * 60,
        count: 20
      },
      removeOnFail: {
        age: 60 * 60 * 24,
        count: 50
      }
    }
  });
  const intradayWorker = new BullWorker(
    SIM_INTRADAY_QUEUE,
    async (_job: Job) => {
      if (!isMarketSessionOpen("IDX_I")) {
        return;
      }
      const result = await runSimIntradayEngine();
      if (result.autoClosedTrades > 0 || result.sampledTrades > 0) {
        console.log("Sim intraday engine run", result);
      }
    },
    {
      connection: redisConnection,
      concurrency: 1
    }
  );
  intradayWorker.on("failed", (job, error) => {
    console.error("Sim intraday engine failure", {
      jobId: job?.id,
      error
    });
  });
  intradayWorker.on("error", (error) => {
    console.error("Sim intraday engine worker error", error);
  });

  await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), worker.waitUntilReady(), intradayQueue.waitUntilReady(), intradayWorker.waitUntilReady()]);
  await queue.upsertJobScheduler(
    SIM_EOD_SCHEDULER_ID,
    { pattern: SIM_EOD_CRON_PATTERN, tz: SIM_EOD_TIMEZONE },
    {
      name: SIM_EOD_JOB_NAME,
      data: {},
      opts: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 30000
        }
      }
    }
  );
  await intradayQueue.upsertJobScheduler(
    SIM_INTRADAY_SCHEDULER_ID,
    { every: SIM_INTRADAY_INTERVAL_MS },
    {
      name: SIM_INTRADAY_JOB_NAME,
      data: {},
      opts: { attempts: 1 }
    }
  );

  console.log("Sim EOD mark-to-market BullMQ scheduler registered", {
    queue: SIM_EOD_QUEUE,
    schedulerId: SIM_EOD_SCHEDULER_ID,
    pattern: SIM_EOD_CRON_PATTERN,
    tz: SIM_EOD_TIMEZONE
  });
  console.log("Sim intraday engine BullMQ scheduler registered", {
    queue: SIM_INTRADAY_QUEUE,
    schedulerId: SIM_INTRADAY_SCHEDULER_ID,
    intervalMs: SIM_INTRADAY_INTERVAL_MS
  });

  return {
    async close() {
      await Promise.allSettled([worker.close(), intradayWorker.close(), queueEvents.close(), queue.close(), intradayQueue.close()]);
    }
  };
}

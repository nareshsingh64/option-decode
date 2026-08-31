// Live Order module - reconciliation timer.
//
// Dhan is the source of truth for orders and positions; our rows are a cache of
// it. Nothing else keeps that cache honest, so without this job the panel shows
// whatever was true at the instant an order was placed. That is how a filled
// bear call spread sat reading SENT/TRANSIT with zero filled quantity, no
// position and no P&L, while both legs were live at the broker.
//
// Own queue, deliberately. A slow reconcile must not delay market-snapshot
// capture, and a stuck capture must not stop us learning that an order filled.
//
// SESSION GATED. Outside market hours nothing changes at the broker, so polling
// then would spend each user's own Dhan rate budget to re-learn the same thing.
// The gate is "either NSE or MCX is open" rather than NSE alone, because a
// commodity position is live until 23:30 - the same widening the wave screener
// needed, and the same trap: widening a job's gate does not widen what the job
// looks at, so the per-account skip below still does the narrowing.

import { reconcileAllLiveAccounts } from "@option-decode/db";
import { isMarketSessionOpen } from "@option-decode/utils";
import { Job, Queue, Worker as BullWorker } from "bullmq";

const LIVE_RECONCILE_QUEUE = "live-reconcile";
const LIVE_RECONCILE_JOB_NAME = "sweep";
const LIVE_RECONCILE_SCHEDULER_ID = "live-reconcile:sweep";

// 20s. The design targets 5s while an order is working and 30s idle; a single
// cadence is simpler and this sits between them. The job skips accounts with
// nothing outstanding, so an idle deployment costs one Redis wakeup and zero
// Dhan calls. Tighten only with a reason - each tick is two broker calls per
// ACTIVE account, drawn from that user's own budget.
const LIVE_RECONCILE_INTERVAL_MS = 20_000;

export interface LiveReconcileHandles {
  queue: Queue;
  worker: BullWorker;
}

export async function startLiveReconcileScheduler(redisConnection: {
  url: string;
  maxRetriesPerRequest: null;
}): Promise<LiveReconcileHandles> {
  const queue = new Queue(LIVE_RECONCILE_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      // No retries: the next tick is 20 seconds away and will see the same
      // state. Retrying a broker read achieves nothing a wait would not.
      attempts: 1,
      removeOnComplete: { age: 60 * 30, count: 50 },
      removeOnFail: { age: 60 * 60 * 24, count: 50 }
    }
  });

  const worker = new BullWorker(
    LIVE_RECONCILE_QUEUE,
    async (_job: Job) => {
      if (!isMarketSessionOpen("IDX_I") && !isMarketSessionOpen("MCX_COMM")) {
        return;
      }

      const sweep = await reconcileAllLiveAccounts();

      // Quiet when nothing changed. A line every 20 seconds saying "nothing
      // happened" buries the lines that matter, and this log is read after
      // incidents.
      if (sweep.ordersUpdated || sweep.positionsUpserted || sweep.positionsClosed) {
        console.log("Live reconcile sweep", {
          accountsReconciled: sweep.accountsReconciled,
          accountsSkipped: sweep.accountsSkipped,
          ordersUpdated: sweep.ordersUpdated,
          positionsUpserted: sweep.positionsUpserted,
          positionsClosed: sweep.positionsClosed
        });
      }

      // Drift means our view and the broker's disagreed. It is always worth a
      // line: it is either a bug here or something acting on the account from
      // outside this app, and both need to be visible.
      for (const line of sweep.drift) {
        console.warn("Live reconcile drift", { detail: line });
      }
      // A failing account is usually an expired token - routine, since they
      // live 24 hours - but it means that user's panel is stale and they are
      // not being told by anything else yet.
      for (const line of sweep.errors) {
        console.warn("Live reconcile could not reach the broker", { detail: line });
      }
    },
    { connection: redisConnection, concurrency: 1 }
  );

  worker.on("failed", (job, error) => {
    console.error("Live reconcile failure", { jobId: job?.id, error });
  });
  worker.on("error", (error) => {
    console.error("Live reconcile worker error", error);
  });

  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
  await queue.upsertJobScheduler(
    LIVE_RECONCILE_SCHEDULER_ID,
    { every: LIVE_RECONCILE_INTERVAL_MS },
    { name: LIVE_RECONCILE_JOB_NAME, data: {}, opts: { attempts: 1 } }
  );

  console.log("Live reconcile BullMQ scheduler registered", {
    queue: LIVE_RECONCILE_QUEUE,
    schedulerId: LIVE_RECONCILE_SCHEDULER_ID,
    everyMs: LIVE_RECONCILE_INTERVAL_MS
  });

  return { queue, worker };
}

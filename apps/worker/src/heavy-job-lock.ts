/**
 * One-at-a-time gate for the worker's memory-heavy jobs.
 *
 * Why this exists, measured rather than assumed. Splitting the option-chain
 * capture into one job per underlying dropped the mean per-job native
 * allocation from +873MB to +18MB, but ~3% of jobs still burst ~1GB, and the
 * bursts were not proportional to chain size at all - COPPER's 138-tick
 * chain burst 994MB while its 738-tick BANKNIFTY neighbour averaged -43MB.
 *
 * What did predict a burst was overlap. Across ~1,500 post-split captures
 * (production, 2026-08-12):
 *
 *   wave screener ran during the job:  25 bursts / 102 jobs  = 24.5%
 *   it did not:                        21 bursts / 1412 jobs =  1.5%
 *
 * A ~16x higher burst rate, from a component that overlaps only 6.7% of
 * jobs but accounts for 54% of all bursts. The worker runs four BullMQ
 * workers in ONE process (market-snapshot, quote-capture, screener-scan,
 * universe-sync); each is concurrency:1 on its own, which says nothing
 * about them running against each other. So two large native allocations
 * were routinely live at the same time, and the host pays for the sum.
 *
 * This is deliberately a plain in-process promise chain, not a Redis lock:
 * every one of those workers is in the same process, so the cheap thing is
 * also the correct thing.
 *
 * FIFO by construction - each caller chains onto the previous one - so a
 * frequent job cannot starve a rarer one. Failures do not poison the chain:
 * the next waiter runs whether the previous settled or threw.
 */

let tail: Promise<unknown> = Promise.resolve();

// Waiting longer than this is worth knowing about: it means one heavy job is
// holding the process long enough to delay the 30s capture cadence, which is
// the failure mode to watch for after enabling this.
const SLOW_WAIT_LOG_MS = 2_000;

export function runExclusive<T>(label: string, run: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();

  const start = async (): Promise<T> => {
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs >= SLOW_WAIT_LOG_MS) {
      console.log("Heavy job waited for the serialization lock", { label, waitedMs });
    }
    return run();
  };

  // Chain onto whatever is in flight, running on both fulfilment and
  // rejection so one thrown job cannot wedge every later one.
  const result = tail.then(start, start);
  tail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

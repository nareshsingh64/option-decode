/**
 * Node/V8 memory breakdown, plus the number that actually matters here.
 *
 * Lives in its own module so both worker.ts and wave-screener.ts can log it
 * without an import cycle (worker.ts imports wave-screener.ts).
 *
 * What this instrumentation established (production, 2026-08-11/12, 20s
 * sampling plus per-job brackets):
 *
 *   RSS=2907MB  heapUsed=133MB  heapTotal=163MB  external=9.4MB  arrayBuffers=2.3MB
 *   RSS= 225MB  heapUsed= 82MB  heapTotal=115MB  external=7.9MB  arrayBuffers=0.7MB
 *
 * 1. **Not the JS heap.** heapTotal never exceeds ~165MB while RSS reaches
 *    2.9GB, so `--max-old-space-size` does nothing here - the cap would
 *    never bind. Don't reach for it.
 * 2. **Not a leak.** RSS returns to ~225MB unaided. The cost is a transient
 *    PEAK on a 3.8GB host shared with api/web/MySQL/Redis, not a ratchet.
 * 3. **Not ArrayBuffers.** external/arrayBuffers stay under 10MB, which
 *    retires the DhanLiveFeedClient theory the original logging was added
 *    to test.
 *
 * `nativeGapMb` is RSS minus everything Node can account for - native
 * allocation outside V8. It is the quantity that moves: ~100MB at rest,
 * ~2.7GB at peak.
 */
export function logWorkerMemory(label: string, extra?: Record<string, unknown>): void {
  const mem = process.memoryUsage();
  const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  const nativeGapMb = toMb(mem.rss - mem.heapTotal - mem.external - mem.arrayBuffers);
  console.log("Worker memory usage", {
    // console.log writes no timestamp of its own, and these lines are not
    // pino JSON, so until this was added the only way to place a sample in
    // time was to count lines between "Option Decode worker starting"
    // markers. That made "did the peak move after the 10:17 deploy?" far
    // harder to answer than it should have been - every comparison had to be
    // per-restart-generation rather than per clock window.
    ts: new Date().toISOString(),
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

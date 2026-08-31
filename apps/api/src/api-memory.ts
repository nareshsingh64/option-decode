/**
 * Periodic memory sampling for the API, mirroring the worker's.
 *
 * The worker has had this since the August investigation; the API never did, so
 * when its cgroup memory rose from ~330 MB to ~480 MB over the Live Order work
 * there was nothing to say WHY. A number without a breakdown tells you
 * something moved and not what - and the worker hunt showed exactly how far
 * that gets you: three weeks were spent on theories because RSS was the only
 * visible quantity.
 *
 * Same field names as logWorkerMemory on purpose, so the existing tooling and,
 * more importantly, the existing knowledge transfers unchanged. In particular:
 *
 *   - heapTotalMb rising means it IS the JS heap, and --max-old-space-size
 *     becomes relevant. On the worker it never was.
 *   - nativeGapMb rising means native allocation outside V8's accounting, which
 *     is where the worker's problem actually lived (ICU, via a per-call
 *     Intl.DateTimeFormat). That fingerprint identifies a CLASS of allocator,
 *     not a component - every native library the process links satisfies it -
 *     so it narrows the search without ending it.
 *
 * The API is request-driven rather than job-driven, so unlike the worker there
 * are no natural brackets to sample around. A fixed interval is the honest
 * substitute: it cannot attribute a rise to a particular request, but it does
 * establish whether one is happening at all.
 */

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

export function startApiMemorySampling(): NodeJS.Timeout {
  const sample = () => {
    const mem = process.memoryUsage();
    const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
    console.log("Api memory usage", {
      // An explicit timestamp because these are console.log lines rather than
      // pino JSON, so they carry none of their own - and without one, placing a
      // sample relative to a deploy means counting lines between startup
      // markers, which is what made the worker's comparisons per-generation
      // instead of per-clock-window.
      ts: new Date().toISOString(),
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      heapTotalMb: toMb(mem.heapTotal),
      externalMb: toMb(mem.external),
      arrayBuffersMb: toMb(mem.arrayBuffers),
      nativeGapMb: toMb(mem.rss - mem.heapTotal - mem.external - mem.arrayBuffers)
    });
  };

  sample();
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  // Never hold the process open for a sample: this is diagnostics, and it must
  // not be the reason a shutdown hangs.
  timer.unref();
  return timer;
}

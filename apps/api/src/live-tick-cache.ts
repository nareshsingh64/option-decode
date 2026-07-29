// Read-only counterpart to apps/worker/src/live-tick-cache.ts - this app
// never writes ticks (only the worker's DhanLiveFeedClient does), it just
// reads whatever the worker has cached. Kept as its own small duplicate
// rather than a shared package - see the worker-side file's header
// comment for why.

import type { DhanLiveFeedExchangeSegment, DhanLiveFeedTick } from "@option-decode/dhan";
import type Redis from "ioredis";

// Matches apps/worker/src/live-tick-cache.ts's LIVE_TICK_STALENESS_MS -
// keep these two in sync if either changes.
const LIVE_TICK_STALENESS_MS = 45_000;

function liveTickCacheKey(segment: DhanLiveFeedExchangeSegment, securityId: number): string {
  return `feed:tick:${segment}:${securityId}`;
}

function isFreshEnough(tick: DhanLiveFeedTick): boolean {
  return Date.now() - tick.receivedAt <= LIVE_TICK_STALENESS_MS;
}

export async function getLiveTicks(redis: Redis, keys: Array<{ segment: DhanLiveFeedExchangeSegment; securityId: number }>): Promise<Map<string, DhanLiveFeedTick>> {
  const result = new Map<string, DhanLiveFeedTick>();
  if (!keys.length) {
    return result;
  }

  const values = await redis.mget(keys.map((key) => liveTickCacheKey(key.segment, key.securityId)));
  values.forEach((raw, index) => {
    if (!raw) {
      return;
    }
    try {
      const tick = JSON.parse(raw) as DhanLiveFeedTick;
      if (isFreshEnough(tick)) {
        const key = keys[index];
        result.set(`${key.segment}:${key.securityId}`, tick);
      }
    } catch {
      // Malformed cache entry - treat as a miss, caller falls back to REST.
    }
  });
  return result;
}

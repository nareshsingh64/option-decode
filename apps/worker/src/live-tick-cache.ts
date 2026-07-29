// Small Redis-backed cache for Dhan Live Market Feed ticks (see
// @option-decode/dhan's DhanLiveFeedClient) - written by worker.ts's feed
// onTick callback, read by both worker.ts (spot-price overrides) and
// wave-screener.ts (F&O stock quote capture), both in this same app.
// apps/api/src/server.ts has its own small equivalent for the dashboard
// ticker - not worth a new workspace package for ~30 lines shared by two
// apps total.

import type { DhanLiveFeedExchangeSegment, DhanLiveFeedTick } from "@option-decode/dhan";
import type Redis from "ioredis";

// A cached tick older than this is treated as "the feed doesn't have
// fresh data for this instrument right now" and callers should fall back
// to their existing REST call. This is judged off receivedAt (when THIS
// client got the packet), not Dhan's own ltt (last-trade-time) - a quiet
// instrument's last trade can legitimately be old while the feed
// connection itself is perfectly healthy.
export const LIVE_TICK_STALENESS_MS = 45_000;
const LIVE_TICK_CACHE_TTL_SEC = 90;

function liveTickCacheKey(segment: DhanLiveFeedExchangeSegment, securityId: number): string {
  return `feed:tick:${segment}:${securityId}`;
}

// Ticker/Quote/PrevClose arrive as SEPARATE packets for the same
// instrument (see live-feed.ts) - each onTick call only carries the
// fields that particular packet type reports. Merge onto whatever's
// already cached rather than overwrite, so e.g. a PrevClose-only packet
// doesn't wipe out the ltp/volume a Quote packet just wrote a moment
// earlier. JSON.stringify drops undefined-valued keys, so a partial
// tick's absent fields never clobber previously-known values here.
export async function cacheLiveTick(redis: Redis, tick: DhanLiveFeedTick): Promise<void> {
  const key = liveTickCacheKey(tick.exchangeSegment, tick.securityId);
  const existingRaw = await redis.get(key);
  let merged: DhanLiveFeedTick = tick;
  if (existingRaw) {
    try {
      merged = { ...(JSON.parse(existingRaw) as DhanLiveFeedTick), ...tick };
    } catch {
      merged = tick;
    }
  }
  await redis.set(key, JSON.stringify(merged), "EX", LIVE_TICK_CACHE_TTL_SEC);
}

function isFreshEnough(tick: DhanLiveFeedTick): boolean {
  return Date.now() - tick.receivedAt <= LIVE_TICK_STALENESS_MS;
}

export async function getLiveTick(redis: Redis, segment: DhanLiveFeedExchangeSegment, securityId: number): Promise<DhanLiveFeedTick | undefined> {
  const raw = await redis.get(liveTickCacheKey(segment, securityId));
  if (!raw) {
    return undefined;
  }
  try {
    const tick = JSON.parse(raw) as DhanLiveFeedTick;
    return isFreshEnough(tick) ? tick : undefined;
  } catch {
    return undefined;
  }
}

// Batch read via MGET - used for the ~200-stock wave-screener quote
// capture so that's one Redis round trip instead of one per stock.
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

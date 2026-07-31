// Lightweight price+volume series for the Elliott Wave screener's F&O stock
// coverage - see WavePricePoint's schema comment for why this is a separate
// table from OptionChainSnapshot. Indices/commodities keep reading
// getSpotPriceHistory (market-repository.ts) instead; this repository is
// only ever written to by the wave-stock-quote-capture worker job.

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { SpotPricePoint } from "@option-decode/types";
import { prisma } from "./index.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface WavePricePointInput {
  underlyingSymbol: string;
  time: Date;
  price: number;
  volume?: number;
}

const MAX_WAVE_PRICE_HISTORY_ROWS = 3_000;

// See the matching comment on TICK_INSERT_CHUNK_SIZE in market-repository.ts -
// this call site has the same "row count varies every call" shape (the
// number of stocks that returned a valid quote this cycle fluctuates), and
// was one of the two call sites confirmed to be driving the worker's
// unbounded native (non-V8) memory growth via Prisma's per-shape prepared
// statement cache.
//
// A first attempt just chunked via Array.slice, which does not actually
// bound the shape count (see the longer explanation in
// market-repository.ts) - verified in production, growth slowed but did
// not stop. insertInFixedShapes guarantees every createMany call has
// exactly WAVE_PRICE_INSERT_CHUNK_SIZE rows, with the remainder written
// via individual single-row create() calls instead of a variably-sized
// createMany - bounding this call site to exactly 2 SQL shapes forever.
const WAVE_PRICE_INSERT_CHUNK_SIZE = 50;

async function insertInFixedShapes<T>(
  rows: T[],
  chunkSize: number,
  createMany: (batch: T[]) => Promise<{ count: number }>,
  createOne: (row: T) => Promise<unknown>
): Promise<number> {
  let count = 0;
  let i = 0;
  for (; i + chunkSize <= rows.length; i += chunkSize) {
    const result = await createMany(rows.slice(i, i + chunkSize));
    count += result.count;
  }
  for (; i < rows.length; i += 1) {
    try {
      await createOne(rows[i]);
      count += 1;
    } catch (error) {
      // Individual create() has no skipDuplicates option - replicate the
      // batched createMany's skip-on-duplicate behavior by swallowing
      // only the unique-constraint violation (P2002), same as before.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
    }
  }
  return count;
}

export async function recordWavePricePoints(points: WavePricePointInput[], client: PrismaClient = prisma): Promise<number> {
  if (!points.length) {
    return 0;
  }

  const rows = points.map((point) => ({
    underlyingSymbol: point.underlyingSymbol,
    time: point.time,
    price: point.price,
    volume: point.volume !== undefined && Number.isFinite(point.volume) ? BigInt(Math.round(point.volume)) : null
  }));

  return insertInFixedShapes(
    rows,
    WAVE_PRICE_INSERT_CHUNK_SIZE,
    (batch) => client.wavePricePoint.createMany({ data: batch, skipDuplicates: true }),
    (row) => client.wavePricePoint.create({ data: row })
  );
}

export async function getWavePriceHistory(underlyingSymbol: string, sinceMs: number, limit = 1000, client: DbClient = prisma): Promise<SpotPricePoint[]> {
  const rows = await client.wavePricePoint.findMany({
    where: {
      underlyingSymbol,
      time: { gte: new Date(sinceMs) }
    },
    orderBy: { time: "desc" },
    take: Math.max(1, Math.min(MAX_WAVE_PRICE_HISTORY_ROWS, limit)),
    select: {
      time: true,
      price: true,
      volume: true
    }
  });

  return rows
    .reverse()
    .map((row) => ({
      time: row.time.toISOString(),
      price: row.price.toNumber(),
      volume: row.volume === null ? undefined : Number(row.volume)
    }));
}

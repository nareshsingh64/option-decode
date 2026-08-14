import { calculatePressureScore } from "@option-decode/analytics";
import { getFallbackLotSize } from "@option-decode/types";
import type { MarketPulsePoint, OptionChainSnapshot, OptionContractTick, SpotPricePoint } from "@option-decode/types";
import type { OptionType, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { insertInFixedShapes } from "./insert-in-fixed-shapes.js";
import { prisma } from "./index.js";
import { getStoredFnoLotSize } from "./lot-size-repository.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

// Prisma's native query engine (loaded in-process, not a separate binary)
// caches a compiled prepared statement per distinct SQL shape it sees, and
// createMany()'s generated SQL has a placeholder count proportional to row
// count - so calling it with a different row count every time (as we do
// here, since strike counts per snapshot vary by underlying/expiry/day)
// creates a new, permanently-cached statement on every call. Confirmed in
// production (2026-07-31): this was the root cause of the worker process's
// RSS growing to 6-7GB within minutes on a fresh restart while
// process.memoryUsage() reported under 200MB - the growth was a single
// unbounded native malloc arena (visible via `pmap -x`, invisible to
// Node's own memory APIs) driven by exactly this cache. See
// insertInFixedShapes (insert-in-fixed-shapes.ts) for how this is bounded.
const TICK_INSERT_CHUNK_SIZE = 50;

// Filtering OptionChainSnapshot via a nested `expiry: { expiryLabel }`
// relation (instead of expiryId directly) prevented MySQL from using the
// [underlyingSymbol, expiryId, snapshotTime] composite index that exists
// specifically for this lookup - confirmed via EXPLAIN in production, it
// fell back to the less selective [underlyingSymbol, snapshotTime] index
// and scanned thousands of rows for a single-snapshot lookup (this was
// the real cause of the slow symbol-switch complaint, not a missing
// index - the index existed, the query just couldn't reach it). Expiry
// itself is tiny (tens of rows per underlying), so resolving the label to
// an id first is effectively free, and then filtering
// OptionChainSnapshot by that id directly lets the existing index do its
// job. Returns undefined if no matching expiry exists.
async function resolveExpiryId(underlyingSymbol: string, expiryLabel: string, client: DbClient): Promise<string | undefined> {
  const expiry = await client.expiry.findFirst({
    where: {
      expiryLabel,
      underlying: { symbol: underlyingSymbol }
    },
    select: { id: true }
  });
  return expiry?.id;
}

// Resolves the "current" (nearest, soonest-expiring) contract to serve when
// no expiry is explicitly requested. Without this, getLatestOptionChainSnapshot
// picked whichever expiry had the globally most recent snapshotTime across
// ALL of this underlying's expiries - and since the worker's captureOnce
// always saves the next-nearest expiry's snapshot a few seconds AFTER
// saving the current expiry's (see worker.ts), the next expiry's
// snapshotTime was always slightly newer. Every default (no-expiry-param)
// request was silently serving next week's chain instead of the current
// one. Filters to expiryDate >= today the same way listStoredExpiries
// does, so an expired contract that hasn't rolled off yet is never picked.
async function resolveNearestExpiryId(underlyingSymbol: string, client: DbClient): Promise<string | undefined> {
  const expiry = await client.expiry.findFirst({
    where: {
      underlying: { symbol: underlyingSymbol },
      active: true,
      expiryDate: { gte: todayInMarketTimezone() }
    },
    orderBy: { expiryDate: "asc" },
    select: { id: true }
  });
  return expiry?.id;
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? value : value.toNumber();
}

// Greeks/IV come straight from Dhan's feed with no validation on their side
// - confirmed in production: a SILVER contract (illiquid far strike) once
// returned a theta value whose magnitude blew past this column's
// DECIMAL(10,6) capacity (max ~9999.999999) and threw P2020, which failed
// the ENTIRE snapshot's createMany() batch (one bad tick poisons every tick
// in that transaction, not just its own row). A real greek value is never
// remotely close to this threshold - delta is bounded to [-1, 1], and
// theta/gamma/vega are small per-unit numbers - so treating an
// out-of-range reading as "the feed sent garbage for this one leg" (store
// null, keep the rest of the snapshot) is correct, not just a workaround.
const GREEK_MAX_ABS = 9999;

function sanitizeGreek(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) > GREEK_MAX_ABS) {
    return undefined;
  }
  return value;
}

async function getLotSizeForExpiry(underlyingSymbol: string, expiryLabel: string, client: DbClient): Promise<number> {
  return (await getStoredFnoLotSize(underlyingSymbol, expiryLabel, client)) ?? getFallbackLotSize(underlyingSymbol);
}


function tickReferenceKey(tick: { optionType: OptionType; strikePrice: Prisma.Decimal }): string {
  return `${tick.optionType}:${tick.strikePrice.toString()}`;
}

async function getLastPriceReferenceMap(
  ticks: Array<{
    optionType: OptionType;
    strikePrice: Prisma.Decimal;
  }>,
  underlyingSymbol: string,
  expiryId: string,
  expiryLabel: string,
  tradingDate: Date,
  snapshotTime: Date,
  client: DbClient
): Promise<Map<string, number>> {
  const references = new Map<string, number>();
  const strikePrices = [...new Map(ticks.map((tick) => [tick.strikePrice.toString(), tick.strikePrice])).values()];

  if (!strikePrices.length) {
    return references;
  }

  const previousSession = await client.optionChainSnapshot.findFirst({
    where: {
      underlyingSymbol,
      expiryId,
      tradingDate: {
        lt: tradingDate
      }
    },
    orderBy: [{ tradingDate: "desc" }, { snapshotTime: "desc" }],
    select: {
      id: true
    }
  });

  if (previousSession) {
    const previousTicks = await getSnapshotReferenceTicks(previousSession.id, strikePrices, client);

    for (const tick of previousTicks) {
      const key = tickReferenceKey(tick);
      const lastPrice = toNumber(tick.lastPrice);
      if (!references.has(key) && lastPrice !== undefined) {
        references.set(key, lastPrice);
      }
    }
  }

  const missingReference = ticks.some((tick) => !references.has(tickReferenceKey(tick)));
  if (missingReference) {
    const sessionOpenSnapshot = await client.optionChainSnapshot.findFirst({
      where: {
        underlyingSymbol,
        expiryId,
        tradingDate,
        snapshotTime: {
          lte: snapshotTime
        }
      },
      orderBy: { snapshotTime: "asc" },
      select: {
        id: true
      }
    });
    const sessionOpenTicks = sessionOpenSnapshot ? await getSnapshotReferenceTicks(sessionOpenSnapshot.id, strikePrices, client) : [];

    for (const tick of sessionOpenTicks) {
      const key = tickReferenceKey(tick);
      const lastPrice = toNumber(tick.lastPrice);
      if (!references.has(key) && lastPrice !== undefined) {
        references.set(key, lastPrice);
      }
    }
  }

  return references;
}

async function getSnapshotReferenceTicks(snapshotId: string, strikePrices: Prisma.Decimal[], client: DbClient) {
  return client.optionContractTick.findMany({
    where: {
      snapshotId,
      strikePrice: {
        in: strikePrices
      },
      lastPrice: {
        not: null
      }
    },
    select: {
      optionType: true,
      strikePrice: true,
      lastPrice: true
    }
  });
}

/**
 * Reference values from TODAY's own opening snapshot (the earliest
 * snapshot of the current tradingDate, at or before the current
 * snapshotTime) - distinct from getLastPriceReferenceMap above, which
 * compares against the previous day's close for the conventional "day
 * change" figures shown throughout the UI. This one feeds
 * calculateStrikeTrend's "movement" indicator specifically, so it answers
 * "what has today's activity done to this strike so far" rather than
 * "how does today compare to yesterday."
 *
 * Two earlier approaches were tried and rejected here: comparing against
 * the single immediately-preceding snapshot (SNAPSHOT_INTERVAL_MS
 * default 30s) was pure bid/ask noise - every strike near the money
 * shares exposure to the same underlying's short-term jitter, so the
 * whole ATM +/-4 window flipped Flat/support/resistance in lockstep on
 * every poll. Widening that to a rolling 5-minute window reduced the
 * noise but was judged too short-horizon to read genuine day-basis
 * market direction. Anchoring to session open instead means the
 * reference point never moves during the day: the signal only reflects
 * real cumulative drift since this morning, builds progressively as the
 * session develops, and naturally reads Flat right at market open
 * (correct - there's no "today's activity" yet) without ever getting
 * stuck the way a vs-yesterday comparison could.
 */
async function getSessionOpenReferenceMap(
  ticks: Array<{
    optionType: OptionType;
    strikePrice: Prisma.Decimal;
  }>,
  underlyingSymbol: string,
  expiryId: string,
  tradingDate: Date,
  snapshotTime: Date,
  client: DbClient
): Promise<Map<string, { lastPrice?: number; openInterest?: number }>> {
  const references = new Map<string, { lastPrice?: number; openInterest?: number }>();
  const strikePrices = [...new Map(ticks.map((tick) => [tick.strikePrice.toString(), tick.strikePrice])).values()];

  if (!strikePrices.length) {
    return references;
  }

  const sessionOpenSnapshot = await client.optionChainSnapshot.findFirst({
    where: {
      underlyingSymbol,
      expiryId,
      tradingDate,
      snapshotTime: {
        lte: snapshotTime
      }
    },
    orderBy: { snapshotTime: "asc" },
    select: { id: true }
  });

  if (!sessionOpenSnapshot) {
    return references;
  }

  const referenceTicks = await client.optionContractTick.findMany({
    where: {
      snapshotId: sessionOpenSnapshot.id,
      strikePrice: {
        in: strikePrices
      }
    },
    select: {
      optionType: true,
      strikePrice: true,
      lastPrice: true,
      openInterest: true
    }
  });

  for (const tick of referenceTicks) {
    references.set(tickReferenceKey(tick), {
      lastPrice: toNumber(tick.lastPrice),
      openInterest: toNumber(tick.openInterest)
    });
  }

  return references;
}

function labelToDate(label: string): Date {
  return dateOnly(label);
}

// Expiry rows are upserted with active:true every time the worker captures a
// snapshot for that expiry, but a past expiry is never flipped back to
// inactive once the worker rolls on to the next contract. Left unfiltered,
// listStoredExpiries would keep returning long-expired dates forever (sorted
// oldest-first), which gets picked as "the" default expiry by callers and
// then fails to match any current snapshot - silently falling back to demo
// or empty data. Filtering to expiryDate >= today (IST, matching the
// exchange calendar) keeps the list limited to contracts that can actually
// still have live data.
function todayInMarketTimezone(): Date {
  const isoDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  return dateOnly(isoDate);
}

export async function saveOptionChainSnapshot(snapshot: OptionChainSnapshot, client: PrismaClient = prisma): Promise<string> {
  const pressure = calculatePressureScore(snapshot);
  const expiryDate = labelToDate(snapshot.expiry);
  const tradingDate = dateOnly(snapshot.tradingDate);
  const snapshotTime = new Date(snapshot.snapshotTime);

  // Underlying/expiry/contract metadata upserts run against the pool
  // (not inside the transaction below) and the per-tick contract upserts
  // run concurrently instead of one-at-a-time. This used to be ~100-200
  // sequential awaits on a single connection inside one interactive
  // transaction (Prisma transactions are pinned to one connection, so they
  // can't run concurrently anyway) — every 30s, per underlying. Contract
  // metadata (lot size / security id / active flag) is idempotent, so it's
  // safe for it to happen outside the atomic snapshot write: if it's ever
  // interrupted, the next snapshot save corrects it.
  const underlying = await client.underlying.upsert({
    where: { symbol: snapshot.underlyingSymbol },
    update: { active: true },
    create: {
      symbol: snapshot.underlyingSymbol,
      displayName: snapshot.underlyingSymbol,
      exchange: "NSE"
    }
  });

  const expiry = await client.expiry.upsert({
    where: {
      underlyingId_expiryDate: {
        underlyingId: underlying.id,
        expiryDate
      }
    },
    update: {
      expiryLabel: snapshot.expiry,
      active: true
    },
    create: {
      underlyingId: underlying.id,
      expiryDate,
      expiryLabel: snapshot.expiry
    }
  });

  const storedLotSize = await getLotSizeForExpiry(snapshot.underlyingSymbol, snapshot.expiry, client);
  await Promise.all(
    snapshot.ticks.map((tick) => {
      const lotSize = storedLotSize ?? tick.lotSize;
      return client.optionContract.upsert({
        where: {
          expiryId_optionType_strikePrice: {
            expiryId: expiry.id,
            optionType: tick.optionType,
            strikePrice: tick.strikePrice
          }
        },
        update: {
          securityId: tick.securityId ?? undefined,
          lotSize,
          active: true
        },
        create: {
          expiryId: expiry.id,
          optionType: tick.optionType,
          strikePrice: tick.strikePrice,
          securityId: tick.securityId,
          lotSize,
          active: true
        }
      });
    })
  );

  let sanitizedTickCount = 0;
  const tickRows = snapshot.ticks.map((tick) => {
    const impliedVolatility = sanitizeGreek(tick.impliedVolatility);
    const deltaValue = sanitizeGreek(tick.delta);
    const gammaValue = sanitizeGreek(tick.gamma);
    const thetaValue = sanitizeGreek(tick.theta);
    const vegaValue = sanitizeGreek(tick.vega);
    if (
      (tick.impliedVolatility !== undefined && impliedVolatility === undefined) ||
      (tick.delta !== undefined && deltaValue === undefined) ||
      (tick.gamma !== undefined && gammaValue === undefined) ||
      (tick.theta !== undefined && thetaValue === undefined) ||
      (tick.vega !== undefined && vegaValue === undefined)
    ) {
      sanitizedTickCount += 1;
    }

    return {
      tradingDate,
      tickTime: new Date(tick.tickTime),
      underlyingSymbol: tick.underlyingSymbol,
      expiryLabel: tick.expiry,
      optionType: tick.optionType,
      strikePrice: tick.strikePrice,
      securityId: tick.securityId,
      lastPrice: tick.lastPrice,
      bidPrice: tick.bidPrice,
      askPrice: tick.askPrice,
      volume: tick.volume,
      openInterest: tick.openInterest,
      changeInOpenInterest: tick.changeInOpenInterest,
      impliedVolatility,
      deltaValue,
      gammaValue,
      thetaValue,
      vegaValue
    };
  });

  if (sanitizedTickCount > 0) {
    console.warn("Dropped out-of-range greek/IV value(s) from Dhan feed before persisting", {
      underlyingSymbol: snapshot.underlyingSymbol,
      expiry: snapshot.expiry,
      affectedTicks: sanitizedTickCount,
      totalTicks: snapshot.ticks.length
    });
  }

  const saved = await client.$transaction(async (tx: Prisma.TransactionClient) => {
    const createdSnapshot = await tx.optionChainSnapshot.create({
      data: {
        tradingDate,
        snapshotTime,
        underlyingSymbol: snapshot.underlyingSymbol,
        expiryId: expiry.id,
        spotPrice: snapshot.spotPrice,
        atmStrike: snapshot.atmStrike,
        source: "DHAN"
      }
    });

    const tickRowsWithSnapshotId = tickRows.map((row) => ({ ...row, snapshotId: createdSnapshot.id }));
    await insertInFixedShapes(
      tickRowsWithSnapshotId,
      TICK_INSERT_CHUNK_SIZE,
      (batch) => tx.optionContractTick.createMany({ data: batch }),
      (row) => tx.optionContractTick.create({ data: row })
    );

    await tx.pressureScore.create({
      data: {
        snapshotId: createdSnapshot.id,
        underlyingSymbol: snapshot.underlyingSymbol,
        expiryLabel: snapshot.expiry,
        scoreTime: snapshotTime,
        bullishPressure: pressure.bullishPressure,
        bearishPressure: pressure.bearishPressure,
        pcr: pressure.pcr,
        maxPain: pressure.maxPain,
        payloadJson: pressure as unknown as Prisma.InputJsonValue
      }
    });

    return createdSnapshot;
  });

  return saved.id;
}

export async function listStoredExpiries(underlyingSymbol = "NIFTY", client: DbClient = prisma): Promise<string[]> {
  const expiries = await client.expiry.findMany({
    where: {
      underlying: {
        symbol: underlyingSymbol
      },
      active: true,
      expiryDate: { gte: todayInMarketTimezone() }
    },
    orderBy: { expiryDate: "asc" }
  });

  return expiries.map((expiry) => expiry.expiryLabel);
}

export async function getLatestSpotChange(underlyingSymbol: string, client: DbClient = prisma) {
  const latest = await client.optionChainSnapshot.findFirst({
    where: { underlyingSymbol },
    orderBy: { snapshotTime: "desc" },
    select: {
      spotPrice: true,
      snapshotTime: true,
      tradingDate: true
    }
  });

  if (!latest) {
    return null;
  }

  const previous = await client.optionChainSnapshot.findFirst({
    where: {
      underlyingSymbol,
      tradingDate: {
        lt: latest.tradingDate
      }
    },
    orderBy: { snapshotTime: "desc" },
    select: {
      spotPrice: true,
      snapshotTime: true,
      tradingDate: true
    }
  });

  const spotPrice = latest.spotPrice.toNumber();
  const previousClose = previous?.spotPrice.toNumber();
  const change = previousClose !== undefined ? spotPrice - previousClose : undefined;

  return {
    spotPrice,
    previousClose,
    change,
    changePercent: change !== undefined && previousClose ? (change / previousClose) * 100 : undefined,
    snapshotTime: latest.snapshotTime.toISOString()
  };
}

export async function getLatestOptionChainSnapshot(underlyingSymbol = "NIFTY", requestedExpiry?: string, client: DbClient = prisma): Promise<OptionChainSnapshot | null> {
  const expiryId = requestedExpiry ? await resolveExpiryId(underlyingSymbol, requestedExpiry, client) : await resolveNearestExpiryId(underlyingSymbol, client);
  if (requestedExpiry && !expiryId) {
    return null;
  }

  const latest = await client.optionChainSnapshot.findFirst({
    where: {
      underlyingSymbol,
      ...(expiryId ? { expiryId } : {})
    },
    orderBy: { snapshotTime: "desc" },
    include: {
      expiry: true,
      ticks: {
        orderBy: [{ strikePrice: "asc" }, { optionType: "asc" }]
      }
    }
  });

  if (!latest) {
    return null;
  }

  const tradingDate = latest.tradingDate.toISOString().slice(0, 10);
  const latestExpiryLabel = latest.expiry.expiryLabel;

  // These three each cost one or two DB round trips and none of them depend
  // on each other's output - only on `latest`, which is already in hand. Run
  // them concurrently instead of one after another. This mattered most on
  // an expiry SWITCH specifically: getCachedLatestSnapshotOrDemo's cache key
  // is `underlying:expiry`, so picking a new expiry is guaranteed to miss
  // cache and pay for all three lookups fresh, on the connection's full
  // round-trip latency - three sequential ~20-40ms round trips reads as a
  // noticeable stall, even though every query here already hits its
  // intended index (confirmed via EXPLAIN, see resolveExpiryId above).
  const [lotSize, lastPriceReferences, sessionOpenReferences] = await Promise.all([
    getLotSizeForExpiry(latest.underlyingSymbol, latestExpiryLabel, client),
    getLastPriceReferenceMap(latest.ticks, latest.underlyingSymbol, latest.expiryId, latestExpiryLabel, latest.tradingDate, latest.snapshotTime, client),
    getSessionOpenReferenceMap(latest.ticks, latest.underlyingSymbol, latest.expiryId, latest.tradingDate, latest.snapshotTime, client)
  ]);
  const ticks = latest.ticks.map((tick): OptionContractTick => {
    const lastPrice = toNumber(tick.lastPrice);
    const previousLastPrice = lastPriceReferences.get(tickReferenceKey(tick));
    const lastPriceChange = lastPrice !== undefined && previousLastPrice !== undefined ? lastPrice - previousLastPrice : undefined;
    const openInterest = toNumber(tick.openInterest);
    const sessionOpen = sessionOpenReferences.get(tickReferenceKey(tick));
    const sessionOiChange = openInterest !== undefined && sessionOpen?.openInterest !== undefined ? openInterest - sessionOpen.openInterest : undefined;
    const sessionPriceChange = lastPrice !== undefined && sessionOpen?.lastPrice !== undefined ? lastPrice - sessionOpen.lastPrice : undefined;

    return {
      tradingDate,
      tickTime: tick.tickTime.toISOString(),
      underlyingSymbol: tick.underlyingSymbol,
      expiry: latestExpiryLabel,
      optionType: tick.optionType,
      strikePrice: tick.strikePrice.toNumber(),
      securityId: tick.securityId ?? undefined,
      lotSize,
      lastPrice,
      lastPriceChange,
      lastPriceChangePercent: lastPriceChange !== undefined && previousLastPrice ? (lastPriceChange / previousLastPrice) * 100 : undefined,
      bidPrice: toNumber(tick.bidPrice),
      askPrice: toNumber(tick.askPrice),
      volume: toNumber(tick.volume),
      openInterest,
      changeInOpenInterest: toNumber(tick.changeInOpenInterest),
      sessionOiChange,
      sessionPriceChangePercent: sessionPriceChange !== undefined && sessionOpen?.lastPrice ? (sessionPriceChange / sessionOpen.lastPrice) * 100 : undefined,
      impliedVolatility: toNumber(tick.impliedVolatility),
      delta: toNumber(tick.deltaValue),
      gamma: toNumber(tick.gammaValue),
      theta: toNumber(tick.thetaValue),
      vega: toNumber(tick.vegaValue)
    };
  });

  return {
    tradingDate,
    snapshotTime: latest.snapshotTime.toISOString(),
    underlyingSymbol: latest.underlyingSymbol,
    expiry: latestExpiryLabel,
    spotPrice: latest.spotPrice.toNumber(),
    atmStrike: latest.atmStrike.toNumber(),
    ticks
  };
}

/**
 * Distinct trading days that have at least one stored snapshot for the
 * given underlying/expiry - backs the Replay Lab's day picker so it can
 * show a calendar where only days with real data are selectable, the same
 * way the expiry picker only allows dates with stored expiries.
 */
export async function listReplayTradingDates(underlyingSymbol = "NIFTY", requestedExpiry?: string, client: DbClient = prisma): Promise<string[]> {
  const expiryId = requestedExpiry ? await resolveExpiryId(underlyingSymbol, requestedExpiry, client) : undefined;
  if (requestedExpiry && !expiryId) {
    return [];
  }

  const rows = await client.optionChainSnapshot.findMany({
    where: {
      underlyingSymbol,
      ...(expiryId ? { expiryId } : {})
    },
    distinct: ["tradingDate"],
    select: { tradingDate: true },
    orderBy: { tradingDate: "asc" }
  });

  return rows.map((row) => row.tradingDate.toISOString().slice(0, 10));
}

export async function listReplaySnapshots(underlyingSymbol = "NIFTY", requestedExpiry?: string, tradingDate?: string, client: DbClient = prisma) {
  const expiryId = requestedExpiry ? await resolveExpiryId(underlyingSymbol, requestedExpiry, client) : undefined;
  if (requestedExpiry && !expiryId) {
    return [];
  }

  const snapshots = await client.optionChainSnapshot.findMany({
    where: {
      underlyingSymbol,
      ...(expiryId ? { expiryId } : {}),
      ...(tradingDate ? { tradingDate: dateOnly(tradingDate) } : {})
    },
    orderBy: { snapshotTime: "desc" },
    // Safety cap: a single trading day tops out around ~750 snapshots at
    // the current ~30s capture cadence, so this only ever kicks in if a
    // caller omits tradingDate and the expiry has many days of history.
    take: 2000,
    include: {
      expiry: true
    }
  });

  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    tradingDate: snapshot.tradingDate.toISOString().slice(0, 10),
    snapshotTime: snapshot.snapshotTime.toISOString(),
    underlyingSymbol: snapshot.underlyingSymbol,
    expiry: snapshot.expiry.expiryLabel,
    spotPrice: snapshot.spotPrice.toNumber(),
    atmStrike: snapshot.atmStrike.toNumber()
  }));
}

// Feeds the Strike Matrix monthly horizon's IV Rank gate - deliberately
// tracks the underlying's ATM CALL implied volatility day-over-day
// (packages/analytics/src/strike-matrix.ts#evaluateMonthlyRiskRule), not
// tied to one specific expiry, since IV Rank is conventionally a read on
// the underlying's volatility regime and a monthly contract itself only
// lives ~30 days - there's no sensible "same expiry N days ago" for a
// 20+ day lookback. CALL-only because PE-side impliedVolatility is
// currently unreliable in production (reads 0 on live ticks where the CE
// leg at the same strike/instant has a real value - a separate,
// unrelated data-pipeline bug).
/**
 * ATM call IV, one value per trading day, oldest first - the series behind
 * the Option Chain tab's IV percentile.
 *
 * A single groupwise-max join rather than a query per trading day. The two
 * previous shapes were both wrong in their own way, and both were measured
 * against production on 2026-08-05:
 *
 *   - A per-day findFirst that `include`d every CE tick pulled ~200 rows per
 *     day to read one of them, and blew a 2 minute timeout outright.
 *   - Replacing that with 25 concurrent findFirst calls asked for 2.5x the
 *     mariadb driver's default pool of 10, so this one function starved every
 *     other query in the process: four unrelated endpoints all completed
 *     within 40ms of each other at ~10.31s, which is the 10s pool-acquire
 *     timeout plus their own work. Chunking those calls fixed the starvation
 *     but left 27 round trips costing 2373ms on a cold cache.
 *
 * One query returns exactly the rows wanted - one per trading day - and
 * measured 71ms cold / 43ms warm on the same data, a 12x improvement, while
 * holding a single connection. The indexes it needs already exist:
 * OptionChainSnapshot(underlyingSymbol, snapshotTime) for the grouping and
 * OptionContractTick(snapshotId) for the join.
 *
 * Zero IVs are dropped here rather than passed on. Dhan sends a literal 0
 * for a missing value (see the feed notes in CLAUDE.md), and the previous
 * code let them through by accident - its `if (iv)` guard tested a
 * Prisma.Decimal *object*, and Decimal(0) is truthy. Callers already filter
 * `> 0`, so the visible output is unchanged either way.
 */
export async function getAtmCallIvHistory(underlyingSymbol: string, days: number, client: DbClient = prisma): Promise<number[]> {
  const safeDays = Math.max(1, Math.floor(days));
  const rows = await client.$queryRaw<Array<{ iv: unknown }>>`
    SELECT t.impliedVolatility AS iv
    FROM (
      SELECT tradingDate, MAX(snapshotTime) AS mx
      FROM OptionChainSnapshot
      WHERE underlyingSymbol = ${underlyingSymbol}
      GROUP BY tradingDate
      ORDER BY tradingDate DESC
      LIMIT ${safeDays}
    ) d
    JOIN OptionChainSnapshot s
      ON s.underlyingSymbol = ${underlyingSymbol}
     AND s.tradingDate = d.tradingDate
     AND s.snapshotTime = d.mx
    JOIN OptionContractTick t
      ON t.snapshotId = s.id
     AND t.optionType = 'CE'
     AND t.strikePrice = s.atmStrike
    ORDER BY s.tradingDate ASC
  `;

  const history: number[] = [];
  for (const row of rows) {
    const iv = Number(row.iv);
    if (Number.isFinite(iv) && iv > 0) {
      history.push(iv);
    }
  }
  return history;
}

export async function listPcrTrend(underlyingSymbol = "NIFTY", requestedExpiry?: string, limit = 60, client: DbClient = prisma) {
  const rows = await client.pressureScore.findMany({
    where: {
      underlyingSymbol,
      pcr: {
        not: null
      },
      ...(requestedExpiry ? { expiryLabel: requestedExpiry } : {})
    },
    orderBy: { scoreTime: "desc" },
    take: Math.max(1, Math.min(300, limit)),
    select: {
      scoreTime: true,
      pcr: true,
      bullishPressure: true,
      bearishPressure: true,
      maxPain: true
    }
  });

  return rows.reverse().map((row) => ({
    scoreTime: row.scoreTime.toISOString(),
    pcr: row.pcr?.toNumber() ?? 0,
    bullishPressure: row.bullishPressure,
    bearishPressure: row.bearishPressure,
    maxPain: row.maxPain?.toNumber()
  }));
}

// Safety cap, not a target - callers size their own `limit` from the actual
// lookback window they need (see ELLIOTT_WAVE_LOOKBACK_MS in
// apps/api/src/server.ts), so this only kicks in if one asks for something
// pathological. Raised from 3,000 -> 600,000 alongside that fix: a 3,000-row
// ceiling was silently clipping every horizon to under a day of history
// regardless of what it asked for (confirmed live: intraday/weekly/monthly
// all returned the identical ~22-hour window against real NIFTY data on
// 2026-08-05), and 600,000 comfortably covers even the monthly horizon's
// 180-day window at a continuous 30s cadence (518,400 rows) with margin -
// real row counts will be far below this until SPOT_PRICE_RETENTION_DAYS
// (below) has actually had 180 days to accumulate.
const MAX_SPOT_PRICE_HISTORY_ROWS = 600_000;

/**
 * Spot-price time series for the Elliott Wave engine's ZigZag pivot
 * detector (see @option-decode/analytics#calculateElliottWave). Deliberately
 * reuses OptionChainSnapshot.spotPrice - already captured on every ~30s
 * worker cycle via saveOptionChainSnapshot - rather than introducing a
 * dedicated candle/OHLC ingestion pipeline. The existing
 * [underlyingSymbol, snapshotTime] index serves this query directly. Not
 * expiry-scoped: spot price is a property of the underlying, not a specific
 * contract, so a single continuous series is correct even as the app rolls
 * from one expiry to the next.
 */
export async function getSpotPriceHistory(underlyingSymbol: string, sinceMs: number, limit = 1000, client: DbClient = prisma): Promise<SpotPricePoint[]> {
  const rows = await client.optionChainSnapshot.findMany({
    where: {
      underlyingSymbol,
      snapshotTime: { gte: new Date(sinceMs) }
    },
    distinct: ["snapshotTime"],
    orderBy: { snapshotTime: "desc" },
    take: Math.max(1, Math.min(MAX_SPOT_PRICE_HISTORY_ROWS, limit)),
    select: {
      snapshotTime: true,
      spotPrice: true
    }
  });

  return rows
    .reverse()
    .map((row) => ({
      time: row.snapshotTime.toISOString(),
      price: row.spotPrice.toNumber()
    }));
}

/**
 * Recent (spotPrice + bullish/bearish pressure + PCR) samples for a
 * trailing time window, used to compute the "market pulse" rate-of-change
 * indicator. Pulls from PressureScore (already persisted by the worker on
 * every capture) joined to its snapshot's spotPrice, so no new capture job
 * or table is needed - this is purely a read over history that already
 * exists. Filtered by actual elapsed time (sinceMs), not a row count,
 * since capture isn't on a perfectly even cadence and a count-based
 * window would silently cover a different amount of real time whenever
 * there's a gap.
 *
 * `untilMs` is optional and defaults to no upper bound (i.e. "now" for the
 * live dashboard, since there's no future data to accidentally include).
 * Replay passes it explicitly so a historical snapshot's pulse is anchored
 * at that snapshot's own time instead of pulling in every reading between
 * then and the actual present.
 */
export async function listRecentPressureHistory(underlyingSymbol = "NIFTY", requestedExpiry: string | undefined, sinceMs: number, untilMs?: number, client: DbClient = prisma): Promise<MarketPulsePoint[]> {
  const rows = await client.pressureScore.findMany({
    where: {
      underlyingSymbol,
      scoreTime: { gte: new Date(sinceMs), ...(untilMs !== undefined ? { lte: new Date(untilMs) } : {}) },
      ...(requestedExpiry ? { expiryLabel: requestedExpiry } : {})
    },
    orderBy: { scoreTime: "asc" },
    select: {
      scoreTime: true,
      bullishPressure: true,
      bearishPressure: true,
      pcr: true,
      snapshot: {
        select: { spotPrice: true }
      }
    }
  });

  return rows.map((row) => ({
    scoreTime: row.scoreTime.toISOString(),
    spotPrice: row.snapshot.spotPrice.toNumber(),
    bullishPressure: row.bullishPressure,
    bearishPressure: row.bearishPressure,
    pcr: toNumber(row.pcr)
  }));
}

export async function getOptionChainSnapshotById(snapshotId: string, client: DbClient = prisma): Promise<OptionChainSnapshot | null> {
  const snapshot = await client.optionChainSnapshot.findUnique({
    where: { id: snapshotId },
    include: {
      expiry: true,
      ticks: {
        orderBy: [{ strikePrice: "asc" }, { optionType: "asc" }]
      }
    }
  });

  if (!snapshot) {
    return null;
  }

  const tradingDate = snapshot.tradingDate.toISOString().slice(0, 10);
  const expiryLabel = snapshot.expiry.expiryLabel;
  const lotSize = await getLotSizeForExpiry(snapshot.underlyingSymbol, expiryLabel, client);
  const lastPriceReferences = await getLastPriceReferenceMap(
    snapshot.ticks,
    snapshot.underlyingSymbol,
    snapshot.expiryId,
    expiryLabel,
    snapshot.tradingDate,
    snapshot.snapshotTime,
    client
  );
  const sessionOpenReferences = await getSessionOpenReferenceMap(snapshot.ticks, snapshot.underlyingSymbol, snapshot.expiryId, snapshot.tradingDate, snapshot.snapshotTime, client);
  const ticks = snapshot.ticks.map((tick): OptionContractTick => {
    const lastPrice = toNumber(tick.lastPrice);
    const previousLastPrice = lastPriceReferences.get(tickReferenceKey(tick));
    const lastPriceChange = lastPrice !== undefined && previousLastPrice !== undefined ? lastPrice - previousLastPrice : undefined;
    const openInterest = toNumber(tick.openInterest);
    const sessionOpen = sessionOpenReferences.get(tickReferenceKey(tick));
    const sessionOiChange = openInterest !== undefined && sessionOpen?.openInterest !== undefined ? openInterest - sessionOpen.openInterest : undefined;
    const sessionPriceChange = lastPrice !== undefined && sessionOpen?.lastPrice !== undefined ? lastPrice - sessionOpen.lastPrice : undefined;

    return {
      tradingDate,
      tickTime: tick.tickTime.toISOString(),
      underlyingSymbol: tick.underlyingSymbol,
      expiry: expiryLabel,
      optionType: tick.optionType,
      strikePrice: tick.strikePrice.toNumber(),
      securityId: tick.securityId ?? undefined,
      lotSize,
      lastPrice,
      lastPriceChange,
      lastPriceChangePercent: lastPriceChange !== undefined && previousLastPrice ? (lastPriceChange / previousLastPrice) * 100 : undefined,
      bidPrice: toNumber(tick.bidPrice),
      askPrice: toNumber(tick.askPrice),
      volume: toNumber(tick.volume),
      openInterest,
      changeInOpenInterest: toNumber(tick.changeInOpenInterest),
      sessionOiChange,
      sessionPriceChangePercent: sessionPriceChange !== undefined && sessionOpen?.lastPrice ? (sessionPriceChange / sessionOpen.lastPrice) * 100 : undefined,
      impliedVolatility: toNumber(tick.impliedVolatility),
      delta: toNumber(tick.deltaValue),
      gamma: toNumber(tick.gammaValue),
      theta: toNumber(tick.thetaValue),
      vega: toNumber(tick.vegaValue)
    };
  });

  return {
    tradingDate,
    snapshotTime: snapshot.snapshotTime.toISOString(),
    underlyingSymbol: snapshot.underlyingSymbol,
    expiry: expiryLabel,
    spotPrice: snapshot.spotPrice.toNumber(),
    atmStrike: snapshot.atmStrike.toNumber(),
    ticks
  };
}

export interface OiWeightedPriceResult {
  avgSellPrice: number;
  totalOi: number;
  sampleCount: number;
}

// Real-data version of the "average sell price" concept (as opposed to a
// single point-in-time LTP): walks a strike's recent tick history and, for
// every tick where open interest increased, treats that as "this much OI
// got written at this price." The result is Σ(price × ΔOI) ÷ ΣΔOI across
// every such buildup event - an approximation of what the currently-open
// interest actually got sold for, on average, rather than what it would
// cost to write right now. Does not adjust for OI unwinds (see
// PressureZone.avgSellPrice's doc comment in @option-decode/types) since
// exchanges don't publish which price-level lots close when OI drops -
// this is the same simplifying assumption virtually every tool doing this
// kind of calculation makes. Returns one result per "optionType:strike"
// key, omitting any strike with no OI-buildup history to derive it from.
//
// Bounded to the most recent MAX_TICK_SAMPLE ticks per strike, not the
// contract's entire lifetime. Confirmed in production: OptionContractTick
// has grown to 34M+ rows, and an unbounded per-strike scan (this function
// is called once per support/resistance zone, in parallel, on every
// dashboard poll) was taking 15-16 seconds per /api/market/overview call.
// The weighted sum is order-independent, so capping to the most recent
// window is both a real perf fix and a reasonable product tradeoff -
// "recent buildup" is arguably more actionable than the strike's full
// multi-week history anyway.
const MAX_TICK_SAMPLE = 3_000;

export async function calculateOiWeightedAverageSellPrices(underlyingSymbol: string, expiryLabel: string, strikes: Array<{ optionType: OptionType; strikePrice: number }>, client: DbClient = prisma): Promise<Map<string, OiWeightedPriceResult>> {
  const results = new Map<string, OiWeightedPriceResult>();
  if (!strikes.length) {
    return results;
  }

  await Promise.all(
    strikes.map(async ({ optionType, strikePrice }) => {
      const ticks = await client.optionContractTick.findMany({
        where: {
          underlyingSymbol,
          expiryLabel,
          optionType,
          strikePrice
        },
        orderBy: { tickTime: "desc" },
        take: MAX_TICK_SAMPLE,
        select: {
          lastPrice: true,
          changeInOpenInterest: true
        }
      });

      let weightedSum = 0;
      let totalOi = 0;
      let sampleCount = 0;

      for (const tick of ticks) {
        const price = toNumber(tick.lastPrice);
        const oiDelta = toNumber(tick.changeInOpenInterest);
        if (price === undefined || price <= 0 || oiDelta === undefined || oiDelta <= 0) {
          continue;
        }
        weightedSum += price * oiDelta;
        totalOi += oiDelta;
        sampleCount += 1;
      }

      if (totalOi > 0) {
        results.set(`${optionType}:${strikePrice}`, {
          avgSellPrice: Number((weightedSum / totalOi).toFixed(2)),
          totalOi,
          sampleCount
        });
      }
    })
  );

  return results;
}

// Two independent cutoffs rather than one: `detailCutoff` strips a
// snapshot's ticks/pressureScore (the ~450-row, storage-heavy part) but
// leaves the bare OptionChainSnapshot row - snapshotTime + spotPrice -
// alone. `snapshotCutoff` (expected to be the same age or older) is what
// finally deletes that bare row. This is what makes SPOT_PRICE_RETENTION_DAYS
// cheap: a snapshot's full tick set (~450 rows) is gone at 30 days as
// before, but its two-column spot-price record survives until 180 days,
// which is what getSpotPriceHistory (Elliott Wave's weekly/monthly
// horizons) actually reads. Caller (apps/worker/src/worker.ts) is
// responsible for keeping snapshotCutoff <= detailCutoff in time (i.e.
// SPOT_PRICE_RETENTION_DAYS >= SNAPSHOT_RETENTION_DAYS) - passing them
// reversed would try to delete a snapshot row while its ticks still
// reference it, which the FK constraint would reject.
export async function pruneMarketDataBefore(detailCutoff: Date, snapshotCutoff: Date, batchSize = 500, client: PrismaClient = prisma) {
  const totals = { snapshots: 0, ticks: 0, pressureScores: 0 };

  for (let batch = 0; batch < 50; batch += 1) {
    const targets = await client.optionChainSnapshot.findMany({
      where: { snapshotTime: { lt: detailCutoff }, ticks: { some: {} } },
      orderBy: { snapshotTime: "asc" },
      select: { id: true },
      take: batchSize
    });
    if (!targets.length) {
      break;
    }
    const ids = targets.map((snapshot) => snapshot.id);
    const [pressureScores, ticks] = await client.$transaction([
      client.pressureScore.deleteMany({ where: { snapshotId: { in: ids } } }),
      client.optionContractTick.deleteMany({ where: { snapshotId: { in: ids } } })
    ]);
    totals.ticks += ticks.count;
    totals.pressureScores += pressureScores.count;
    if (targets.length < batchSize) {
      break;
    }
  }

  for (let batch = 0; batch < 50; batch += 1) {
    const targets = await client.optionChainSnapshot.findMany({
      where: { snapshotTime: { lt: snapshotCutoff } },
      orderBy: { snapshotTime: "asc" },
      select: { id: true },
      take: batchSize
    });
    if (!targets.length) {
      break;
    }
    const ids = targets.map((snapshot) => snapshot.id);
    const deleted = await client.optionChainSnapshot.deleteMany({ where: { id: { in: ids } } });
    totals.snapshots += deleted.count;
    if (targets.length < batchSize) {
      break;
    }
  }

  return totals;
}

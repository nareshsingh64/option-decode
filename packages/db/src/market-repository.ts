import { calculatePressureScore } from "@option-decode/analytics";
import type { MarketPulsePoint, OptionChainSnapshot, OptionContractTick } from "@option-decode/types";
import type { OptionType, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "./index.js";
import { getStoredFnoLotSize } from "./lot-size-repository.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

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

function toNumber(value: Prisma.Decimal | number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? value : value.toNumber();
}

async function getLotSizeForExpiry(underlyingSymbol: string, expiryLabel: string, client: DbClient): Promise<number> {
  return (await getStoredFnoLotSize(underlyingSymbol, expiryLabel, client)) ?? getFallbackLotSizeForUnderlying(underlyingSymbol);
}

function getFallbackLotSizeForUnderlying(underlyingSymbol: string): number {
  const lotSizes: Record<string, number> = {
    NIFTY: 65,
    BANKNIFTY: 30,
    FINNIFTY: 60,
    MIDCPNIFTY: 120,
    NIFTYNXT50: 25,
    SENSEX: 20,
    BANKEX: 30,
    CRUDEOIL: 100,
    NATURALGAS: 1250,
    COPPER: 2500,
    SILVER: 30
  };
  return lotSizes[underlyingSymbol.toUpperCase()] ?? 1;
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

    await tx.optionContractTick.createMany({
      data: snapshot.ticks.map((tick) => ({
        snapshotId: createdSnapshot.id,
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
        impliedVolatility: tick.impliedVolatility,
        deltaValue: tick.delta,
        gammaValue: tick.gamma,
        thetaValue: tick.theta,
        vegaValue: tick.vega
      }))
    });

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
  const expiryId = requestedExpiry ? await resolveExpiryId(underlyingSymbol, requestedExpiry, client) : undefined;
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
  const lotSize = await getLotSizeForExpiry(latest.underlyingSymbol, latestExpiryLabel, client);
  const lastPriceReferences = await getLastPriceReferenceMap(
    latest.ticks,
    latest.underlyingSymbol,
    latest.expiryId,
    latestExpiryLabel,
    latest.tradingDate,
    latest.snapshotTime,
    client
  );
  const sessionOpenReferences = await getSessionOpenReferenceMap(latest.ticks, latest.underlyingSymbol, latest.expiryId, latest.tradingDate, latest.snapshotTime, client);
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

export async function pruneMarketDataBefore(cutoff: Date, batchSize = 500, client: PrismaClient = prisma) {
  const snapshots = await client.optionChainSnapshot.findMany({
    where: {
      snapshotTime: {
        lt: cutoff
      }
    },
    orderBy: {
      snapshotTime: "asc"
    },
    select: {
      id: true
    },
    take: batchSize
  });
  const snapshotIds = snapshots.map((snapshot) => snapshot.id);

  if (!snapshotIds.length) {
    return {
      snapshots: 0,
      ticks: 0,
      pressureScores: 0
    };
  }

  const [pressureScores, ticks, deletedSnapshots] = await client.$transaction([
    client.pressureScore.deleteMany({
      where: {
        snapshotId: {
          in: snapshotIds
        }
      }
    }),
    client.optionContractTick.deleteMany({
      where: {
        snapshotId: {
          in: snapshotIds
        }
      }
    }),
    client.optionChainSnapshot.deleteMany({
      where: {
        id: {
          in: snapshotIds
        }
      }
    })
  ]);

  return {
    snapshots: deletedSnapshots.count,
    ticks: ticks.count,
    pressureScores: pressureScores.count
  };
}

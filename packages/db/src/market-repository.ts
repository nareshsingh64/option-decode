import { calculatePressureScore } from "@option-decode/analytics";
import type { OptionChainSnapshot, OptionContractTick } from "@option-decode/types";
import type { OptionType, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "./index.js";
import { getStoredFnoLotSize } from "./lot-size-repository.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
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

function labelToDate(label: string): Date {
  return dateOnly(label);
}

export async function saveOptionChainSnapshot(snapshot: OptionChainSnapshot, client: PrismaClient = prisma): Promise<string> {
  const pressure = calculatePressureScore(snapshot);
  const expiryDate = labelToDate(snapshot.expiry);
  const tradingDate = dateOnly(snapshot.tradingDate);
  const snapshotTime = new Date(snapshot.snapshotTime);

  const saved = await client.$transaction(async (tx: Prisma.TransactionClient) => {
    const underlying = await tx.underlying.upsert({
      where: { symbol: snapshot.underlyingSymbol },
      update: { active: true },
      create: {
        symbol: snapshot.underlyingSymbol,
        displayName: snapshot.underlyingSymbol,
        exchange: "NSE"
      }
    });

    const expiry = await tx.expiry.upsert({
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

    const storedLotSize = await getLotSizeForExpiry(snapshot.underlyingSymbol, snapshot.expiry, tx);
    for (const tick of snapshot.ticks) {
      const lotSize = storedLotSize ?? tick.lotSize;
      await tx.optionContract.upsert({
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
    }

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
      active: true
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
  const latest = await client.optionChainSnapshot.findFirst({
    where: {
      underlyingSymbol,
      ...(requestedExpiry
        ? {
            expiry: {
              expiryLabel: requestedExpiry
            }
          }
        : {})
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
  const ticks = latest.ticks.map((tick): OptionContractTick => {
    const lastPrice = toNumber(tick.lastPrice);
    const previousLastPrice = lastPriceReferences.get(tickReferenceKey(tick));
    const lastPriceChange = lastPrice !== undefined && previousLastPrice !== undefined ? lastPrice - previousLastPrice : undefined;

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
      openInterest: toNumber(tick.openInterest),
      changeInOpenInterest: toNumber(tick.changeInOpenInterest),
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

export async function listReplaySnapshots(underlyingSymbol = "NIFTY", requestedExpiry?: string, client: DbClient = prisma) {
  const snapshots = await client.optionChainSnapshot.findMany({
    where: {
      underlyingSymbol,
      ...(requestedExpiry
        ? {
            expiry: {
              expiryLabel: requestedExpiry
            }
          }
        : {})
    },
    orderBy: { snapshotTime: "desc" },
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
  const ticks = snapshot.ticks.map((tick): OptionContractTick => {
    const lastPrice = toNumber(tick.lastPrice);
    const previousLastPrice = lastPriceReferences.get(tickReferenceKey(tick));
    const lastPriceChange = lastPrice !== undefined && previousLastPrice !== undefined ? lastPrice - previousLastPrice : undefined;

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
      openInterest: toNumber(tick.openInterest),
      changeInOpenInterest: toNumber(tick.changeInOpenInterest),
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

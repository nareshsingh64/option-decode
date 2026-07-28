// F&O stock universe for the Elliott Wave screener (Phase 2). Reuses the
// existing Dhan lot-size page scrape (lot-size-repository.ts) for the
// current symbol list, then resolves each symbol's NSE_EQ security id via
// the Dhan scrip master so the worker can pull LTP + volume for it (see
// @option-decode/dhan#getEquityQuotes). Deliberately does NOT add these
// stocks anywhere else in the app (Option Chain, Strike Matrix, Paper
// Trading) - those all require full option-chain data this sync doesn't
// fetch. See docs/DECODE OPTION & ELLIOTT WAVE KNOWLEDGE FILE.

import { resolveNseEquitySecurityIds } from "@option-decode/dhan";
import type { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "./index.js";
import { syncFnoLotSizesFromDhan } from "./lot-size-repository.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface FnoStockSummary {
  symbol: string;
  displayName: string;
  securityId?: number;
  lotSize?: number;
  active: boolean;
}

export interface FnoStockSyncResult {
  symbolsSeen: number;
  securityIdsResolved: number;
  unresolvedSymbols: string[];
}

/**
 * Refreshes the F&O lot-size table (source of truth for "which stocks are
 * currently F&O-eligible"), then resolves every symbol seen there to an
 * NSE_EQ security id and upserts FnoStock. A symbol that drops out of the
 * current F&O lot-size list is marked inactive rather than deleted, so
 * historical WaveScreenerAlert/WavePricePoint rows referencing it stay
 * intelligible.
 */
export async function syncFnoStockUniverse(client: PrismaClient = prisma): Promise<FnoStockSyncResult> {
  const lotSizeSync = await syncFnoLotSizesFromDhan(client);
  const currentSymbols = await client.fnoLotSize.findMany({
    distinct: ["symbol"],
    orderBy: { symbol: "asc" },
    select: { symbol: true }
  });
  const symbols = currentSymbols.map((row) => row.symbol);

  const securityIds = await resolveNseEquitySecurityIds(symbols);
  const now = new Date();

  await client.fnoStock.updateMany({
    where: { symbol: { notIn: symbols } },
    data: { active: false }
  });

  for (const symbol of symbols) {
    const securityId = securityIds.get(symbol);
    await client.fnoStock.upsert({
      where: { symbol },
      update: {
        active: true,
        lastSyncedAt: now,
        ...(securityId !== undefined ? { securityId } : {})
      },
      create: {
        symbol,
        displayName: symbol,
        securityId,
        active: true,
        lastSyncedAt: now
      }
    });
  }

  return {
    symbolsSeen: symbols.length,
    securityIdsResolved: securityIds.size,
    unresolvedSymbols: symbols.filter((symbol) => !securityIds.has(symbol))
  };
}

export async function listActiveFnoStocks(client: DbClient = prisma): Promise<FnoStockSummary[]> {
  const rows = await client.fnoStock.findMany({
    where: { active: true },
    orderBy: { symbol: "asc" }
  });

  return rows.map((row) => ({
    symbol: row.symbol,
    displayName: row.displayName,
    securityId: row.securityId ?? undefined,
    lotSize: row.lotSize ?? undefined,
    active: row.active
  }));
}

// Seeds/updates a stock's index weight - the only way indexWeightPercent
// ever gets populated, since Dhan has no API for official NSE index
// weights and NSE only rebalances semi-annually. Call this once per stock
// after each rebalance with the current published weight (e.g. from the
// NSE/index-provider factsheet) to keep getOptionChainTrackedStocks below
// accurate. Passing weightPercent: null clears a stock's weight, which
// removes it from the tracked list on the next capture cycle without
// needing a migration or code change.
export async function setFnoStockIndexWeight(symbol: string, weightPercent: number | null, client: DbClient = prisma): Promise<void> {
  await client.fnoStock.update({
    where: { symbol },
    data: { indexWeightPercent: weightPercent }
  });
}

export interface WeightedFnoStock {
  symbol: string;
  displayName: string;
  securityId: number;
  lotSize?: number;
  indexWeightPercent: number;
}

/**
 * Selects the smallest set of highest-weighted, currently-active F&O
 * stocks whose indexWeightPercent sums past `cumulativeWeightThresholdPercent`,
 * capped at `maxStockCount` regardless of how far that threshold reaches -
 * this is the actual selection logic behind "top N stocks that are >X% of
 * the index" requested for full option-chain capture. Stocks with no
 * securityId (never resolved by syncFnoStockUniverse) or no seeded weight
 * are excluded outright, since neither the Dhan option-chain call nor the
 * ranking can proceed without them - in particular, this means the result
 * is an empty array until setFnoStockIndexWeight has been called for at
 * least one stock, making the whole feature a no-op by default.
 */
export async function getOptionChainTrackedStocks(cumulativeWeightThresholdPercent: number, maxStockCount: number, client: DbClient = prisma): Promise<WeightedFnoStock[]> {
  const candidates = await client.fnoStock.findMany({
    where: {
      active: true,
      securityId: { not: null },
      indexWeightPercent: { not: null }
    },
    orderBy: { indexWeightPercent: "desc" },
    take: maxStockCount
  });

  const selected: WeightedFnoStock[] = [];
  let cumulativeWeight = 0;

  for (const stock of candidates) {
    if (cumulativeWeight >= cumulativeWeightThresholdPercent) {
      break;
    }
    if (stock.securityId === null || stock.indexWeightPercent === null) {
      continue;
    }

    selected.push({
      symbol: stock.symbol,
      displayName: stock.displayName,
      securityId: stock.securityId,
      lotSize: stock.lotSize ?? undefined,
      indexWeightPercent: stock.indexWeightPercent.toNumber()
    });
    cumulativeWeight += stock.indexWeightPercent.toNumber();
  }

  return selected;
}

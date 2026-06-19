import type { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "./index.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

const DHAN_FNO_LOT_SIZE_URL = "https://dhan.co/nse-fno-lot-size/";
const MONTH_INDEX: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11
};

export interface FnoLotSizeInput {
  symbol: string;
  monthLabel: string;
  contractMonth: Date;
  lotSize: number;
}

export async function syncFnoLotSizesFromDhan(client: PrismaClient = prisma) {
  const response = await fetch(DHAN_FNO_LOT_SIZE_URL);
  if (!response.ok) {
    throw new Error(`Dhan lot-size page failed with HTTP ${response.status}`);
  }

  const html = await response.text();
  const rows = parseDhanFnoLotSizePage(html);
  const fetchedAt = new Date();

  for (const row of rows) {
    await client.fnoLotSize.upsert({
      where: {
        symbol_contractMonth: {
          symbol: row.symbol,
          contractMonth: row.contractMonth
        }
      },
      update: {
        monthLabel: row.monthLabel,
        lotSize: row.lotSize,
        source: "DHAN",
        sourceUrl: DHAN_FNO_LOT_SIZE_URL,
        fetchedAt
      },
      create: {
        symbol: row.symbol,
        contractMonth: row.contractMonth,
        monthLabel: row.monthLabel,
        lotSize: row.lotSize,
        source: "DHAN",
        sourceUrl: DHAN_FNO_LOT_SIZE_URL,
        fetchedAt
      }
    });
  }

  return {
    sourceUrl: DHAN_FNO_LOT_SIZE_URL,
    fetchedAt: fetchedAt.toISOString(),
    rowsStored: rows.length,
    symbolsStored: new Set(rows.map((row) => row.symbol)).size
  };
}

export function parseDhanFnoLotSizePage(html: string): FnoLotSizeInput[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const monthLabels = [...text.matchAll(/Lot Size\s*\(\s*([A-Za-z]{3})\s+(\d{4})\s*\)/g)].map((match) => `${match[1]} ${match[2]}`).filter(Boolean).slice(0, 3);
  if (!monthLabels.length) {
    throw new Error("Unable to find Dhan lot-size month headers.");
  }

  const rows: FnoLotSizeInput[] = [];
  const rowPattern = /\b([A-Z][A-Z0-9&.-]{1,24})\s+B S\s+(\d+)\s+(\d+)\s+(\d+)/g;
  for (const match of text.matchAll(rowPattern)) {
    const symbol = match[1]?.toUpperCase();
    if (!symbol) {
      continue;
    }

    const lots = [match[2], match[3], match[4]].map((value) => Number(value));
    monthLabels.forEach((monthLabel, index) => {
      const lotSize = lots[index];
      if (Number.isFinite(lotSize) && lotSize > 0) {
        rows.push({
          symbol,
          monthLabel,
          contractMonth: monthLabelToDate(monthLabel),
          lotSize
        });
      }
    });
  }

  if (!rows.length) {
    throw new Error("Unable to parse any Dhan lot-size rows.");
  }
  return rows;
}

export async function getStoredFnoLotSize(symbol: string, expiryLabel: string, client: DbClient = prisma): Promise<number | undefined> {
  const contractMonth = expiryLabelToContractMonth(expiryLabel);
  if (!contractMonth) {
    return undefined;
  }

  const row = await client.fnoLotSize.findUnique({
    where: {
      symbol_contractMonth: {
        symbol: symbol.toUpperCase(),
        contractMonth
      }
    }
  });

  return row?.lotSize;
}

export function expiryLabelToContractMonth(expiryLabel: string): Date | undefined {
  const date = new Date(`${expiryLabel}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthLabelToDate(monthLabel: string) {
  const [monthName, yearText] = monthLabel.trim().split(/\s+/);
  const month = MONTH_INDEX[String(monthName ?? "").slice(0, 3).toUpperCase()];
  const year = Number(yearText);
  if (month === undefined || !Number.isFinite(year)) {
    throw new Error(`Invalid Dhan lot-size month label: ${monthLabel}`);
  }
  return new Date(Date.UTC(year, month, 1));
}

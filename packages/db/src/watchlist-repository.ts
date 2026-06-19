import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "./index.js";

const DEMO_USER_EMAIL = "paper.demo@optiondecode.local";
const DEFAULT_WATCHLIST_NAME = "Market Focus";
const DEFAULT_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX", "CRUDEOIL", "NATURALGAS", "COPPER", "SILVER"];

export interface WatchlistDto {
  id: string;
  name: string;
  symbols: string[];
  updatedAt: string;
}

export async function getDefaultWatchlist(client: PrismaClient = prisma): Promise<WatchlistDto> {
  const user = await getOrCreateDemoUser(client);
  const watchlist = await client.watchlist.findFirst({
    where: {
      userId: user.id,
      name: DEFAULT_WATCHLIST_NAME
    }
  });

  if (watchlist) {
    return mapWatchlist(watchlist);
  }

  const created = await client.watchlist.create({
    data: {
      userId: user.id,
      name: DEFAULT_WATCHLIST_NAME,
      symbols: DEFAULT_SYMBOLS
    }
  });

  return mapWatchlist(created);
}

export async function updateDefaultWatchlist(symbols: string[], client: PrismaClient = prisma): Promise<WatchlistDto> {
  const user = await getOrCreateDemoUser(client);
  const normalizedSymbols = normalizeSymbols(symbols);
  const existing = await client.watchlist.findFirst({
    where: {
      userId: user.id,
      name: DEFAULT_WATCHLIST_NAME
    }
  });

  const watchlist = existing
    ? await client.watchlist.update({
        where: { id: existing.id },
        data: { symbols: normalizedSymbols }
      })
    : await client.watchlist.create({
        data: {
          userId: user.id,
          name: DEFAULT_WATCHLIST_NAME,
          symbols: normalizedSymbols
        }
      });

  return mapWatchlist(watchlist);
}

async function getOrCreateDemoUser(client: PrismaClient) {
  return client.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: {
      email: DEMO_USER_EMAIL,
      passwordHash: "demo-paper-user",
      displayName: "Paper Demo",
      role: "TRIAL",
      emailVerified: true
    }
  });
}

function normalizeSymbols(symbols: string[]) {
  const normalized = symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  return [...new Set(normalized)].slice(0, 12);
}

function mapWatchlist(watchlist: { id: string; name: string; symbols: Prisma.JsonValue; updatedAt: Date }): WatchlistDto {
  const symbols = Array.isArray(watchlist.symbols) ? watchlist.symbols.filter((symbol): symbol is string => typeof symbol === "string") : [];

  return {
    id: watchlist.id,
    name: watchlist.name,
    symbols: normalizeSymbols(symbols),
    updatedAt: watchlist.updatedAt.toISOString()
  };
}

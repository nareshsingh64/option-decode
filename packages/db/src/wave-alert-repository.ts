// Persisted Wave 2 Reversal / Wave 3 Impulse screener alerts (see
// @option-decode/analytics#evaluateWaveScreener). Unlike the ephemeral,
// request-time MarketAlert (generateMarketAlerts), these are written once by
// the background screener job and read by any client later - the whole
// point of the "Automated Wave Screener" from the doc is that it keeps
// scanning the universe whether or not anyone is looking at a given symbol.

import type { PrismaClient, WaveAlertType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "./index.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface WaveAlertInput {
  underlyingSymbol: string;
  alertType: WaveAlertType;
  horizon: string;
  stage: string;
  direction: string;
  message: string;
  triggeredPrice: number;
  fibRetracementPercent?: number;
  rvol?: number;
  rsi?: number;
}

export interface WaveAlertRecord extends WaveAlertInput {
  id: string;
  createdAt: string;
  dismissed: boolean;
}

function toRecord(row: {
  id: string;
  underlyingSymbol: string;
  alertType: WaveAlertType;
  horizon: string;
  stage: string;
  direction: string;
  message: string;
  triggeredPrice: Prisma.Decimal;
  fibRetracementPercent: Prisma.Decimal | null;
  rvol: Prisma.Decimal | null;
  rsi: Prisma.Decimal | null;
  dismissed: boolean;
  createdAt: Date;
}): WaveAlertRecord {
  return {
    id: row.id,
    underlyingSymbol: row.underlyingSymbol,
    alertType: row.alertType,
    horizon: row.horizon,
    stage: row.stage,
    direction: row.direction,
    message: row.message,
    triggeredPrice: row.triggeredPrice.toNumber(),
    fibRetracementPercent: row.fibRetracementPercent?.toNumber(),
    rvol: row.rvol?.toNumber(),
    rsi: row.rsi?.toNumber(),
    dismissed: row.dismissed,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Creates a new alert unless one of the same type already fired for this
 * underlying+horizon within `cooldownMs` - without this, a condition that
 * stays true across several consecutive screener runs (e.g. Wave 2 sitting
 * in the Fibonacci zone for an hour) would otherwise re-alert every single
 * scan cycle. Returns the created record, or undefined when suppressed by
 * the cooldown.
 */
export async function recordWaveAlertIfNew(input: WaveAlertInput, cooldownMs: number, client: PrismaClient = prisma): Promise<WaveAlertRecord | undefined> {
  const recent = await client.waveScreenerAlert.findFirst({
    where: {
      underlyingSymbol: input.underlyingSymbol,
      alertType: input.alertType,
      horizon: input.horizon,
      createdAt: { gte: new Date(Date.now() - cooldownMs) }
    },
    orderBy: { createdAt: "desc" }
  });

  if (recent) {
    return undefined;
  }

  const created = await client.waveScreenerAlert.create({
    data: {
      underlyingSymbol: input.underlyingSymbol,
      alertType: input.alertType,
      horizon: input.horizon,
      stage: input.stage,
      direction: input.direction,
      message: input.message,
      triggeredPrice: input.triggeredPrice,
      fibRetracementPercent: input.fibRetracementPercent,
      rvol: input.rvol,
      rsi: input.rsi
    }
  });

  return toRecord(created);
}

export async function listRecentWaveAlerts(limit = 50, underlyingSymbol?: string, client: DbClient = prisma): Promise<WaveAlertRecord[]> {
  const rows = await client.waveScreenerAlert.findMany({
    where: {
      dismissed: false,
      ...(underlyingSymbol ? { underlyingSymbol } : {})
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(200, limit))
  });

  return rows.map(toRecord);
}

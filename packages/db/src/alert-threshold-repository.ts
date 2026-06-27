import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "./index.js";

export interface AlertThresholdDto {
  underlyingSymbol: string;
  proximityPoints: number;
  pcrUpper: number;
  pcrLower: number;
  pressureWarning: number;
  pressureCritical: number;
}

export interface AlertThresholdInput {
  underlyingSymbol: string;
  proximityPoints: number;
  pcrUpper: number;
  pcrLower: number;
  pressureWarning: number;
  pressureCritical: number;
}

function toNumber(value: Prisma.Decimal | number): number {
  return typeof value === "number" ? value : value.toNumber();
}

function toDto(row: {
  underlyingSymbol: string;
  proximityPoints: Prisma.Decimal;
  pcrUpper: Prisma.Decimal;
  pcrLower: Prisma.Decimal;
  pressureWarning: number;
  pressureCritical: number;
}): AlertThresholdDto {
  return {
    underlyingSymbol: row.underlyingSymbol,
    proximityPoints: toNumber(row.proximityPoints),
    pcrUpper: toNumber(row.pcrUpper),
    pcrLower: toNumber(row.pcrLower),
    pressureWarning: row.pressureWarning,
    pressureCritical: row.pressureCritical
  };
}

export async function listUserAlertThresholds(userId: string, client: PrismaClient = prisma): Promise<AlertThresholdDto[]> {
  const rows = await client.alertThreshold.findMany({
    where: { userId },
    orderBy: { underlyingSymbol: "asc" }
  });
  return rows.map(toDto);
}

export async function getUserAlertThreshold(userId: string, underlyingSymbol: string, client: PrismaClient = prisma): Promise<AlertThresholdDto | null> {
  const row = await client.alertThreshold.findUnique({
    where: {
      userId_underlyingSymbol: {
        userId,
        underlyingSymbol: underlyingSymbol.toUpperCase()
      }
    }
  });
  return row ? toDto(row) : null;
}

export async function upsertUserAlertThreshold(userId: string, input: AlertThresholdInput, client: PrismaClient = prisma): Promise<AlertThresholdDto> {
  const data = {
    proximityPoints: new Prisma.Decimal(input.proximityPoints),
    pcrUpper: new Prisma.Decimal(input.pcrUpper),
    pcrLower: new Prisma.Decimal(input.pcrLower),
    pressureWarning: input.pressureWarning,
    pressureCritical: input.pressureCritical
  };
  const row = await client.alertThreshold.upsert({
    where: {
      userId_underlyingSymbol: {
        userId,
        underlyingSymbol: input.underlyingSymbol.toUpperCase()
      }
    },
    create: {
      userId,
      underlyingSymbol: input.underlyingSymbol.toUpperCase(),
      ...data
    },
    update: data
  });
  return toDto(row);
}

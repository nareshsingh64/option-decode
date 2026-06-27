import type { PrismaClient } from "@prisma/client";
import { prisma } from "./index.js";

export interface PushSubscriptionDto {
  id: string;
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
}

export async function upsertPushSubscription(userId: string, input: PushSubscriptionInput, client: PrismaClient = prisma) {
  const row = await client.pushSubscription.upsert({
    where: {
      userId_endpoint: {
        userId,
        endpoint: input.endpoint
      }
    },
    create: {
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent?.slice(0, 255),
      disabled: false
    },
    update: {
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent?.slice(0, 255),
      disabled: false
    }
  });
  return toDto(row);
}

export async function listActivePushSubscriptions(client: PrismaClient = prisma): Promise<PushSubscriptionDto[]> {
  const rows = await client.pushSubscription.findMany({
    where: { disabled: false },
    select: {
      id: true,
      userId: true,
      endpoint: true,
      p256dh: true,
      auth: true
    }
  });
  return rows.map(toDto);
}

export async function disablePushSubscriptionByEndpoint(endpoint: string, client: PrismaClient = prisma) {
  await client.pushSubscription.updateMany({
    where: { endpoint },
    data: { disabled: true }
  });
}

function toDto(row: { id: string; userId: string; endpoint: string; p256dh: string; auth: string }): PushSubscriptionDto {
  return {
    id: row.id,
    userId: row.userId,
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth
    }
  };
}

import type { UserRole } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "./index.js";

export interface AuthUserDto {
  id: string;
  email: string;
  displayName?: string;
  role: UserRole;
  emailVerified: boolean;
  plan?: {
    code: string;
    name: string;
    status: string;
    realtime: boolean;
    premiumAlerts: boolean;
    replayLimit?: number;
  };
}

export interface RegisterUserInput {
  email: string;
  passwordHash: string;
  displayName?: string;
}

export async function createUser(input: RegisterUserInput, client: PrismaClient = prisma): Promise<AuthUserDto> {
  const user = await client.user.create({
    data: {
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      role: "TRIAL",
      emailVerified: false
    },
    include: activeSubscriptionInclude
  });

  await ensureTrialSubscription(user.id, client);
  return getAuthUserById(user.id, client) as Promise<AuthUserDto>;
}

export async function getUserCredentialsByEmail(email: string, client: PrismaClient = prisma) {
  return client.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      passwordHash: true
    }
  });
}

export async function getAuthUserById(userId: string, client: PrismaClient = prisma): Promise<AuthUserDto | null> {
  const user = await client.user.findUnique({
    where: { id: userId },
    include: activeSubscriptionInclude
  });

  return user ? mapAuthUser(user) : null;
}

export async function seedDefaultPlans(client: PrismaClient = prisma) {
  const plans = [
    {
      code: "STARTER",
      name: "Starter",
      description: "Basic analytics and daily snapshots",
      monthlyPrice: 0,
      replayLimit: 5,
      realtime: false,
      premiumAlerts: false
    },
    {
      code: "PRO",
      name: "Pro",
      description: "Real-time chain tracking, replay engine, and advanced analytics",
      monthlyPrice: 1499,
      replayLimit: 100,
      realtime: true,
      premiumAlerts: false
    },
    {
      code: "ELITE",
      name: "Elite",
      description: "Full research suite, unlimited replay access, and premium alerts",
      monthlyPrice: 2999,
      replayLimit: null,
      realtime: true,
      premiumAlerts: true
    }
  ];

  for (const plan of plans) {
    await client.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan
    });
  }

  return client.plan.findMany({ orderBy: { monthlyPrice: "asc" } });
}

async function ensureTrialSubscription(userId: string, client: PrismaClient) {
  const plans = await seedDefaultPlans(client);
  const starterPlan = plans.find((plan) => plan.code === "STARTER");
  if (!starterPlan) {
    return;
  }

  await client.subscription.create({
    data: {
      userId,
      planId: starterPlan.id,
      status: "TRIAL",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    }
  });
}

const activeSubscriptionInclude = {
  subscriptions: {
    where: {
      status: {
        in: ["ACTIVE", "TRIAL"]
      }
    },
    include: {
      plan: true
    },
    orderBy: {
      createdAt: "desc" as const
    },
    take: 1
  }
};

function mapAuthUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  emailVerified: boolean;
  subscriptions: Array<{
    status: string;
    plan: {
      code: string;
      name: string;
      realtime: boolean;
      premiumAlerts: boolean;
      replayLimit: number | null;
    };
  }>;
}): AuthUserDto {
  const subscription = user.subscriptions[0];
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? undefined,
    role: user.role,
    emailVerified: user.emailVerified,
    plan: subscription
      ? {
          code: subscription.plan.code,
          name: subscription.plan.name,
          status: subscription.status,
          realtime: subscription.plan.realtime,
          premiumAlerts: subscription.plan.premiumAlerts,
          replayLimit: subscription.plan.replayLimit ?? undefined
        }
      : undefined
  };
}

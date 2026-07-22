import type { UserRole } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./index.js";
import { ASSIGNABLE_TABS, DEFAULT_TABS, sanitizeTabs } from "./tab-access-repository.js";

export interface AuthUserDto {
  id: string;
  email: string;
  displayName?: string;
  role: UserRole;
  emailVerified: boolean;
  disabled: boolean;
  lastLoginAt?: string;
  // Role-based tab access: the dashboard views this user may open.
  // Admins always get the full set; other users get their assignment
  // (or the default set when no assignment exists).
  allowedViews: string[];
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

export async function markUserLogin(userId: string, client: PrismaClient = prisma) {
  await client.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() }
  });
}

export async function getUserCredentialsByEmail(email: string, client: PrismaClient = prisma) {
  return client.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      disabled: true,
      emailVerified: true
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

export async function createEmailVerificationToken(email: string, client: PrismaClient = prisma) {
  return createOneTimeToken("email", email, 24 * 60 * 60 * 1000, client);
}

export async function verifyEmailToken(token: string, client: PrismaClient = prisma) {
  const tokenHash = hashToken(token);
  const now = new Date();
  const storedToken = await client.emailVerificationToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: now
      }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!storedToken) {
    return null;
  }

  const user = await client.$transaction(async (tx) => {
    await tx.emailVerificationToken.update({
      where: { id: storedToken.id },
      data: { usedAt: now }
    });

    return tx.user.update({
      where: { email: storedToken.email.toLowerCase() },
      data: { emailVerified: true },
      include: activeSubscriptionInclude
    });
  });

  return mapAuthUser(user);
}

export async function createPasswordResetToken(email: string, client: PrismaClient = prisma) {
  const user = await client.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { email: true, disabled: true }
  });

  if (!user || user.disabled) {
    return null;
  }

  return createOneTimeToken("password", user.email, 60 * 60 * 1000, client);
}

export async function resetPasswordWithToken(token: string, passwordHash: string, client: PrismaClient = prisma) {
  const tokenHash = hashToken(token);
  const now = new Date();
  const storedToken = await client.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: now
      }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!storedToken) {
    return null;
  }

  const user = await client.$transaction(async (tx) => {
    await tx.passwordResetToken.update({
      where: { id: storedToken.id },
      data: { usedAt: now }
    });

    return tx.user.update({
      where: { email: storedToken.email.toLowerCase() },
      data: { passwordHash },
      include: activeSubscriptionInclude
    });
  });

  return mapAuthUser(user);
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
  },
  tabAccess: true
};

function mapAuthUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  emailVerified: boolean;
  disabled: boolean;
  lastLoginAt: Date | null;
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
  tabAccess?: { tabs: unknown } | null;
}): AuthUserDto {
  const subscription = user.subscriptions[0];
  const allowedViews = user.role === "ADMIN" ? [...ASSIGNABLE_TABS] : user.tabAccess ? sanitizeTabs(user.tabAccess.tabs) : [...DEFAULT_TABS];
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? undefined,
    role: user.role,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    lastLoginAt: user.lastLoginAt?.toISOString(),
    allowedViews,
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

async function createOneTimeToken(kind: "email" | "password", email: string, ttlMs: number, client: PrismaClient) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);
  const normalizedEmail = email.toLowerCase();

  if (kind === "email") {
    await client.emailVerificationToken.create({
      data: {
        email: normalizedEmail,
        tokenHash,
        expiresAt
      }
    });
  } else {
    await client.passwordResetToken.create({
      data: {
        email: normalizedEmail,
        tokenHash,
        expiresAt
      }
    });
  }

  return {
    email: normalizedEmail,
    token,
    expiresAt
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

import type { PrismaClient, UserRole } from "@prisma/client";
import { prisma } from "./index.js";
import { ASSIGNABLE_TABS, DEFAULT_TABS, sanitizeTabs } from "./tab-access-repository.js";

export interface AdminOverviewDto {
  users: Array<{
    id: string;
    email: string;
    displayName?: string;
    role: UserRole;
    emailVerified: boolean;
    disabled: boolean;
    lastLoginAt?: string;
    createdAt: string;
    // Role-based tab access: current effective tab set for this user.
    tabs: string[];
    plan?: {
      code: string;
      name: string;
      status: string;
    };
  }>;
  plans: Array<{
    id: string;
    code: string;
    name: string;
    monthlyPrice?: number;
    replayLimit?: number;
    realtime: boolean;
    premiumAlerts: boolean;
    subscriberCount: number;
  }>;
  metrics: {
    users: number;
    admins: number;
    activeSubscriptions: number;
    snapshotsToday: number;
    openPaperPositions: number;
  };
}

export async function getAdminOverview(client: PrismaClient = prisma): Promise<AdminOverviewDto> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [users, plans, userCount, adminCount, activeSubscriptions, snapshotsToday, openPaperPositions] = await Promise.all([
    client.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
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
            createdAt: "desc"
          },
          take: 1
        },
        tabAccess: true
      }
    }),
    client.plan.findMany({
      orderBy: { monthlyPrice: "asc" },
      include: {
        _count: {
          select: {
            subscriptions: true
          }
        }
      }
    }),
    client.user.count(),
    client.user.count({ where: { role: "ADMIN" } }),
    client.subscription.count({
      where: {
        status: {
          in: ["ACTIVE", "TRIAL"]
        }
      }
    }),
    client.optionChainSnapshot.count({
      where: {
        snapshotTime: {
          gte: today
        }
      }
    }),
    client.paperPosition.count({ where: { status: "OPEN" } })
  ]);

  return {
    users: users.map((user) => {
      const subscription = user.subscriptions[0];
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? undefined,
        role: user.role,
        emailVerified: user.emailVerified,
        disabled: user.disabled,
        lastLoginAt: user.lastLoginAt?.toISOString(),
        createdAt: user.createdAt.toISOString(),
        tabs: user.role === "ADMIN" ? [...ASSIGNABLE_TABS] : user.tabAccess ? sanitizeTabs(user.tabAccess.tabs) : [...DEFAULT_TABS],
        plan: subscription
          ? {
              code: subscription.plan.code,
              name: subscription.plan.name,
              status: subscription.status
            }
          : undefined
      };
    }),
    plans: plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      monthlyPrice: plan.monthlyPrice?.toNumber(),
      replayLimit: plan.replayLimit ?? undefined,
      realtime: plan.realtime,
      premiumAlerts: plan.premiumAlerts,
      subscriberCount: plan._count.subscriptions
    })),
    metrics: {
      users: userCount,
      admins: adminCount,
      activeSubscriptions,
      snapshotsToday,
      openPaperPositions
    }
  };
}

export async function updateAdminUserRole(userId: string, role: UserRole, client: PrismaClient = prisma) {
  const user = await client.user.update({
    where: { id: userId },
    data: { role },
    select: {
      id: true,
      email: true,
      role: true
    }
  });

  return user;
}

export async function updateAdminUserDisabled(userId: string, disabled: boolean, client: PrismaClient = prisma) {
  return client.user.update({
    where: { id: userId },
    data: { disabled },
    select: {
      id: true,
      email: true,
      disabled: true
    }
  });
}

// Role-based tab access.
//
// Admins assign which dashboard tabs each user can see. Users without an
// explicit assignment get DEFAULT_TABS. Admins implicitly see every tab
// (the assignment table is ignored for them). Account and Settings are
// always available and not part of the assignable set; the Admin tab is
// gated by role, not by this table.

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "./index.js";

export const ASSIGNABLE_TABS = ["dashboard", "new-dashboard", "option-chain", "pressure", "replay", "paper", "paper-pro", "alerts"] as const;

export type AssignableTab = (typeof ASSIGNABLE_TABS)[number];

export const DEFAULT_TABS: AssignableTab[] = ["dashboard", "new-dashboard", "option-chain", "paper"];

export const TAB_LABELS: Record<AssignableTab, string> = {
  dashboard: "Dashboard",
  "new-dashboard": "Strike Matrix",
  "option-chain": "Option Chain",
  pressure: "Pressure Engine",
  replay: "Replay Lab",
  paper: "Paper Trading",
  "paper-pro": "Paper Trading Pro",
  alerts: "Alerts"
};

export function sanitizeTabs(tabs: unknown): AssignableTab[] {
  if (!Array.isArray(tabs)) {
    return [...DEFAULT_TABS];
  }
  const valid = tabs.filter((tab): tab is AssignableTab => (ASSIGNABLE_TABS as readonly string[]).includes(tab as string));
  // An empty assignment would lock the user out of every view - fall back
  // to the default set rather than rendering a dead shell.
  return valid.length ? [...new Set(valid)] : [...DEFAULT_TABS];
}

export async function getUserTabs(userId: string, client: PrismaClient = prisma): Promise<AssignableTab[]> {
  const record = await client.userTabAccess.findUnique({ where: { userId } });
  return record ? sanitizeTabs(record.tabs) : [...DEFAULT_TABS];
}

export async function setUserTabs(userId: string, tabs: string[], client: PrismaClient = prisma): Promise<AssignableTab[]> {
  const sanitized = sanitizeTabs(tabs);
  await client.userTabAccess.upsert({
    where: { userId },
    create: { userId, tabs: sanitized as unknown as Prisma.InputJsonValue },
    update: { tabs: sanitized as unknown as Prisma.InputJsonValue }
  });
  return sanitized;
}

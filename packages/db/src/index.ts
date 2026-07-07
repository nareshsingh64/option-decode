import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient };
export { getAdminOverview, updateAdminUserDisabled, updateAdminUserRole } from "./admin-repository.js";
export type { AdminOverviewDto } from "./admin-repository.js";
export { getUserAlertThreshold, listUserAlertThresholds, upsertUserAlertThreshold } from "./alert-threshold-repository.js";
export type { AlertThresholdDto, AlertThresholdInput } from "./alert-threshold-repository.js";
export { createEmailVerificationToken, createPasswordResetToken, createUser, getAuthUserById, getUserCredentialsByEmail, markUserLogin, resetPasswordWithToken, seedDefaultPlans, verifyEmailToken } from "./auth-repository.js";
export type { AuthUserDto } from "./auth-repository.js";
export { buildDemoSnapshot } from "./demo-snapshot.js";
export { getStoredFnoLotSize, parseDhanFnoLotSizePage, syncFnoLotSizesFromDhan } from "./lot-size-repository.js";
export { getLatestOptionChainSnapshot, getLatestSpotChange, getOptionChainSnapshotById, listPcrTrend, listRecentPressureHistory, listReplaySnapshots, listReplayTradingDates, listStoredExpiries, pruneMarketDataBefore, saveOptionChainSnapshot } from "./market-repository.js";
export { cancelPendingPaperOrder, closePaperPosition, getPaperSummary, listExpiriesNeedingLiveData, monitorPaperTradingForSnapshot, placePaperOrder, updatePaperPositionRisk, updatePendingPaperOrder } from "./paper-repository.js";
export type { PaperOrderInput, PaperSummary, PendingPaperOrderUpdateInput } from "./paper-repository.js";
export { disablePushSubscriptionByEndpoint, disablePushSubscriptionsForUser, listActivePushSubscriptions, upsertPushSubscription } from "./push-repository.js";
export type { PushSubscriptionDto, PushSubscriptionInput } from "./push-repository.js";
export { getDefaultWatchlist, updateDefaultWatchlist } from "./watchlist-repository.js";
export type { WatchlistDto } from "./watchlist-repository.js";

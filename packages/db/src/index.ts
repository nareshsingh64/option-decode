import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

// Driver adapter (not Prisma's native/Rust query engine) - see the
// generator comment in prisma/schema.prisma for why. Confirmed in
// production (2026-08-01): worker RSS climbed from ~250MB to 5-6GB within
// 30-45 minutes while heapUsed/external/arrayBuffers all stayed flat at
// ~60MB/5MB/0.2MB - memory invisible to every Node-level memory API, only
// explicable by something native. The `mariadb` driver used here is pure
// JS; DATABASE_URL is parsed into discrete fields rather than passed as a
// connection string because the mariadb package only accepts its own
// mariadb:// URL scheme, not mysql://.
function toMariaDbPoolConfig(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "")
  };
}

const adapter = new PrismaMariaDb(toMariaDbPoolConfig(process.env.DATABASE_URL as string));

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

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

export { getDhanApiRequestHourlyCounts, getDhanApiRequestSummary, logDhanApiRequest } from "./dhan-audit-repository.js";
export type { DhanApiRequestLogEntry, DhanApiRequestSummaryRow } from "./dhan-audit-repository.js";

export { getOptionChainTrackedStocks, listActiveFnoStocks, setFnoStockIndexWeight, syncFnoStockUniverse } from "./fno-stock-repository.js";
export type { FnoStockSummary, FnoStockSyncResult, WeightedFnoStock } from "./fno-stock-repository.js";
export { calculateOiWeightedAverageSellPrices, getAtmCallIvHistory, getLatestOptionChainSnapshot, getLatestSpotChange, getOptionChainSnapshotById, getSpotPriceHistory, listPcrTrend, listRecentPressureHistory, listReplaySnapshots, listReplayTradingDates, listStoredExpiries, pruneMarketDataBefore, saveOptionChainSnapshot } from "./market-repository.js";

export { getWavePriceHistory, recordWavePricePoints } from "./wave-price-repository.js";
export type { WavePricePointInput } from "./wave-price-repository.js";

export { listRecentWaveAlerts, recordWaveAlertIfNew } from "./wave-alert-repository.js";
export type { WaveAlertInput, WaveAlertRecord } from "./wave-alert-repository.js";
export type { OiWeightedPriceResult } from "./market-repository.js";
export { cancelPendingPaperOrder, closePaperPosition, getOpenPositionsForMarginGroup, getPaperSummary, getPendingOrdersForMarginGroup, listExpiriesNeedingLiveData, monitorPaperTradingForSnapshot, placeMultiLegPaperOrder, placePaperOrder, recordOrderMargin, recordPositionMargin, updatePaperPositionRisk, updatePendingPaperOrder, validatePaperOrderCapacity } from "./paper-repository.js";
export type { FilledPaperLeg, MarginQuoteLeg, PaperOrderInput, PaperOrderLegInput, PaperSummary, PendingPaperOrderUpdateInput } from "./paper-repository.js";
export { SimOrderRejectedError, closeSimTrade, computeSimStress, getOrCreateSimAccount, getSimSummary, getSimSummaryForUserId, listSimAccountsForAdmin, placeSimTrade, quoteSimTrade, resetSimAccount, runSimEodMarkToMarket, runSimIntradayEngine } from "./sim-repository.js";
export type { SimAccountDto, SimAdminAccountRow, SimAnalyticsDto, SimEodResult, SimFillTranche, SimGreeksDto, SimHorizonName, SimIntradayResult, SimLegInput, SimQuote, SimQuotedLeg, SimSignalScorecardRow, SimStrategyTypeName, SimStressCell, SimStressResult, SimSummary, SimTradeDto, SimTradeInput, SimTradeLegDto } from "./sim-repository.js";
export { disablePushSubscriptionByEndpoint, disablePushSubscriptionsForUser, listActivePushSubscriptions, upsertPushSubscription } from "./push-repository.js";
export type { PushSubscriptionDto, PushSubscriptionInput } from "./push-repository.js";
export { ASSIGNABLE_TABS, DEFAULT_TABS, TAB_LABELS, getUserTabs, sanitizeTabs, setUserTabs } from "./tab-access-repository.js";
export type { AssignableTab } from "./tab-access-repository.js";
export {
  beginBrokerConsent,
  completeBrokerConsent,
  listLiveChainStrikes,
  partnerLoginAvailable,
  LiveCredentialError,
  LiveOrderRejectedError,
  LiveTradingDisabledError,
  cancelLiveOrder,
  computeLiveMarginView,
  getBrokerCredentialStatus,
  getLiveSummary,
  invalidateLiveClient,
  placeLiveOrder,
  previewLiveOrder,
  reconcileLiveAccount,
  revokeBrokerCredential,
  saveBrokerCredential
} from "./live-repository.js";
export type {
  BrokerConsentStart,
  BrokerCredentialStatus,
  LiveChainStrike,
  LiveLegInput,
  LiveMarginLegView,
  LiveMarginView,
  LivePlacementResult,
  LivePreview,
  LiveReconcileResult,
  LiveSummary,
  LiveTicketInput
} from "./live-repository.js";
export { getDefaultWatchlist, updateDefaultWatchlist } from "./watchlist-repository.js";
export type { WatchlistDto } from "./watchlist-repository.js";

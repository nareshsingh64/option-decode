"use client";

import { Clock3, Pause, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { MarketPulse, StrikeMovementRow } from "@option-decode/types";
import { AccountPanel } from "./account-panel";
import { AdminPanel } from "./admin-panel";
import { AlertCenter } from "./alert-center";
import {
  buildClientViewHref,
  buildMarketStreamUrl,
  cancelPendingPaperOrder,
  closePaperPosition,
  disableBrowserPush,
  fetchAdminOverview,
  fetchAlertThresholds,
  fetchAuthUser,
  fetchDefaultWatchlist,
  fetchMarketOverview,
  fetchMarketTicker,
  fetchPaperSummary,
  fetchReplaySnapshot,
  fetchReplayTimeline,
  fetchReplayTradingDates,
  logoutAuthUser,
  placeMultiLegPaperOrder,
  placePaperOrder,
  registerBrowserPush,
  resendVerificationEmail,
  submitAuth,
  updateAdminUserDisabled,
  updateAdminUserRole,
  updateAlertThreshold,
  updateDefaultWatchlist,
  updatePaperPositionRisk,
  updatePendingPaperOrder
} from "./dashboard-client";
import {
  formatCurrency,
  formatIstShortDateTime,
  formatIstTime,
  formatLarge,
  formatLotsAndQty,
  formatLtpChange,
  formatOptionalNumber,
  formatPrice,
  formatSignedLarge,
  formatStrike,
  formatTradablePrice,
  getDefaultTargetPrice,
  getDefaultTrailDistanceForEntry,
  getLotSizeForUnderlying,
  getTrailingStopLoss,
  mergeTickerItems,
  normalizeTradablePrice
} from "./dashboard-formatters";
import { DashboardMainPanel, useStrikeScoreTrends } from "./dashboard-main-panel";
import { MarketControls } from "./market-controls";
import { StrikeMatrixPanel } from "./strike-matrix-panel";
import {
  buildAtmStrikeRange,
  buildChainRows,
  buildChainStats,
  buildIvSkewRows,
  buildOiBuildupRows,
  buildTopStrikeRows,
  buildVixStrikeRange
} from "./option-chain-builders";
import { IvSkewChart, OiBuildupChart } from "./option-chain-charts";
import { OptionChainPanel } from "./option-chain-panel";
import { PaperTradingPanel } from "./paper-trading-panel";
import type { HedgeLegDraft } from "./paper-trading-panel";
import { PressureEngine } from "./pressure-engine";
import { ReplayLab } from "./replay-lab";
import { SettingsPanel } from "./settings-panel";
import {
  buildPressureSignals,
  buildPressureSummary,
  buildStrikeMovementRows,
  buildStrikeMovementSummary,
  buildTradeInterpretation,
  buildZoneRows,
  getActivityLabel,
  getActivityToneClass,
  scoreToPercent
} from "./strike-pressure-analytics";
import type { OptionActivityKind } from "./strike-pressure-analytics";

export interface OverviewTick {
  underlyingSymbol?: string;
  optionType: "CE" | "PE";
  strikePrice: number;
  lotSize?: number;
  lastPrice?: number;
  lastPriceChange?: number;
  lastPriceChangePercent?: number;
  volume?: number;
  openInterest?: number;
  changeInOpenInterest?: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

export interface MarketOverview {
  underlyings: string[];
  expiries: string[];
  // Every expiry the broker currently lists as tradable for this
  // underlying, regardless of whether any snapshot has ever been captured
  // for it - unlike `expiries` (which only lists expiries we already have
  // stored data for, since that list feeds Replay Lab/Market Controls).
  // This is what the Paper Order Ticket's expiry picker uses, since it's
  // choosing a forward-looking expiry to trade rather than one to review.
  tradableExpiries: string[];
  selectedUnderlying: string;
  selectedExpiry: string;
  indiaVix?: number;
  ticker?: MarketTickerItem[];
  snapshot: {
    snapshotTime: string;
    underlyingSymbol: string;
    expiry: string;
    spotPrice: number;
    atmStrike: number;
    ticks: OverviewTick[];
  };
  pressure: {
    bullishPressure: number;
    bearishPressure: number;
    pcr?: number;
    maxPain?: number;
    // premium/trueZone: the breakeven-cushion math from the playbook - the
    // zone's raw OI strike offset by what a writer actually collected there
    // (strike + premium for a CE resistance wall, strike - premium for a PE
    // support floor). Undefined when the anchoring tick has no live premium.
    // avgSellPrice/weightedTrueZone: a second, independently-computed
    // version using the OI-buildup-weighted average sell price from real
    // tick history, instead of a single point-in-time LTP. Shown alongside
    // trueZone, not replacing it.
    supportZones: Array<{ strikePrice: number; score: number; reason: string; premium?: number; trueZone?: number; avgSellPrice?: number; weightedTrueZone?: number; weightedSampleOi?: number }>;
    resistanceZones: Array<{ strikePrice: number; score: number; reason: string; premium?: number; trueZone?: number; avgSellPrice?: number; weightedTrueZone?: number; weightedSampleOi?: number }>;
  };
  // The playbook's ATM Straddle Rule (ATM Call LTP + ATM Put LTP), computed
  // server-side by @option-decode/analytics#calculateAtmStraddleExpectedMove.
  // Distinct from the India-VIX-derived expected-move range used for chain
  // display elsewhere on this page (see buildVixStrikeRange) - kept separate
  // rather than merged since they answer the same question with two
  // different, independently-useful methods.
  atmStraddle?: {
    atmStrike: number;
    atmCallPrice: number;
    atmPutPrice: number;
    atmStraddlePrice: number;
    expectedUpperBoundary: number;
    expectedLowerBoundary: number;
  };
  alerts: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    title: string;
    message: string;
    metric: string;
    createdAt: string;
  }>;
  // ATM +/-4 strike movement rows, computed server-side by
  // @option-decode/analytics#calculateStrikeMovement - the same rows the
  // Trade Recommendations engine's netScore is based on. The client only
  // adds presentation-only decoration on top of these (see
  // buildStrikeMovementRows in strike-pressure-analytics.ts); it must not
  // recompute the scores itself, or the Strike Movement table and the
  // recommendations above it can silently disagree on the same data.
  strikeMovement: StrikeMovementRow[];
  recommendations: Recommendation[];
  marketPulse?: MarketPulse | null;
}

export interface Recommendation {
  id: string;
  category: "direction" | "strategy" | "timing" | "avoid";
  priority: "high" | "medium" | "low";
  title: string;
  explanation: string;
  action: string;
  confidence: number;
  tradeSetup?: {
    optionType: "CE" | "PE";
    strike: number;
    entryPrice: number;
    stopLoss: number;
    target: number;
    riskRewardRatio: number;
    breakevenAtExpiry: number;
    breakevenToday: number;
  };
  // Seller-side setup(s) - see @option-decode/trading#buildSellerTradeSetup.
  // One entry for a single-leg write, two for a strangle-style CE+PE pair.
  sellSetups?: Array<{
    optionType: "CE" | "PE";
    strike: number;
    timeframe: "intraday" | "weekly" | "monthly";
    targetDelta: number;
    actualDelta: number;
    entryPrice: number;
    stopLoss: number;
    stopLossMultiplier: number;
    target: number;
    riskRewardRatio: number;
    breakevenAtExpiry: number;
  }>;
}

export interface PaperSummary {
  orders: PaperOrder[];
  openPositions: PaperPosition[];
  openPositionGroups: PaperPositionGroup[];
  closedTrades: PaperTrade[];
  stats: {
    openPositions: number;
    filledOrders: number;
    pendingOrders: number;
    realizedPnl: number;
    markToMarketPnl: number;
  };
}

interface PaperPositionGroup {
  underlyingSymbol: string;
  expiry: string;
  positions: number;
  lots: number;
  quantity: number;
  markToMarketPnl: number;
  deltaExposure: number;
}

interface MarketTickerItem {
  symbol: string;
  displayName: string;
  segment: string;
  spotPrice?: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
}

interface MarketStreamTickerPayload {
  indiaVix?: number;
  ticker?: MarketTickerItem[];
  serverTime?: string;
}

interface MarketStreamSnapshotPayload {
  underlying?: string;
  expiry?: string;
  serverTime?: string;
}

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
  updatedAt: string;
}

export interface AlertThreshold {
  underlyingSymbol: string;
  proximityPoints: number;
  pcrUpper: number;
  pcrLower: number;
  pressureWarning: number;
  pressureCritical: number;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
  role: string;
  emailVerified: boolean;
  disabled: boolean;
  lastLoginAt?: string;
  plan?: {
    code: string;
    name: string;
    status: string;
    realtime: boolean;
    premiumAlerts: boolean;
    replayLimit?: number;
  };
}

export interface AdminOverview {
  users: Array<{
    id: string;
    email: string;
    displayName?: string;
    role: "ADMIN" | "SUBSCRIBER" | "TRIAL" | "FREE";
    emailVerified: boolean;
    disabled: boolean;
    lastLoginAt?: string;
    createdAt: string;
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

export interface ReplaySnapshotSummary {
  id: string;
  tradingDate: string;
  snapshotTime: string;
  underlyingSymbol: string;
  expiry: string;
  spotPrice: number;
  atmStrike: number;
}

interface PaperOrder {
  id: string;
  underlyingSymbol: string;
  expiry: string;
  action: string;
  optionType: "CE" | "PE";
  strikePrice: number;
  lots: number;
  lotSize: number;
  quantity: number;
  requestedPrice: number;
  filledPrice?: number;
  currentPrice?: number;
  stopLoss: number;
  trailingStop: boolean;
  trailDistance: number;
  targetPrice: number;
  status: string;
  strategyName: string;
  createdAt: string;
  ownerEmail?: string;
  ownerName?: string;
}

interface PaperPosition {
  id: string;
  underlyingSymbol: string;
  expiry: string;
  action: string;
  optionType: "CE" | "PE";
  strikePrice: number;
  lots: number;
  lotSize: number;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  trailingStop: boolean;
  trailDistance: number;
  bestPrice: number;
  targetPrice: number;
  delta?: number;
  deltaExposure?: number;
  unrealizedPnl: number;
  status: string;
  openedAt: string;
  ownerEmail?: string;
  ownerName?: string;
}

interface PaperTrade {
  id: string;
  positionId: string;
  underlyingSymbol: string;
  expiry: string;
  action: string;
  optionType: "CE" | "PE";
  strikePrice: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  targetPrice: number;
  lots: number;
  lotSize: number;
  quantity: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
  ownerEmail?: string;
  ownerName?: string;
}

interface LiveDashboardProps {
  initialOverview: MarketOverview;
  initialParams?: {
    underlying?: string;
    expiry?: string;
    auth?: string;
  };
  initialView?: DashboardView;
  onAuthUserChange?: (user: AuthUser | null) => void;
  onMarketSelectionChange?: (params: { underlying: string; expiry: string }) => void;
  // Lets a child view (currently just the Option Chain's quick-order
  // buttons) switch which tab is showing, the same way clicking a nav item
  // in AppShell does. LiveDashboard doesn't own `activeView` itself - it's
  // state in AppShell, passed down as `initialView` - so it can't just flip
  // its own tab; it has to ask the parent to do it.
  onNavigateToView?: (view: DashboardView) => void;
}

export type DashboardView = "dashboard" | "new-dashboard" | "option-chain" | "pressure" | "replay" | "paper" | "alerts" | "account" | "admin" | "settings";
type NumberFormatMode = "indian" | "metric";
type QuantityDisplayMode = "lots" | "numbers";
type VisibleStrikeMode = "vix" | "atm";
type ChainTableMode = "standard" | "greeks";

const REFRESH_SECONDS = 30;
const FAST_REFRESH_SECONDS = 5;
const DEFAULT_ALERT_THRESHOLDS: Record<string, AlertThreshold> = {
  NIFTY: { underlyingSymbol: "NIFTY", proximityPoints: 100, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  BANKNIFTY: { underlyingSymbol: "BANKNIFTY", proximityPoints: 250, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  FINNIFTY: { underlyingSymbol: "FINNIFTY", proximityPoints: 100, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  MIDCPNIFTY: { underlyingSymbol: "MIDCPNIFTY", proximityPoints: 75, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  NIFTYNXT50: { underlyingSymbol: "NIFTYNXT50", proximityPoints: 150, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  SENSEX: { underlyingSymbol: "SENSEX", proximityPoints: 250, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  BANKEX: { underlyingSymbol: "BANKEX", proximityPoints: 150, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  CRUDEOIL: { underlyingSymbol: "CRUDEOIL", proximityPoints: 30, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  NATURALGAS: { underlyingSymbol: "NATURALGAS", proximityPoints: 5, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  COPPER: { underlyingSymbol: "COPPER", proximityPoints: 10, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 },
  SILVER: { underlyingSymbol: "SILVER", proximityPoints: 150, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 }
};

function defaultAlertThreshold(underlyingSymbol: string): AlertThreshold {
  const normalized = underlyingSymbol.toUpperCase();
  return DEFAULT_ALERT_THRESHOLDS[normalized] ?? { underlyingSymbol: normalized, proximityPoints: 100, pcrUpper: 1.15, pcrLower: 0.85, pressureWarning: 55, pressureCritical: 62 };
}

function defaultAlertThresholdDraft(underlyingSymbol: string) {
  const threshold = defaultAlertThreshold(underlyingSymbol);
  return {
    proximityPoints: String(threshold.proximityPoints),
    pcrUpper: String(threshold.pcrUpper),
    pcrLower: String(threshold.pcrLower),
    pressureWarning: String(threshold.pressureWarning),
    pressureCritical: String(threshold.pressureCritical)
  };
}

export function LiveDashboard({ initialOverview, initialParams, initialView = "dashboard", onAuthUserChange, onMarketSelectionChange, onNavigateToView }: LiveDashboardProps) {
  const [overview, setOverview] = useState(initialOverview);
  const [lastRefresh, setLastRefresh] = useState(initialOverview.snapshot.snapshotTime);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isMarketStreamConnected, setIsMarketStreamConnected] = useState(false);
  const [secondsToRefresh, setSecondsToRefresh] = useState(REFRESH_SECONDS);
  const [paperSummary, setPaperSummary] = useState<PaperSummary | null>(null);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [watchlistError, setWatchlistError] = useState<string | null>(null);
  const [alertThresholds, setAlertThresholds] = useState<AlertThreshold[]>([]);
  const [alertThresholdDraft, setAlertThresholdDraft] = useState(defaultAlertThresholdDraft(initialOverview.selectedUnderlying));
  const [alertSettingsStatus, setAlertSettingsStatus] = useState<string | null>(null);
  const [isSavingAlertThresholds, setIsSavingAlertThresholds] = useState(false);
  const [pushStatus, setPushStatus] = useState<string | null>(null);
  const [isPushSubmitting, setIsPushSubmitting] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">(initialParams?.auth === "register" ? "register" : "login");
  const [authEmail, setAuthEmail] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [updatingAdminUserId, setUpdatingAdminUserId] = useState<string | null>(null);
  const [replaySnapshots, setReplaySnapshots] = useState<ReplaySnapshotSummary[]>([]);
  const [replayOverview, setReplayOverview] = useState<MarketOverview | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [replaySpeedMs, setReplaySpeedMs] = useState(1500);
  const [replayExpiry, setReplayExpiry] = useState(initialOverview.selectedExpiry);
  const [replayStartSnapshotId, setReplayStartSnapshotId] = useState("");
  const [replayTradingDates, setReplayTradingDates] = useState<string[]>([]);
  const [replayTradingDate, setReplayTradingDate] = useState("");
  const [alertFilter, setAlertFilter] = useState<"all" | "critical" | "warning" | "info" | "dismissed">("all");
  const [dismissedAlertIds, setDismissedAlertIds] = useState<string[]>([]);
  const [newWatchSymbol, setNewWatchSymbol] = useState("");
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [orderAction, setOrderAction] = useState<"BUY" | "SELL">("BUY");
  const [orderOptionType, setOrderOptionType] = useState<"CE" | "PE">("CE");
  const [orderStrike, setOrderStrike] = useState(String(initialOverview.snapshot.atmStrike));
  // Lets a paper trade target a different expiry (e.g. next week) than
  // whatever the main dashboard currently has selected. Defaults to the
  // dashboard's expiry; when the user picks a different one, a separate
  // option-chain snapshot is fetched just for the order ticket (see the
  // effect below) so the rest of the dashboard keeps showing the originally
  // selected expiry undisturbed.
  const [orderExpiry, setOrderExpiry] = useState(initialOverview.selectedExpiry);
  const [orderExpiryOverview, setOrderExpiryOverview] = useState<MarketOverview | null>(null);
  const [orderExpiryError, setOrderExpiryError] = useState<string | null>(null);
  const lastOrderUnderlyingRef = useRef(initialOverview.selectedUnderlying);
  // Mirrors lastOrderUnderlyingRef, but for Replay Lab's independently
  // selected expiry/day - see the effect below (declared after
  // initializeReplayView, which it depends on) for why this needs a fix at
  // all: without it, switching the underlying via Market Controls leaves
  // replayExpiryRef pointed at the PREVIOUS underlying's expiry, and that
  // stale value gets reused as if it were valid for the new underlying.
  const lastReplayUnderlyingRef = useRef(initialOverview.selectedUnderlying);
  const [orderEntry, setOrderEntry] = useState("");
  const [orderLots, setOrderLots] = useState("1");
  const [orderStopLoss, setOrderStopLoss] = useState("");
  const [orderTarget, setOrderTarget] = useState("");
  const [orderTrailingStop, setOrderTrailingStop] = useState(true);
  const [isOrderStopLossEdited, setIsOrderStopLossEdited] = useState(false);
  const [isOrderTargetEdited, setIsOrderTargetEdited] = useState(false);
  const [positionRiskDrafts, setPositionRiskDrafts] = useState<Record<string, { stopLoss: string; trailDistance: string; targetPrice: string; trailingStop: boolean }>>({});
  const [updatingRiskPositionId, setUpdatingRiskPositionId] = useState<string | null>(null);
  const [pendingOrderDrafts, setPendingOrderDrafts] = useState<Record<string, { lots: string; requestedPrice: string; stopLoss: string; targetPrice: string; trailingStop: boolean }>>({});
  const [updatingPendingOrderId, setUpdatingPendingOrderId] = useState<string | null>(null);
  const [cancelingPendingOrderId, setCancelingPendingOrderId] = useState<string | null>(null);
  const [numberFormatMode, setNumberFormatMode] = useState<NumberFormatMode>("indian");
  const [quantityDisplayMode, setQuantityDisplayMode] = useState<QuantityDisplayMode>("lots");
  const [visibleStrikeMode, setVisibleStrikeMode] = useState<VisibleStrikeMode>("vix");
  const [chainTableMode, setChainTableMode] = useState<ChainTableMode>("standard");
  const selectionRef = useRef({
    underlying: initialOverview.selectedUnderlying,
    expiry: initialOverview.selectedExpiry
  });
  const tickerSymbolsRef = useRef(initialOverview.ticker?.map((item) => item.symbol) ?? [initialOverview.selectedUnderlying]);
  const isRefreshingRef = useRef(false);
  const isFastRefreshingRef = useRef(false);
  const isPaperRefreshingRef = useRef(false);
  const isMarketStreamConnectedRef = useRef(false);
  // Timestamp of the last event actually received on the SSE connection
  // (ticker, snapshot-ready, or heartbeat) - see the stream-watchdog effect
  // below for why this exists alongside isMarketStreamConnectedRef.
  const lastStreamEventAtRef = useRef(Date.now());
  const [marketStreamReconnectToken, setMarketStreamReconnectToken] = useState(0);
  const replaySnapshotsRef = useRef<ReplaySnapshotSummary[]>([]);
  const replayIndexRef = useRef(0);
  // Mirrors of state read inside refreshReplayTimeline so that callback can
  // have a stable [] dependency list. Previously it closed over `overview`
  // and `replayStartSnapshotId` directly and was recreated whenever either
  // changed; since `overview` changes on every poll tick and this function
  // itself sets `replayStartSnapshotId`, that made the effect that calls it
  // re-fire in a loop (worse now that listReplaySnapshots caps to a bounded
  // window — a previously-selected snapshot id can fall out of that window
  // and get reset every time, which used to never happen when the query
  // was unbounded).
  const overviewRef = useRef(overview);
  const replayExpiryRef = useRef(replayExpiry);
  const replayStartSnapshotIdRef = useRef(replayStartSnapshotId);
  const replayTradingDateRef = useRef(replayTradingDate);

  useEffect(() => {
    overviewRef.current = overview;
  }, [overview]);

  // ReplayLab is presentational and calls these setters directly from its
  // own onChange handlers (Replay Expiry / Replay Day pickers), so they're
  // wrapped here to keep replayExpiryRef/replayStartSnapshotIdRef/
  // replayTradingDateRef in sync no matter which code path changes the
  // state.
  const setReplayExpiryWithRef = useCallback((value: string) => {
    replayExpiryRef.current = value;
    setReplayExpiry(value);
  }, []);
  const setReplayStartSnapshotIdWithRef = useCallback((value: string) => {
    replayStartSnapshotIdRef.current = value;
    setReplayStartSnapshotId(value);
  }, []);
  const setReplayTradingDateWithRef = useCallback((value: string) => {
    replayTradingDateRef.current = value;
    setReplayTradingDate(value);
  }, []);

  // Fetches which trading days actually have stored data for a given
  // expiry (used by the Replay Day calendar), and re-picks a default day
  // (the most recent one) since the previously-selected day may not exist
  // for a newly-picked expiry. Stable [] deps, same reasoning as
  // refreshReplayTimeline below - reads the underlying from a ref so it
  // doesn't need to be recreated (and re-fire any effect it's a dependency
  // of) whenever `overview` changes.
  const refreshReplayTradingDatesFor = useCallback(async (expiry: string) => {
    try {
      const dates = await fetchReplayTradingDates(selectionRef.current.underlying, expiry || selectionRef.current.expiry);
      setReplayTradingDates(dates);
      const defaultDate = dates[dates.length - 1] ?? "";
      replayTradingDateRef.current = defaultDate;
      setReplayTradingDate(defaultDate);
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : "Unable to load replay trading dates");
    }
  }, []);

  useEffect(() => {
    try {
      const storedDismissedAlerts = window.localStorage.getItem("option-decode-dismissed-alerts");
      if (storedDismissedAlerts) {
        const parsedAlerts = JSON.parse(storedDismissedAlerts);
        if (Array.isArray(parsedAlerts)) {
          setDismissedAlertIds(parsedAlerts.filter((alertId): alertId is string => typeof alertId === "string"));
        }
      }
    } catch {
      window.localStorage.removeItem("option-decode-dismissed-alerts");
    }
  }, []);

  useEffect(() => {
    try {
      const storedPreferences = JSON.parse(window.localStorage.getItem("option-decode-display-preferences") ?? "{}") as Partial<{
        numberFormatMode: NumberFormatMode;
        quantityDisplayMode: QuantityDisplayMode;
        visibleStrikeMode: VisibleStrikeMode;
      }>;
      if (storedPreferences.numberFormatMode === "metric" || storedPreferences.numberFormatMode === "indian") {
        setNumberFormatMode(storedPreferences.numberFormatMode);
      }
      if (storedPreferences.quantityDisplayMode === "numbers" || storedPreferences.quantityDisplayMode === "lots") {
        setQuantityDisplayMode(storedPreferences.quantityDisplayMode);
      }
      if (storedPreferences.visibleStrikeMode === "atm" || storedPreferences.visibleStrikeMode === "vix") {
        setVisibleStrikeMode(storedPreferences.visibleStrikeMode);
      }
    } catch {
      window.localStorage.removeItem("option-decode-display-preferences");
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("option-decode-dismissed-alerts", JSON.stringify(dismissedAlertIds));
  }, [dismissedAlertIds]);

  useEffect(() => {
    window.localStorage.setItem(
      "option-decode-display-preferences",
      JSON.stringify({
        numberFormatMode,
        quantityDisplayMode,
        visibleStrikeMode
      })
    );
  }, [numberFormatMode, quantityDisplayMode, visibleStrikeMode]);

  useEffect(() => {
    setOverview(initialOverview);
    setLastRefresh(new Date().toISOString());
    setSecondsToRefresh(REFRESH_SECONDS);
    selectionRef.current = {
      underlying: initialOverview.selectedUnderlying,
      expiry: initialOverview.selectedExpiry
    };
    tickerSymbolsRef.current = initialOverview.ticker?.map((item) => item.symbol) ?? [initialOverview.selectedUnderlying];
    setOrderStrike(String(initialOverview.snapshot.atmStrike));
    setOrderExpiry(initialOverview.selectedExpiry);
    setOrderExpiryOverview(null);
    setOrderExpiryError(null);
    lastOrderUnderlyingRef.current = initialOverview.selectedUnderlying;
    setReplayOverview(null);
    setReplaySnapshots([]);
    setReplayIndex(0);
    setReplayExpiry(initialOverview.selectedExpiry);
    replayExpiryRef.current = initialOverview.selectedExpiry;
    setReplayStartSnapshotId("");
    replayStartSnapshotIdRef.current = "";
    setReplayTradingDate("");
    replayTradingDateRef.current = "";
    setReplayTradingDates([]);
    replayIndexRef.current = 0;
    replaySnapshotsRef.current = [];
    setIsReplayPlaying(false);
  }, [initialOverview]);

  useEffect(() => {
    selectionRef.current = {
      underlying: overview.selectedUnderlying,
      expiry: overview.selectedExpiry
    };
  }, [overview.selectedExpiry, overview.selectedUnderlying]);

  // Switching the underlying invalidates any independently-selected order
  // expiry (a different underlying has a different expiry calendar), so
  // snap the order ticket back to that underlying's currently-selected
  // expiry. A plain expiry change on the SAME underlying does NOT reset
  // orderExpiry - that's the whole point of letting the order ticket track
  // a different expiry than the dashboard.
  useEffect(() => {
    if (lastOrderUnderlyingRef.current === overview.selectedUnderlying) {
      return;
    }
    lastOrderUnderlyingRef.current = overview.selectedUnderlying;
    setOrderExpiry(overview.selectedExpiry);
    setOrderExpiryOverview(null);
    setOrderExpiryError(null);
  }, [overview.selectedExpiry, overview.selectedUnderlying]);

  // Fetches a standalone option-chain snapshot for the order ticket's
  // expiry whenever it diverges from the dashboard's own selection, so
  // strike choices/LTP in the Paper Order Ticket reflect the expiry the
  // user actually intends to trade rather than whatever the rest of the
  // dashboard is showing.
  useEffect(() => {
    if (orderExpiry === overview.selectedExpiry) {
      setOrderExpiryOverview(null);
      setOrderExpiryError(null);
      return;
    }
    let cancelled = false;
    setOrderExpiryError(null);
    fetchMarketOverview(overview.selectedUnderlying, orderExpiry)
      .then((next) => {
        if (cancelled) return;
        setOrderExpiryOverview(next);
        setOrderStrike(String(next.snapshot.atmStrike));
      })
      .catch((error) => {
        if (cancelled) return;
        setOrderExpiryOverview(null);
        setOrderExpiryError(error instanceof Error ? error.message : "Unable to load the option chain for that expiry");
      });
    return () => {
      cancelled = true;
    };
  }, [orderExpiry, overview.selectedExpiry, overview.selectedUnderlying]);

  const refreshOverview = useCallback(async () => {
    if (isRefreshingRef.current) {
      return;
    }

    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const { underlying, expiry } = selectionRef.current;
      const nextOverview = await fetchMarketOverview(underlying, expiry);
      setOverview(nextOverview);
      tickerSymbolsRef.current = nextOverview.ticker?.map((item) => item.symbol) ?? [nextOverview.selectedUnderlying];
      setLastRefresh(new Date().toISOString());
      setSecondsToRefresh(REFRESH_SECONDS);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Unable to refresh market data");
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  const loadMarketSelection = useCallback(async (underlying: string, expiry = "") => {
    if (isRefreshingRef.current) {
      return;
    }

    const nextUnderlying = underlying.trim().toUpperCase();
    if (!nextUnderlying) {
      return;
    }

    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const nextOverview = await fetchMarketOverview(nextUnderlying, expiry.trim());
      setOverview(nextOverview);
      tickerSymbolsRef.current = nextOverview.ticker?.map((item) => item.symbol) ?? [nextOverview.selectedUnderlying];
      setLastRefresh(new Date().toISOString());
      setSecondsToRefresh(REFRESH_SECONDS);
      selectionRef.current = {
        underlying: nextOverview.selectedUnderlying,
        expiry: nextOverview.selectedExpiry
      };
      onMarketSelectionChange?.({
        underlying: nextOverview.selectedUnderlying,
        expiry: nextOverview.selectedExpiry
      });
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Unable to load selected market");
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshing(false);
    }
  }, [onMarketSelectionChange]);

  const refreshPaperSummary = useCallback(async () => {
    if (isPaperRefreshingRef.current) {
      return;
    }

    isPaperRefreshingRef.current = true;
    try {
      setPaperError(null);
      setPaperSummary(await fetchPaperSummary());
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Unable to load paper trading");
    } finally {
      isPaperRefreshingRef.current = false;
    }
  }, []);

  const refreshFastMarketData = useCallback(async () => {
    if (isFastRefreshingRef.current) {
      return;
    }

    isFastRefreshingRef.current = true;
    try {
      const payload = await fetchMarketTicker(tickerSymbolsRef.current);
      setOverview((currentOverview) => ({
        ...currentOverview,
        indiaVix: payload.indiaVix ?? currentOverview.indiaVix,
        ticker: mergeTickerItems(currentOverview.ticker ?? [], payload.ticker ?? [])
      }));
    } catch {
      // Keep the last ticker on transient quote refresh failures.
    } finally {
      isFastRefreshingRef.current = false;
    }
  }, []);

  useEffect(() => {
    lastStreamEventAtRef.current = Date.now();
    const { underlying, expiry } = selectionRef.current;
    const stream = new EventSource(buildMarketStreamUrl(underlying, expiry, tickerSymbolsRef.current), {
      withCredentials: true
    });

    stream.onopen = () => {
      lastStreamEventAtRef.current = Date.now();
      isMarketStreamConnectedRef.current = true;
      setIsMarketStreamConnected(true);
    };
    stream.onerror = () => {
      isMarketStreamConnectedRef.current = false;
      setIsMarketStreamConnected(false);
    };
    stream.addEventListener("ticker", (event) => {
      lastStreamEventAtRef.current = Date.now();
      try {
        const payload = JSON.parse(event.data) as MarketStreamTickerPayload;
        setOverview((currentOverview) => ({
          ...currentOverview,
          indiaVix: payload.indiaVix ?? currentOverview.indiaVix,
          ticker: mergeTickerItems(currentOverview.ticker ?? [], payload.ticker ?? [])
        }));
      } catch {
        // Ignore malformed stream events and allow the polling fallback to recover.
      }
    });
    stream.addEventListener("snapshot-ready", (event) => {
      lastStreamEventAtRef.current = Date.now();
      try {
        const payload = JSON.parse(event.data) as MarketStreamSnapshotPayload;
        if (!payload.underlying || payload.underlying === selectionRef.current.underlying) {
          refreshOverview();
        }
      } catch {
        refreshOverview();
      }
    });
    // The server also emits a "heartbeat" event every 15s purely so a quiet-
    // but-open connection can be told apart from one that's actually dead -
    // see the watchdog effect below. No UI reacts to it, so there's nothing
    // to do here beyond recording that something arrived.
    stream.addEventListener("heartbeat", () => {
      lastStreamEventAtRef.current = Date.now();
    });

    return () => {
      isMarketStreamConnectedRef.current = false;
      setIsMarketStreamConnected(false);
      stream.close();
    };
  }, [overview.selectedExpiry, overview.selectedUnderlying, refreshOverview, marketStreamReconnectToken]);

  // onerror only fires if the browser's HTTP connection actually closes or
  // errors out. It stays silent if something in front of the API (a proxy,
  // a CDN, a network hiccup) leaves the connection open but stops actually
  // delivering bytes - the EventSource just sits there looking "connected"
  // forever. That's dangerous here specifically because the REFRESH_SECONDS/
  // FAST_REFRESH_SECONDS polling fallbacks above are gated on
  // isMarketStreamConnectedRef being false, so a silently-stalled stream
  // blocks its own fallback: no live data, and nothing else picks up the
  // slack. This watchdog treats "nothing received in a while" as equivalent
  // to disconnected - the server sends a ticker at least every 5s and a
  // heartbeat at least every 15s, so 40s of total silence means the stream
  // is not actually delivering anything regardless of what its readyState
  // claims. Flips the connected flag off (unblocking polling immediately)
  // and bumps marketStreamReconnectToken to force the effect above to tear
  // down and recreate the EventSource, in case the stall was recoverable.
  useEffect(() => {
    const STALE_AFTER_MS = 40_000;
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastStreamEventAtRef.current > STALE_AFTER_MS) {
        isMarketStreamConnectedRef.current = false;
        setIsMarketStreamConnected(false);
        setMarketStreamReconnectToken((token) => token + 1);
      }
    }, 5000);

    return () => window.clearInterval(watchdog);
  }, []);

  const refreshWatchlist = useCallback(async () => {
    try {
      setWatchlistError(null);
      setWatchlist(await fetchDefaultWatchlist());
    } catch (error) {
      setWatchlistError(error instanceof Error ? error.message : "Unable to load watchlist");
    }
  }, []);

  const refreshAuthUser = useCallback(async () => {
    try {
      const payload = await fetchAuthUser();
      setAuthUser(payload.user);
      onAuthUserChange?.(payload.user);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to load account");
      onAuthUserChange?.(null);
    }
  }, [onAuthUserChange]);

  const refreshAdminOverview = useCallback(async () => {
    try {
      setAdminError(null);
      setAdminOverview(await fetchAdminOverview());
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Unable to load admin console");
    }
  }, []);

  const refreshAlertThresholds = useCallback(async () => {
    try {
      const thresholds = await fetchAlertThresholds();
      setAlertThresholds(thresholds);
      setAlertSettingsStatus(null);
    } catch (error) {
      setAlertSettingsStatus(error instanceof Error ? error.message : "Unable to load alert settings");
    }
  }, []);

  const refreshReplayTimeline = useCallback(async () => {
    try {
      setReplayError(null);
      const snapshots = await fetchReplayTimeline(selectionRef.current.underlying, replayExpiryRef.current || selectionRef.current.expiry, replayTradingDateRef.current || undefined);
      setReplaySnapshots(snapshots);
      replaySnapshotsRef.current = snapshots;
      const requestedIndex = replayStartSnapshotIdRef.current
        ? snapshots.findIndex((snapshot) => snapshot.id === replayStartSnapshotIdRef.current)
        : 0;
      const nextIndex = Math.max(0, requestedIndex);
      if (snapshots[nextIndex]) {
        replayIndexRef.current = nextIndex;
        setReplayIndex(nextIndex);
        replayStartSnapshotIdRef.current = snapshots[nextIndex].id;
        setReplayStartSnapshotId(snapshots[nextIndex].id);
        setReplayOverview(await fetchReplaySnapshot(snapshots[nextIndex].id, overviewRef.current));
      } else {
        replayIndexRef.current = 0;
        setReplayIndex(0);
        setReplayOverview(null);
      }
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : "Unable to load replay timeline");
    }
  }, []);

  // Only needed once, when the Replay tab is first opened: there's no
  // trading day selected yet, so we can't call refreshReplayTimeline until
  // we know which days exist and have picked a default one. Subsequent
  // expiry/day changes are handled imperatively in ReplayLab's own
  // onChange handlers instead (see refreshReplayTradingDatesFor), each
  // still requiring an explicit "Load Replay" click to actually fetch -
  // this just gets that first load working without one.
  const initializeReplayView = useCallback(async () => {
    await refreshReplayTradingDatesFor(replayExpiryRef.current || selectionRef.current.expiry);
    await refreshReplayTimeline();
  }, [refreshReplayTradingDatesFor, refreshReplayTimeline]);

  // BUG FIX: switching the underlying via Market Controls (Symbol + Apply)
  // used to leave Replay Lab entirely untouched - replayExpiry, the stored
  // trading-day list, and any loaded snapshots all kept showing whatever
  // the PREVIOUSLY selected underlying had. Two symptoms reported from
  // this: (1) Replay Lab appears to ignore the new symbol and keeps
  // showing the old one's data, and (2) because initializeReplayView falls
  // back to `replayExpiryRef.current || selectionRef.current.expiry`, a
  // stale expiry left over from the old underlying would get queried
  // against the NEW underlying's stored data - a mismatched expiry date
  // that (depending on the two underlyings' actual expiry calendars) may
  // not exist for the new symbol at all, hence "expiry list dates mismatch
  // with the actual expiry dates."
  //
  // A different underlying has a completely different, incompatible expiry
  // calendar (a FINNIFTY expiry date is meaningless for NIFTY), so - same
  // reasoning as the orderExpiry-reset effect above - only an underlying
  // change resets this, not a same-underlying expiry change (Replay Lab is
  // deliberately allowed to browse a different expiry than the live
  // dashboard is currently on).
  useEffect(() => {
    if (lastReplayUnderlyingRef.current === overview.selectedUnderlying) {
      return;
    }
    lastReplayUnderlyingRef.current = overview.selectedUnderlying;
    setReplayExpiryWithRef(overview.selectedExpiry);
    setReplayTradingDates([]);
    setReplayTradingDateWithRef("");
    setReplayStartSnapshotIdWithRef("");
    setReplaySnapshots([]);
    replaySnapshotsRef.current = [];
    setReplayIndex(0);
    replayIndexRef.current = 0;
    setReplayOverview(null);
    setReplayError(null);
    setIsReplayPlaying(false);
    // Only eagerly refetch if the user is actually looking at Replay Lab
    // right now - if they're on another tab, the existing
    // "initialView === 'replay'" effect below will pick this up (using the
    // now-correctly-reset replayExpiryRef) the moment they switch to it.
    if (initialView === "replay") {
      initializeReplayView();
    }
  }, [overview.selectedUnderlying, overview.selectedExpiry, initialView, initializeReplayView, setReplayExpiryWithRef, setReplayTradingDateWithRef, setReplayStartSnapshotIdWithRef]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!isMarketStreamConnectedRef.current) {
        refreshOverview();
      }
    }, REFRESH_SECONDS * 1000);

    return () => window.clearInterval(interval);
  }, [refreshOverview]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!isMarketStreamConnectedRef.current) {
        refreshFastMarketData();
      }
    }, FAST_REFRESH_SECONDS * 1000);

    return () => window.clearInterval(interval);
  }, [refreshFastMarketData]);

  useEffect(() => {
    if (initialView !== "paper") {
      return undefined;
    }

    const interval = window.setInterval(() => {
      refreshPaperSummary();
    }, FAST_REFRESH_SECONDS * 1000);

    return () => window.clearInterval(interval);
  }, [initialView, refreshPaperSummary]);

  useEffect(() => {
    refreshWatchlist();
    refreshAuthUser();
  }, [refreshAuthUser, refreshWatchlist]);

  useEffect(() => {
    if (initialView === "paper") {
      refreshPaperSummary();
    }
    if (initialView === "replay") {
      initializeReplayView();
    }
    if (initialView === "admin") {
      refreshAdminOverview();
    }
    if (initialView === "settings" && authUser) {
      refreshAlertThresholds();
    }
  }, [authUser, initialView, initializeReplayView, refreshAdminOverview, refreshAlertThresholds, refreshPaperSummary]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSecondsToRefresh((value) => (value <= 1 ? REFRESH_SECONDS : value - 1));
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isReplayPlaying || initialView !== "replay") {
      return undefined;
    }

    const interval = window.setInterval(() => {
      const snapshots = replaySnapshotsRef.current;
      if (!snapshots.length) {
        setIsReplayPlaying(false);
        return;
      }

      const nextIndex = replayIndexRef.current + 1;
      if (nextIndex >= snapshots.length) {
        setIsReplayPlaying(false);
        return;
      }

      void loadReplaySnapshotAtIndex(nextIndex);
    }, replaySpeedMs);

    return () => window.clearInterval(interval);
  }, [initialView, isReplayPlaying, replaySpeedMs]);

  useEffect(() => {
    setPositionRiskDrafts((drafts) => {
      const nextDrafts = { ...drafts };
      for (const position of paperSummary?.openPositions ?? []) {
        nextDrafts[position.id] = nextDrafts[position.id] ?? {
          stopLoss: formatTradablePrice(position.stopLoss),
          trailDistance: formatTradablePrice(position.trailDistance),
          targetPrice: formatTradablePrice(position.targetPrice)
        };
      }
      return nextDrafts;
    });
  }, [paperSummary?.openPositions]);

  const chainRange = useMemo(() => (visibleStrikeMode === "vix" ? buildVixStrikeRange(overview) : buildAtmStrikeRange(overview)), [overview, visibleStrikeMode]);
  const replayChainRange = useMemo(() => (visibleStrikeMode === "vix" ? buildVixStrikeRange(replayOverview ?? overview) : buildAtmStrikeRange(replayOverview ?? overview)), [overview, replayOverview, visibleStrikeMode]);
  const displayPreferences = useMemo(() => ({ numberFormatMode, quantityDisplayMode }), [numberFormatMode, quantityDisplayMode]);
  const chainRows = useMemo(() => buildChainRows(overview, chainRange, displayPreferences), [chainRange, displayPreferences, overview]);
  const oiBuildupRows = useMemo(() => buildOiBuildupRows(chainRows, overview.snapshot.atmStrike, numberFormatMode), [chainRows, numberFormatMode, overview.snapshot.atmStrike]);
  const ivSkewRows = useMemo(() => buildIvSkewRows(chainRows), [chainRows]);
  const replayChainRows = useMemo(() => buildChainRows(replayOverview ?? overview, replayChainRange, displayPreferences), [displayPreferences, overview, replayChainRange, replayOverview]);
  const activeAlerts = useMemo(() => overview.alerts.filter((alert) => !dismissedAlertIds.includes(alert.id)), [dismissedAlertIds, overview.alerts]);
  const visibleAlerts = useMemo(() => {
    return overview.alerts.filter((alert) => {
      const dismissed = dismissedAlertIds.includes(alert.id);
      if (alertFilter === "dismissed") {
        return dismissed;
      }
      if (dismissed) {
        return false;
      }
      return alertFilter === "all" || alert.severity === alertFilter;
    });
  }, [alertFilter, dismissedAlertIds, overview.alerts]);
  const displayedAlerts = initialView === "alerts" ? visibleAlerts : activeAlerts.slice(0, 3);
  const activeAlertCount = activeAlerts.length;
  const topStrikeRows = useMemo(() => buildTopStrikeRows(overview, displayPreferences), [displayPreferences, overview]);
  const zoneRows = useMemo(() => buildZoneRows(overview), [overview]);
  const chainStats = useMemo(() => buildChainStats(overview, displayPreferences), [displayPreferences, overview]);
  const pressureSummary = useMemo(() => buildPressureSummary(overview), [overview]);
  const strikeMovementRows = useMemo(() => buildStrikeMovementRows(overview), [overview]);
  const strikeMovementSummary = useMemo(() => buildStrikeMovementSummary(strikeMovementRows), [strikeMovementRows]);
  const tradeInterpretation = useMemo(() => buildTradeInterpretation(strikeMovementRows), [strikeMovementRows]);
  // Called up here rather than inside DashboardMainPanel/ReplayLab, since
  // those get unmounted whenever the user switches tabs (see the
  // `initialView === "dashboard"`/`"replay"` conditionals below) - that used
  // to wipe the tracked PE/CE trend-arrow direction on every tab switch.
  // LiveDashboard itself stays mounted for the whole session, so the ref
  // this hook keeps now survives switching away from and back to a tab.
  const strikeTrends = useStrikeScoreTrends(strikeMovementRows);
  // Replay-scoped equivalents of the four hooks above, so the Replay tab's
  // Market Detail panel reflects whichever historical snapshot is loaded
  // instead of always showing the live dashboard's current data - same
  // "replayOverview ?? overview" fallback already used by
  // replayChainRange/replayChainRows/replayStats.
  const replayChainStats = useMemo(() => buildChainStats(replayOverview ?? overview, displayPreferences), [displayPreferences, overview, replayOverview]);
  const replayPressureSummary = useMemo(() => buildPressureSummary(replayOverview ?? overview), [overview, replayOverview]);
  const replayStrikeMovementRowsForPanel = useMemo(() => buildStrikeMovementRows(replayOverview ?? overview), [overview, replayOverview]);
  const replayStrikeMovementSummary = useMemo(() => buildStrikeMovementSummary(replayStrikeMovementRowsForPanel), [replayStrikeMovementRowsForPanel]);
  const replayTradeInterpretation = useMemo(() => buildTradeInterpretation(replayStrikeMovementRowsForPanel), [replayStrikeMovementRowsForPanel]);
  // Own trend-tracking instance, kept separate from strikeTrends above so
  // scrubbing through replay history doesn't affect the live dashboard's
  // arrows or vice versa.
  const replayStrikeTrends = useStrikeScoreTrends(replayStrikeMovementRowsForPanel);
  // When the order ticket targets a different expiry than the dashboard,
  // strike choices/LTP come from the separately-fetched orderExpiryOverview
  // instead - see the fetch effect above.
  const isOrderExpiryDivergent = orderExpiry !== overview.selectedExpiry;
  const orderOverview = isOrderExpiryDivergent ? orderExpiryOverview : overview;
  const isLoadingOrderExpiry = isOrderExpiryDivergent && !orderExpiryOverview && !orderExpiryError;
  const strikeChoices = useMemo(() => (orderOverview ? buildStrikeChoices(orderOverview) : []), [orderOverview]);
  const orderTick = useMemo(() => (orderOverview ? findOptionTick(orderOverview, Number(orderStrike), orderOptionType) : undefined), [orderOptionType, orderOverview, orderStrike]);
  const marketEntryPrice = orderTick?.lastPrice ?? 0;
  const orderEntryPrice = normalizeTradablePrice(Number(orderEntry || marketEntryPrice));
  const orderLotSize = orderTick?.lotSize && orderTick.lotSize > 0 ? orderTick.lotSize : getLotSizeForUnderlying(overview.snapshot.underlyingSymbol);
  const orderQuantity = Number(orderLots || 0) * orderLotSize;
  const defaultTrailDistance = getDefaultTrailDistanceForEntry(orderEntryPrice);
  const defaultStopLoss = getTrailingStopLoss(orderAction, orderEntryPrice, defaultTrailDistance);
  const defaultTarget = getDefaultTargetPrice(orderAction, orderEntryPrice);
  const orderStopLossValue = normalizeTradablePrice(Number(orderStopLoss || defaultStopLoss));
  const orderTrailDistanceValue = normalizeTradablePrice(Math.abs(orderEntryPrice - orderStopLossValue));
  const orderTargetValue = normalizeTradablePrice(Number(orderTarget || defaultTarget));
  const estimatedRisk = orderAction === "BUY" ? Math.max(0, (orderEntryPrice - orderStopLossValue) * orderQuantity) : Math.max(0, (orderStopLossValue - orderEntryPrice) * orderQuantity);
  const estimatedReward = orderAction === "BUY" ? Math.max(0, (orderTargetValue - orderEntryPrice) * orderQuantity) : Math.max(0, (orderEntryPrice - orderTargetValue) * orderQuantity);
  const riskReward = estimatedRisk > 0 ? estimatedReward / estimatedRisk : 0;
  const replayStats = useMemo(() => buildReplayStats(replaySnapshots, replayIndex, replayOverview ?? overview), [overview, replayIndex, replayOverview, replaySnapshots]);
  const pendingPaperOrders = useMemo(() => (paperSummary?.orders ?? []).filter((order) => order.status === "PENDING"), [paperSummary?.orders]);
  const recentPaperOrders = useMemo(() => (paperSummary?.orders ?? []).filter((order) => order.status !== "PENDING"), [paperSummary?.orders]);
  const snapshotAge = formatIstTime(overview.snapshot.snapshotTime);
  const selectedAlertThreshold = useMemo(() => {
    return alertThresholds.find((threshold) => threshold.underlyingSymbol === overview.selectedUnderlying) ?? defaultAlertThreshold(overview.selectedUnderlying);
  }, [alertThresholds, overview.selectedUnderlying]);

  useEffect(() => {
    setAlertThresholdDraft({
      proximityPoints: String(selectedAlertThreshold.proximityPoints),
      pcrUpper: String(selectedAlertThreshold.pcrUpper),
      pcrLower: String(selectedAlertThreshold.pcrLower),
      pressureWarning: String(selectedAlertThreshold.pressureWarning),
      pressureCritical: String(selectedAlertThreshold.pressureCritical)
    });
  }, [selectedAlertThreshold]);

  const saveAlertThresholds = async () => {
    setIsSavingAlertThresholds(true);
    setAlertSettingsStatus(null);
    try {
      const saved = await updateAlertThreshold(overview.selectedUnderlying, {
        proximityPoints: Number(alertThresholdDraft.proximityPoints),
        pcrUpper: Number(alertThresholdDraft.pcrUpper),
        pcrLower: Number(alertThresholdDraft.pcrLower),
        pressureWarning: Number(alertThresholdDraft.pressureWarning),
        pressureCritical: Number(alertThresholdDraft.pressureCritical)
      });
      setAlertThresholds((thresholds) => [
        ...thresholds.filter((threshold) => threshold.underlyingSymbol !== saved.underlyingSymbol),
        saved
      ].sort((left, right) => left.underlyingSymbol.localeCompare(right.underlyingSymbol)));
      setAlertSettingsStatus("Alert thresholds saved.");
      await refreshOverview();
    } catch (error) {
      setAlertSettingsStatus(error instanceof Error ? error.message : "Unable to save alert thresholds");
    } finally {
      setIsSavingAlertThresholds(false);
    }
  };

  const enableBrowserPush = async () => {
    setIsPushSubmitting(true);
    setPushStatus(null);
    try {
      await registerBrowserPush();
      setPushStatus("Browser notifications are enabled for critical alerts.");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Unable to enable browser notifications");
    } finally {
      setIsPushSubmitting(false);
    }
  };

  const disableBrowserNotifications = async () => {
    setIsPushSubmitting(true);
    setPushStatus(null);
    try {
      await disableBrowserPush();
      setPushStatus("Browser notifications are disabled for this device.");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Unable to disable browser notifications");
    } finally {
      setIsPushSubmitting(false);
    }
  };
  const alertCenterHref = buildClientViewHref("alerts", overview.selectedUnderlying, overview.selectedExpiry);

  useEffect(() => {
    if (orderEntryPrice <= 0) {
      setOrderStopLoss("");
      setOrderTarget("");
      return;
    }
    if (!isOrderStopLossEdited) {
      setOrderStopLoss(formatTradablePrice(defaultStopLoss));
    }
    if (!isOrderTargetEdited) {
      setOrderTarget(formatTradablePrice(defaultTarget));
    }
  }, [defaultStopLoss, defaultTarget, isOrderStopLossEdited, isOrderTargetEdited, orderEntryPrice]);

  useEffect(() => {
    setOrderEntry(marketEntryPrice > 0 ? formatTradablePrice(marketEntryPrice) : "");
    setIsOrderStopLossEdited(false);
    setIsOrderTargetEdited(false);
  }, [marketEntryPrice, orderOptionType, orderStrike]);

  // Fills the Paper Order Ticket from a quick Buy/Sell click on the Option
  // Chain and jumps to the Paper Trading tab so the user sees it land.
  // Just sets strike/type/action/expiry - the effect above already reacts
  // to strike/type changes by pulling the fresh LTP into orderEntry and
  // resetting the edited-flags, which in turn lets the SL/target-default
  // effect recompute both from that new entry price, same as if the user
  // had changed strike/type by hand in the ticket itself.
  const handleQuickOrder = useCallback((strike: number, optionType: "CE" | "PE", action: "BUY" | "SELL") => {
    setOrderExpiry(overview.selectedExpiry);
    setOrderStrike(String(strike));
    setOrderOptionType(optionType);
    setOrderAction(action);
    setIsOrderStopLossEdited(false);
    setIsOrderTargetEdited(false);
    onNavigateToView?.("paper");
  }, [onNavigateToView, overview.selectedExpiry]);

  // hedgeLegs: optional additional legs added in the same ticket ("build
  // multi-leg at entry"), e.g. a bought OTM option protecting a sold
  // ATM/ITM main leg. Empty/omitted preserves the original single-leg
  // behavior exactly. All legs share the ticket's underlying/expiry.
  const handlePaperOrder = async (event: FormEvent<HTMLFormElement>, hedgeLegs: HedgeLegDraft[] = []) => {
    event.preventDefault();
    setIsPlacingOrder(true);
    setPaperError(null);
    try {
      const mainLeg = {
        underlyingSymbol: overview.snapshot.underlyingSymbol,
        expiry: orderExpiry,
        action: orderAction,
        optionType: orderOptionType,
        strikePrice: Number(orderStrike),
        lots: Number(orderLots),
        requestedPrice: normalizeTradablePrice(orderEntryPrice),
        stopLoss: normalizeTradablePrice(orderStopLossValue),
        trailingStop: orderTrailingStop,
        trailDistance: normalizeTradablePrice(orderTrailDistanceValue),
        targetPrice: normalizeTradablePrice(orderTargetValue),
        strategyName: "Dashboard pressure setup",
        reasonText: `${overview.pressure.bullishPressure}% bullish / ${overview.pressure.bearishPressure}% bearish pressure`
      };

      const nextSummary = hedgeLegs.length
        ? await placeMultiLegPaperOrder([
            { ...mainLeg, legRole: "MAIN" as const },
            ...hedgeLegs.map((leg) => ({
              underlyingSymbol: overview.snapshot.underlyingSymbol,
              expiry: orderExpiry,
              action: leg.action,
              optionType: leg.optionType,
              strikePrice: leg.strikePrice,
              lots: leg.lots,
              requestedPrice: normalizeTradablePrice(leg.requestedPrice),
              stopLoss: normalizeTradablePrice(leg.stopLoss),
              trailingStop: false,
              trailDistance: normalizeTradablePrice(Math.abs(leg.requestedPrice - leg.stopLoss)),
              targetPrice: normalizeTradablePrice(leg.targetPrice),
              strategyName: "Dashboard pressure setup (hedge leg)",
              reasonText: "Hedge leg added at entry against the main trade",
              legRole: "HEDGE" as const
            }))
          ])
        : await placePaperOrder(mainLeg);
      setPaperSummary(nextSummary);
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Unable to place paper order");
    } finally {
      setIsPlacingOrder(false);
    }
  };

  const handleClosePosition = async (positionId: string) => {
    setClosingPositionId(positionId);
    setPaperError(null);
    try {
      setPaperSummary(await closePaperPosition(positionId));
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Unable to close paper position");
    } finally {
      setClosingPositionId(null);
    }
  };

  const handleUpdatePendingOrder = async (orderId: string) => {
    const order = pendingPaperOrders.find((pendingOrder) => pendingOrder.id === orderId);
    if (!order) {
      return;
    }

    const draft = pendingOrderDrafts[orderId] ?? {
      lots: String(order.lots),
      requestedPrice: formatTradablePrice(order.requestedPrice),
      stopLoss: formatTradablePrice(order.stopLoss),
      targetPrice: formatTradablePrice(order.targetPrice),
      trailingStop: order.trailingStop
    };
    const requestedPrice = normalizeTradablePrice(Number(draft.requestedPrice || order.requestedPrice));
    const stopLoss = normalizeTradablePrice(Number(draft.stopLoss || order.stopLoss));
    const trailDistance = normalizeTradablePrice(Math.abs(requestedPrice - stopLoss));
    const targetPrice = normalizeTradablePrice(Number(draft.targetPrice || order.targetPrice));

    setUpdatingPendingOrderId(orderId);
    setPaperError(null);
    try {
      setPaperSummary(await updatePendingPaperOrder(orderId, {
        lots: Math.max(1, Math.floor(Number(draft.lots || order.lots))),
        requestedPrice,
        stopLoss,
        trailingStop: draft.trailingStop ?? order.trailingStop,
        trailDistance,
        targetPrice
      }));
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Unable to update pending order");
    } finally {
      setUpdatingPendingOrderId(null);
    }
  };

  const handleCancelPendingOrder = async (orderId: string) => {
    setCancelingPendingOrderId(orderId);
    setPaperError(null);
    try {
      setPaperSummary(await cancelPendingPaperOrder(orderId));
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Unable to cancel pending order");
    } finally {
      setCancelingPendingOrderId(null);
    }
  };

  const handleMarketControlSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextUnderlying = String(formData.get("underlying") ?? "").trim().toUpperCase();
    const formExpiry = String(formData.get("expiry") ?? "").trim();
    // BUG FIX: the Expiry field (market-controls.tsx's ExpiryFormField) is
    // staged in its OWN local state and only resets when this form remounts
    // - which happens after a successful submit, via the
    // key={selectedUnderlying-selectedExpiry} on the form, not while the
    // user is still mid-edit on the Symbol field above it. So typing a new
    // Symbol and hitting Apply in one go submits the NEW underlying
    // alongside the OLD underlying's still-staged expiry - a date that may
    // not even exist for the new symbol (e.g. NIFTY's weekly Tuesday expiry
    // sent for BANKNIFTY, which only trades monthly). That mismatched
    // expiry was being forced through as an explicit override, and
    // everything downstream (this dashboard, Replay Lab's tradable-date
    // list) had no real data for that combination.
    //
    // Only trust the staged expiry when the symbol ISN'T changing; on an
    // actual underlying switch, drop it and let the server pick that
    // underlying's own nearest/default expiry - exactly like the watchlist
    // "Play" button already does via loadMarketSelection(symbol) with no
    // expiry argument.
    const expiryToUse = nextUnderlying === overview.selectedUnderlying ? formExpiry : "";
    await loadMarketSelection(nextUnderlying, expiryToUse);
  };

  const handleUpdatePositionRisk = async (positionId: string) => {
    const draft = positionRiskDrafts[positionId];
    if (!draft) {
      return;
    }

    setUpdatingRiskPositionId(positionId);
    setPaperError(null);
    try {
      const trailDistance = normalizeTradablePrice(Number(draft.trailDistance));
      const position = paperSummary?.openPositions.find((openPosition) => openPosition.id === positionId);
      const referencePrice = position ? position.bestPrice : 0;
      const trailingStop = draft.trailingStop ?? position?.trailingStop ?? true;
      const stopLoss = position && trailingStop ? getTrailingStopLoss(position.action, referencePrice, trailDistance) : normalizeTradablePrice(Number(draft.stopLoss));
      setPaperSummary(await updatePaperPositionRisk(positionId, stopLoss, normalizeTradablePrice(Number(draft.targetPrice)), trailDistance, trailingStop));
    } catch (error) {
      setPaperError(error instanceof Error ? error.message : "Unable to update position risk");
    } finally {
      setUpdatingRiskPositionId(null);
    }
  };

  const handleAddWatchSymbol = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextSymbol = newWatchSymbol.trim().toUpperCase();
    if (!nextSymbol) {
      return;
    }

    const nextSymbols = [...new Set([...(watchlist?.symbols ?? []), nextSymbol])];
    try {
      setWatchlistError(null);
      setWatchlist(await updateDefaultWatchlist(nextSymbols));
      setNewWatchSymbol("");
    } catch (error) {
      setWatchlistError(error instanceof Error ? error.message : "Unable to update watchlist");
    }
  };

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsAuthSubmitting(true);
    setAuthError(null);
    setAuthMessage(null);
    try {
      const payload = await submitAuth(authMode, {
        email: authEmail,
        password: authPassword,
        displayName: authDisplayName
      });
      setAuthUser(payload.user);
      onAuthUserChange?.(payload.user);
      setAuthPassword("");
      setAuthMessage(authMode === "register" ? "Trial account created." : "Signed in.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Account request failed");
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setIsAuthSubmitting(true);
    setAuthError(null);
    setAuthMessage(null);
    try {
      await logoutAuthUser();
      setAuthUser(null);
      onAuthUserChange?.(null);
      setAuthMessage("Signed out.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to sign out");
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleUpdateAdminUserRole = async (userId: string, role: AdminOverview["users"][number]["role"]) => {
    setUpdatingAdminUserId(userId);
    setAdminError(null);
    try {
      await updateAdminUserRole(userId, role);
      setAdminOverview(await fetchAdminOverview());
      if (authUser?.id === userId) {
        await refreshAuthUser();
      }
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Unable to update user role");
    } finally {
      setUpdatingAdminUserId(null);
    }
  };

  const handleUpdateAdminUserDisabled = async (userId: string, disabled: boolean) => {
    setUpdatingAdminUserId(userId);
    setAdminError(null);
    try {
      await updateAdminUserDisabled(userId, disabled);
      setAdminOverview(await fetchAdminOverview());
      if (authUser?.id === userId) {
        await refreshAuthUser();
      }
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Unable to update user status");
    } finally {
      setUpdatingAdminUserId(null);
    }
  };

  const handleResendVerification = async () => {
    setIsAuthSubmitting(true);
    setAuthError(null);
    setAuthMessage(null);
    try {
      await resendVerificationEmail();
      setAuthMessage("Verification email sent.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to send verification email");
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const loadReplaySnapshotAtIndex = async (nextIndex: number) => {
    const snapshot = replaySnapshotsRef.current[nextIndex];
    if (!snapshot) {
      return;
    }

    try {
      setReplayError(null);
      replayIndexRef.current = nextIndex;
      setReplayIndex(nextIndex);
      replayStartSnapshotIdRef.current = snapshot.id;
      setReplayStartSnapshotId(snapshot.id);
      setReplayOverview(await fetchReplaySnapshot(snapshot.id, overview));
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : "Unable to load replay snapshot");
      setIsReplayPlaying(false);
    }
  };

  const handleDismissAlert = (alertId: string) => {
    setDismissedAlertIds((ids) => (ids.includes(alertId) ? ids : [...ids, alertId]));
  };

  const handleRestoreAlert = (alertId: string) => {
    setDismissedAlertIds((ids) => ids.filter((id) => id !== alertId));
  };

  return (
    <div className="grid min-w-0 gap-4">
      <MarketControls
        formatIstShortDateTime={formatIstShortDateTime}
        handleAddWatchSymbol={handleAddWatchSymbol}
        handleMarketControlSubmit={handleMarketControlSubmit}
        initialView={initialView}
        isRefreshing={isRefreshing}
        lastRefresh={lastRefresh}
        loadMarketSelection={loadMarketSelection}
        newWatchSymbol={newWatchSymbol}
        overview={overview}
        refreshOverview={refreshOverview}
        setNewWatchSymbol={setNewWatchSymbol}
        watchlist={watchlist}
        watchlistError={watchlistError}
      />

      {/* Compact KPI bar — every number here used to also appear
          separately in the 4-card metric row above and again inside
          "Trading Command Center" below. Each metric now lives in exactly
          one place. Not sticky (position: sticky) to avoid any chance of
          it overlapping/blocking the Market Controls form above it. */}
      <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-terminal-line bg-terminal-panel/95 px-3 py-2 shadow-sm">
        <KpiChip label={`${overview.snapshot.underlyingSymbol}`} value={formatPrice(overview.snapshot.spotPrice)} tone="blue" />
        <KpiChip label="ATM" value={formatStrike(overview.snapshot.atmStrike)} />
        <KpiChip label="Bias" value={pressureSummary.bias} tone={pressureSummary.bias === "Bullish" ? "emerald" : pressureSummary.bias === "Bearish" ? "red" : "default"} />
        <KpiChip label="Bull %" value={`${overview.pressure.bullishPressure}%`} tone="emerald" />
        <KpiChip label="Bear %" value={`${overview.pressure.bearishPressure}%`} tone="amber" />
        <KpiChip label="PCR" value={overview.pressure.pcr?.toFixed(2) ?? "--"} />
        <KpiChip label="Max Pain" value={pressureSummary.maxPainText} />
        <KpiChip label="Readiness" value={pressureSummary.readiness} tone={pressureSummary.readiness === "Actionable" ? "emerald" : pressureSummary.readiness === "Watch" ? "blue" : "default"} />
        <KpiChip label="Setup" value={pressureSummary.setupQualityText} tone={pressureSummary.setupQualityText.startsWith("A") ? "emerald" : pressureSummary.setupQualityText.startsWith("Wait") ? "red" : "blue"} />
        <span className="ml-auto text-xs text-terminal-muted">Updated {snapshotAge} IST</span>
      </section>

      {initialView === "dashboard" ? (
        <DashboardMainPanel
          chainStats={chainStats}
          formatLarge={formatLarge}
          formatSignedLarge={formatSignedLarge}
          formatStrike={formatStrike}
          formatTime={formatIstShortDateTime}
          getActivityLabel={getActivityLabel}
          getActivityToneClass={getActivityToneClass}
          numberFormatMode={numberFormatMode}
          overview={overview}
          pressureSummary={pressureSummary}
          strikeMovementRows={strikeMovementRows}
          strikeMovementSummary={strikeMovementSummary}
          strikeTrends={strikeTrends}
          tradeInterpretation={tradeInterpretation}
        />
      ) : null}

      {/* Unlike the other panels, Strike Matrix stays MOUNTED on every view
          and is only hidden with CSS. Conditional rendering unmounted it on
          tab switch, which killed its background refresh interval — so a
          trader flipping back to the tab momentarily saw stale numbers. The
          `contents` wrapper is layout-transparent when visible, and keeping
          the component alive also preserves the horizon / trading-date
          selection across tab switches. */}
      <div className={initialView === "new-dashboard" ? "contents" : "hidden"}>
        <StrikeMatrixPanel
          underlying={overview.selectedUnderlying}
          expiry={overview.selectedExpiry}
          formatStrike={formatStrike}
          formatTime={formatIstShortDateTime}
        />
      </div>

      {initialView === "pressure" ? (
        <PressureEngine
          buildPressureSignals={buildPressureSignals}
          chainStats={chainStats}
          formatStrike={formatStrike}
          formatTime={formatIstTime}
          isMarketStreamConnected={isMarketStreamConnected}
          lastRefresh={lastRefresh}
          overview={overview}
          pressureSummary={pressureSummary}
          refreshError={refreshError}
          refreshSeconds={REFRESH_SECONDS}
          scoreToPercent={scoreToPercent}
          secondsToRefresh={secondsToRefresh}
          zoneRows={zoneRows}
        />
      ) : null}

      {initialView === "dashboard" || initialView === "alerts" ? (
        <AlertCenter
          activeAlertCount={activeAlertCount}
          alertCenterHref={alertCenterHref}
          alertFilter={alertFilter}
          alerts={overview.alerts}
          dismissedAlertIds={dismissedAlertIds}
          displayedAlerts={displayedAlerts}
          formatTime={formatIstTime}
          mode={initialView === "alerts" ? "alerts" : "dashboard"}
          onDismissAlert={handleDismissAlert}
          onFilterChange={setAlertFilter}
          onRestoreAlert={handleRestoreAlert}
        />
      ) : null}

      {initialView === "account" ? (
        <AccountPanel
          authDisplayName={authDisplayName}
          authEmail={authEmail}
          authError={authError}
          authMessage={authMessage}
          authMode={authMode}
          authPassword={authPassword}
          authUser={authUser}
          formatIstShortDateTime={formatIstShortDateTime}
          handleAuthSubmit={handleAuthSubmit}
          handleLogout={handleLogout}
          handleResendVerification={handleResendVerification}
          isAuthSubmitting={isAuthSubmitting}
          setAuthDisplayName={setAuthDisplayName}
          setAuthEmail={setAuthEmail}
          setAuthError={setAuthError}
          setAuthMessage={setAuthMessage}
          setAuthMode={setAuthMode}
          setAuthPassword={setAuthPassword}
        />
      ) : null}

      {initialView === "admin" ? (
        <AdminPanel
          adminError={adminError}
          adminOverview={adminOverview}
          formatCurrency={formatCurrency}
          formatIstShortDateTime={formatIstShortDateTime}
          handleUpdateAdminUserDisabled={handleUpdateAdminUserDisabled}
          handleUpdateAdminUserRole={handleUpdateAdminUserRole}
          refreshAdminOverview={refreshAdminOverview}
          updatingAdminUserId={updatingAdminUserId}
        />
      ) : null}

      {initialView === "settings" ? (
        <SettingsPanel
          alertSettingsStatus={alertSettingsStatus}
          alertThresholdDraft={alertThresholdDraft}
          authUser={authUser}
          disableBrowserPush={disableBrowserNotifications}
          enableBrowserPush={enableBrowserPush}
          isPushSubmitting={isPushSubmitting}
          isSavingAlertThresholds={isSavingAlertThresholds}
          numberFormatMode={numberFormatMode}
          overview={overview}
          pushStatus={pushStatus}
          quantityDisplayMode={quantityDisplayMode}
          saveAlertThresholds={saveAlertThresholds}
          setAlertThresholdDraft={setAlertThresholdDraft}
          setNumberFormatMode={setNumberFormatMode}
          setQuantityDisplayMode={setQuantityDisplayMode}
          setVisibleStrikeMode={setVisibleStrikeMode}
          visibleStrikeMode={visibleStrikeMode}
        />
      ) : null}

      {initialView === "option-chain" ? (
        <OptionChainPanel
          overview={overview}
          formatStrike={formatStrike}
          chainRange={chainRange}
          visibleStrikeMode={visibleStrikeMode}
          setVisibleStrikeMode={setVisibleStrikeMode}
          chainTableMode={chainTableMode}
          setChainTableMode={setChainTableMode}
          isMarketStreamConnected={isMarketStreamConnected}
          chainStats={chainStats}
          formatLarge={formatLarge}
          numberFormatMode={numberFormatMode}
          formatSignedLarge={formatSignedLarge}
          oiBuildupChart={<OiBuildupChart rows={oiBuildupRows} />}
          ivSkewChart={<IvSkewChart rows={ivSkewRows} atmStrike={overview.snapshot.atmStrike} />}
          chainRows={chainRows}
          formatOptionalNumber={formatOptionalNumber}
          renderIvDeltaCell={renderIvDeltaCell}
          renderLtpStack={renderLtpStack}
          renderPressureCell={renderPressureCell}
          topStrikeRows={topStrikeRows}
          zoneRows={zoneRows}
          onQuickOrder={handleQuickOrder}
        />
      ) : null}

      {initialView === "paper" ? (
        <PaperTradingPanel
          paperSummary={paperSummary}
          formatCurrency={formatCurrency}
          formatPrice={formatPrice}
          orderEntryPrice={orderEntryPrice}
          orderAction={orderAction}
          marketEntryPrice={marketEntryPrice}
          riskReward={riskReward}
          estimatedRisk={estimatedRisk}
          orderTargetValue={orderTargetValue}
          estimatedReward={estimatedReward}
          handlePaperOrder={handlePaperOrder}
          overview={overview}
          orderExpiry={orderExpiry}
          setOrderExpiry={setOrderExpiry}
          orderExpiryChoices={overview.tradableExpiries}
          isLoadingOrderExpiry={isLoadingOrderExpiry}
          orderExpiryError={orderExpiryError}
          setOrderAction={setOrderAction}
          setIsOrderStopLossEdited={setIsOrderStopLossEdited}
          setIsOrderTargetEdited={setIsOrderTargetEdited}
          orderOptionType={orderOptionType}
          setOrderOptionType={setOrderOptionType}
          orderStrike={orderStrike}
          setOrderStrike={setOrderStrike}
          strikeChoices={strikeChoices}
          formatStrike={formatStrike}
          orderTick={orderTick}
          formatLtpChange={formatLtpChange}
          orderEntry={orderEntry}
          setOrderEntry={setOrderEntry}
          formatTradablePrice={formatTradablePrice}
          orderStopLoss={orderStopLoss}
          setOrderStopLoss={setOrderStopLoss}
          orderTrailingStop={orderTrailingStop}
          setOrderTrailingStop={setOrderTrailingStop}
          orderTrailDistanceValue={orderTrailDistanceValue}
          orderTarget={orderTarget}
          setOrderTarget={setOrderTarget}
          orderLots={orderLots}
          setOrderLots={setOrderLots}
          formatLotsAndQty={formatLotsAndQty}
          orderLotSize={orderLotSize}
          orderQuantity={orderQuantity}
          isPlacingOrder={isPlacingOrder}
          paperError={paperError}
          pendingPaperOrders={pendingPaperOrders}
          pendingOrderDrafts={pendingOrderDrafts}
          setPendingOrderDrafts={setPendingOrderDrafts}
          normalizeTradablePrice={normalizeTradablePrice}
          getTrailingStopLoss={getTrailingStopLoss}
          getDefaultTrailDistanceForEntry={getDefaultTrailDistanceForEntry}
          getDefaultTargetPrice={getDefaultTargetPrice}
          formatIstShortDateTime={formatIstShortDateTime}
          updatingPendingOrderId={updatingPendingOrderId}
          cancelingPendingOrderId={cancelingPendingOrderId}
          handleUpdatePendingOrder={handleUpdatePendingOrder}
          handleCancelPendingOrder={handleCancelPendingOrder}
          positionRiskDrafts={positionRiskDrafts}
          setPositionRiskDrafts={setPositionRiskDrafts}
          updatingRiskPositionId={updatingRiskPositionId}
          closingPositionId={closingPositionId}
          handleUpdatePositionRisk={handleUpdatePositionRisk}
          handleClosePosition={handleClosePosition}
          recentPaperOrders={recentPaperOrders}
        />
      ) : null}

      {initialView === "replay" ? (
        <ReplayLab
          replayExpiry={replayExpiry}
          setReplayExpiry={setReplayExpiryWithRef}
          setReplayStartSnapshotId={setReplayStartSnapshotIdWithRef}
          setReplayOverview={setReplayOverview}
          setReplaySnapshots={setReplaySnapshots}
          replaySnapshotsRef={replaySnapshotsRef}
          setReplayIndex={setReplayIndex}
          replayIndexRef={replayIndexRef}
          setIsReplayPlaying={setIsReplayPlaying}
          overview={overview}
          replayStartSnapshotId={replayStartSnapshotId}
          replaySnapshots={replaySnapshots}
          loadReplaySnapshotAtIndex={loadReplaySnapshotAtIndex}
          formatIstTime={formatIstTime}
          formatIstShortDateTime={formatIstShortDateTime}
          formatPrice={formatPrice}
          refreshReplayTimeline={refreshReplayTimeline}
          isReplayPlaying={isReplayPlaying}
          replayOverview={replayOverview}
          formatCurrency={formatCurrency}
          replayStats={replayStats}
          buildPressureSummary={buildPressureSummary}
          replayIndex={replayIndex}
          replaySpeedMs={replaySpeedMs}
          setReplaySpeedMs={setReplaySpeedMs}
          replayError={replayError}
          replayChainRange={replayChainRange}
          formatStrike={formatStrike}
          replayChainRows={replayChainRows}
          renderIvDeltaCell={renderIvDeltaCell}
          renderPressureCell={renderPressureCell}
          renderLtpStack={renderLtpStack}
          replayTradingDate={replayTradingDate}
          setReplayTradingDate={setReplayTradingDateWithRef}
          replayTradingDates={replayTradingDates}
          refreshReplayTradingDatesFor={refreshReplayTradingDatesFor}
          replayChainStats={replayChainStats}
          replayPressureSummary={replayPressureSummary}
          replayStrikeMovementRowsForPanel={replayStrikeMovementRowsForPanel}
          replayStrikeMovementSummary={replayStrikeMovementSummary}
          replayStrikeTrends={replayStrikeTrends}
          replayTradeInterpretation={replayTradeInterpretation}
          formatLarge={formatLarge}
          formatSignedLarge={formatSignedLarge}
          getActivityLabel={getActivityLabel}
          getActivityToneClass={getActivityToneClass}
          numberFormatMode={numberFormatMode}
        />
      ) : null}
    </div>
  );
}


// Every strike Dhan returned for this expiry, not a window around ATM -
// capping this used to silently make deep OTM strikes unreachable in the
// Strike dropdown (both the main order ticket and hedge legs), which
// directly conflicted with the seller-side setups elsewhere in this app
// that recommend exactly this kind of far-OTM strike.
function buildStrikeChoices(overview: MarketOverview) {
  return [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
}

function findOptionTick(overview: MarketOverview, strikePrice: number, optionType: "CE" | "PE") {
  return overview.snapshot.ticks.find((tick) => tick.strikePrice === strikePrice && tick.optionType === optionType);
}

function renderPressureCell(value: string, rank: 1 | 2 | undefined, percent: number, side: "CE" | "PE") {
  const alignClass = side === "PE" ? "justify-end text-right" : "justify-start text-left";
  const shouldHighlight = rank === 1 || (rank === 2 && percent >= 75);

  if (!shouldHighlight) {
    return (
      <span className={`flex ${alignClass}`}>
        <span className="grid gap-0.5 text-terminal-text">
          <span className="text-sm font-semibold leading-none text-terminal-muted">{percent}%</span>
          <span className="text-xs font-normal leading-none">{value}</span>
        </span>
      </span>
    );
  }

  const rankClass = rank === 1 ? "bg-red-300 text-slate-950 shadow-[0_0_18px_rgba(252,165,165,0.2)]" : "bg-yellow-300 text-slate-950 shadow-[0_0_18px_rgba(253,224,71,0.18)]";

  return (
    <span className={`flex ${alignClass}`}>
      <span className={`grid min-w-[5rem] place-items-center gap-0.5 rounded px-2.5 py-1.5 ${rankClass}`}>
        <span className="text-sm font-semibold leading-none">{percent}%</span>
        <span className="text-xs font-normal leading-none">{value}</span>
      </span>
    </span>
  );
}

function renderLtpStack(value?: number, change?: number, changePercent?: number, align: "left" | "right" = "left", activity: OptionActivityKind = "NEUTRAL") {
  const changeClass = change === undefined ? "text-terminal-muted" : change >= 0 ? "text-terminal-emerald" : "text-terminal-red";
  const alignment = align === "right" ? "items-end" : "items-start";

  return (
    <div className={`flex flex-col gap-0.5 ${alignment}`}>
      <span className="font-semibold text-terminal-text">{formatPrice(value)}</span>
      <span className={`whitespace-nowrap text-xs ${changeClass}`}>{formatLtpChange(change, changePercent)}</span>
      {activity !== "NEUTRAL" ? <span className={`whitespace-nowrap text-[0.65rem] font-semibold uppercase ${getActivityToneClass(activity)}`}>{getActivityLabel(activity)}</span> : null}
    </div>
  );
}

function renderIvDeltaCell(iv?: number, delta?: number, align: "left" | "right" = "left") {
  const alignment = align === "right" ? "items-end text-right" : "items-start text-left";
  return (
    <div className={`flex flex-col gap-0.5 ${alignment}`}>
      <span className="whitespace-nowrap text-xs font-semibold text-terminal-text">{formatOptionalNumber(iv, 1)}</span>
      <span className="whitespace-nowrap text-xs text-terminal-muted">{formatOptionalNumber(delta, 2)}</span>
    </div>
  );
}


function buildReplayStats(snapshots: ReplaySnapshotSummary[], replayIndex: number, overview: MarketOverview) {
  const first = snapshots[0];
  const current = snapshots[replayIndex];
  const last = snapshots[snapshots.length - 1];
  const baseSpot = first?.spotPrice ?? overview.snapshot.spotPrice;
  const currentSpot = current?.spotPrice ?? overview.snapshot.spotPrice;
  const moveFromStart = currentSpot - baseSpot;
  const movePercent = baseSpot > 0 ? (moveFromStart / baseSpot) * 100 : 0;
  const spots = snapshots.map((snapshot) => snapshot.spotPrice);
  const low = spots.length ? Math.min(...spots) : overview.snapshot.spotPrice;
  const high = spots.length ? Math.max(...spots) : overview.snapshot.spotPrice;

  return {
    moveFromStart,
    movePercentText: `${movePercent >= 0 ? "+" : ""}${movePercent.toFixed(2)}%`,
    rangeText: `${formatPrice(low)} - ${formatPrice(high)}`,
    windowText: first && last ? `${formatIstTime(first.snapshotTime)} - ${formatIstTime(last.snapshotTime)} IST` : "Waiting for snapshots"
  };
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "blue" | "emerald" | "amber" | "red" }) {
  const toneClass = tone === "emerald" ? "text-terminal-emerald" : tone === "amber" ? "text-terminal-amber" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <article className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <p className="text-xs uppercase text-terminal-muted">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
      <p className="mt-1 text-sm text-terminal-muted">{detail}</p>
    </article>
  );
}

function KpiChip({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "blue" | "emerald" | "amber" | "red" }) {
  const toneClass = tone === "emerald" ? "text-terminal-emerald" : tone === "amber" ? "text-terminal-amber" : tone === "red" ? "text-terminal-red" : tone === "blue" ? "text-terminal-blue" : "text-terminal-text";

  return (
    <span className="flex items-baseline gap-1.5 rounded border border-terminal-line/70 bg-white/[0.03] px-2.5 py-1.5">
      <span className="text-xs uppercase text-terminal-muted">{label}</span>
      <span className={`text-sm font-semibold ${toneClass}`}>{value}</span>
    </span>
  );
}

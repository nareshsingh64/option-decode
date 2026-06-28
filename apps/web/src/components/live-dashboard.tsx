"use client";

import { Clock3, Pause, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AccountPanel } from "./account-panel";
import { AdminPanel } from "./admin-panel";
import { AlertCenter } from "./alert-center";
import {
  buildClientViewHref,
  buildMarketStreamUrl,
  cancelPendingPaperOrder,
  closePaperPosition,
  fetchAdminOverview,
  fetchAlertThresholds,
  fetchAuthUser,
  fetchDefaultWatchlist,
  fetchMarketOverview,
  fetchMarketTicker,
  fetchPaperSummary,
  fetchReplaySnapshot,
  fetchReplayTimeline,
  logoutAuthUser,
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
import { DashboardMainPanel } from "./dashboard-main-panel";
import { MarketControls } from "./market-controls";
import {
  buildAtmStrikeRange,
  buildChainRows,
  buildChainStats,
  buildIvSkewRows,
  buildOiBuildupRows,
  buildTopStrikeRows,
  buildVixStrikeRange
} from "./option-chain-builders";
import type { DisplayPreferences } from "./option-chain-builders";
import { IvSkewChart, OiBuildupChart } from "./option-chain-charts";
import { OptionChainPanel } from "./option-chain-panel";
import { PaperTradingPanel } from "./paper-trading-panel";
import { PressureEngine } from "./pressure-engine";
import { ReplayLab } from "./replay-lab";
import { SettingsPanel } from "./settings-panel";

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

type OptionActivityKind = "LONG_BUILDUP" | "WRITING" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL";

export interface MarketOverview {
  underlyings: string[];
  expiries: string[];
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
    supportZones: Array<{ strikePrice: number; score: number; reason: string }>;
    resistanceZones: Array<{ strikePrice: number; score: number; reason: string }>;
  };
  alerts: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    title: string;
    message: string;
    metric: string;
    createdAt: string;
  }>;
}

export interface PaperSummary {
  orders: PaperOrder[];
  openPositions: PaperPosition[];
  closedTrades: PaperTrade[];
  stats: {
    openPositions: number;
    filledOrders: number;
    pendingOrders: number;
    realizedPnl: number;
    markToMarketPnl: number;
  };
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
}

export type DashboardView = "dashboard" | "option-chain" | "pressure" | "replay" | "paper" | "alerts" | "account" | "admin" | "settings";
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

export function LiveDashboard({ initialOverview, initialParams, initialView = "dashboard", onAuthUserChange, onMarketSelectionChange }: LiveDashboardProps) {
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
  const [alertFilter, setAlertFilter] = useState<"all" | "critical" | "warning" | "info" | "dismissed">("all");
  const [dismissedAlertIds, setDismissedAlertIds] = useState<string[]>([]);
  const [newWatchSymbol, setNewWatchSymbol] = useState("");
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [orderAction, setOrderAction] = useState<"BUY" | "SELL">("BUY");
  const [orderOptionType, setOrderOptionType] = useState<"CE" | "PE">("CE");
  const [orderStrike, setOrderStrike] = useState(String(initialOverview.snapshot.atmStrike));
  const [orderEntry, setOrderEntry] = useState("");
  const [orderLots, setOrderLots] = useState("1");
  const [orderStopLoss, setOrderStopLoss] = useState("");
  const [orderTarget, setOrderTarget] = useState("");
  const [isOrderStopLossEdited, setIsOrderStopLossEdited] = useState(false);
  const [isOrderTargetEdited, setIsOrderTargetEdited] = useState(false);
  const [positionRiskDrafts, setPositionRiskDrafts] = useState<Record<string, { stopLoss: string; trailDistance: string; targetPrice: string }>>({});
  const [updatingRiskPositionId, setUpdatingRiskPositionId] = useState<string | null>(null);
  const [pendingOrderDrafts, setPendingOrderDrafts] = useState<Record<string, { lots: string; requestedPrice: string; stopLoss: string; targetPrice: string }>>({});
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
  const replaySnapshotsRef = useRef<ReplaySnapshotSummary[]>([]);
  const replayIndexRef = useRef(0);

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
    setReplayOverview(null);
    setReplaySnapshots([]);
    setReplayIndex(0);
    setReplayExpiry(initialOverview.selectedExpiry);
    setReplayStartSnapshotId("");
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
    const { underlying, expiry } = selectionRef.current;
    const stream = new EventSource(buildMarketStreamUrl(underlying, expiry, tickerSymbolsRef.current), {
      withCredentials: true
    });

    stream.onopen = () => {
      isMarketStreamConnectedRef.current = true;
      setIsMarketStreamConnected(true);
    };
    stream.onerror = () => {
      isMarketStreamConnectedRef.current = false;
      setIsMarketStreamConnected(false);
    };
    stream.addEventListener("ticker", (event) => {
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
      try {
        const payload = JSON.parse(event.data) as MarketStreamSnapshotPayload;
        if (!payload.underlying || payload.underlying === selectionRef.current.underlying) {
          refreshOverview();
        }
      } catch {
        refreshOverview();
      }
    });

    return () => {
      isMarketStreamConnectedRef.current = false;
      setIsMarketStreamConnected(false);
      stream.close();
    };
  }, [overview.selectedExpiry, overview.selectedUnderlying, refreshOverview]);

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
      const snapshots = await fetchReplayTimeline(selectionRef.current.underlying, replayExpiry || selectionRef.current.expiry);
      setReplaySnapshots(snapshots);
      replaySnapshotsRef.current = snapshots;
      const requestedIndex = replayStartSnapshotId ? snapshots.findIndex((snapshot) => snapshot.id === replayStartSnapshotId) : 0;
      const nextIndex = Math.max(0, requestedIndex);
      if (snapshots[nextIndex]) {
        replayIndexRef.current = nextIndex;
        setReplayIndex(nextIndex);
        setReplayStartSnapshotId(snapshots[nextIndex].id);
        setReplayOverview(await fetchReplaySnapshot(snapshots[nextIndex].id, overview));
      } else {
        replayIndexRef.current = 0;
        setReplayIndex(0);
        setReplayOverview(null);
      }
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : "Unable to load replay timeline");
    }
  }, [overview, replayExpiry, replayStartSnapshotId]);

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
      refreshReplayTimeline();
    }
    if (initialView === "admin") {
      refreshAdminOverview();
    }
    if (initialView === "settings" && authUser) {
      refreshAlertThresholds();
    }
  }, [authUser, initialView, refreshAdminOverview, refreshAlertThresholds, refreshPaperSummary, refreshReplayTimeline]);

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
  const strikeChoices = useMemo(() => buildStrikeChoices(overview), [overview]);
  const orderTick = useMemo(() => findOptionTick(overview, Number(orderStrike), orderOptionType), [orderOptionType, orderStrike, overview]);
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

  const handlePaperOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsPlacingOrder(true);
    setPaperError(null);
    try {
      const nextSummary = await placePaperOrder({
        underlyingSymbol: overview.snapshot.underlyingSymbol,
        expiry: overview.snapshot.expiry,
        action: orderAction,
        optionType: orderOptionType,
        strikePrice: Number(orderStrike),
        lots: Number(orderLots),
        requestedPrice: normalizeTradablePrice(orderEntryPrice),
        stopLoss: normalizeTradablePrice(orderStopLossValue),
        trailingStop: true,
        trailDistance: normalizeTradablePrice(orderTrailDistanceValue),
        targetPrice: normalizeTradablePrice(orderTargetValue),
        strategyName: "Dashboard pressure setup",
        reasonText: `${overview.pressure.bullishPressure}% bullish / ${overview.pressure.bearishPressure}% bearish pressure`
      });
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
      targetPrice: formatTradablePrice(order.targetPrice)
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
        trailingStop: true,
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
    await loadMarketSelection(String(formData.get("underlying") ?? ""), String(formData.get("expiry") ?? ""));
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
      const stopLoss = position ? getTrailingStopLoss(position.action, referencePrice, trailDistance) : normalizeTradablePrice(Number(draft.stopLoss));
      setPaperSummary(await updatePaperPositionRisk(positionId, stopLoss, normalizeTradablePrice(Number(draft.targetPrice)), trailDistance));
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
      setReplayStartSnapshotId(snapshot.id);
      setReplayOverview(await fetchReplaySnapshot(snapshot.id, overview));
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : "Unable to load replay snapshot");
      setIsReplayPlaying(false);
    }
  };

  const handleReplaySnapshot = async (snapshotId: string) => {
    const nextIndex = replaySnapshots.findIndex((snapshot) => snapshot.id === snapshotId);
    await loadReplaySnapshotAtIndex(Math.max(0, nextIndex));
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

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label={`${overview.snapshot.underlyingSymbol} Spot`} value={formatPrice(overview.snapshot.spotPrice)} tone="blue" detail={`ATM ${formatStrike(overview.snapshot.atmStrike)}`} />
        <MetricCard label="Bullish Pressure" value={`${overview.pressure.bullishPressure}%`} tone="emerald" detail="PE support pressure" />
        <MetricCard label="Bearish Pressure" value={`${overview.pressure.bearishPressure}%`} tone="red" detail="CE resistance pressure" />
        <MetricCard label="PCR" value={overview.pressure.pcr?.toFixed(2) ?? "--"} tone="blue" detail={`Updated ${snapshotAge} IST`} />
      </section>

      {initialView === "dashboard" ? (
        <DashboardMainPanel
          chainStats={chainStats}
          formatCurrency={formatCurrency}
          formatLarge={formatLarge}
          formatSignedLarge={formatSignedLarge}
          formatStrike={formatStrike}
          getActivityLabel={getActivityLabel}
          getActivityToneClass={getActivityToneClass}
          numberFormatMode={numberFormatMode}
          overview={overview}
          paperSummary={paperSummary}
          pressureSummary={pressureSummary}
          snapshotAge={snapshotAge}
          strikeMovementRows={strikeMovementRows}
          strikeMovementSummary={strikeMovementSummary}
          tradeInterpretation={tradeInterpretation}
        />
      ) : null}

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
          setReplayExpiry={setReplayExpiry}
          setReplayStartSnapshotId={setReplayStartSnapshotId}
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
          handleReplaySnapshot={handleReplaySnapshot}
          replayError={replayError}
          replayChainRange={replayChainRange}
          formatStrike={formatStrike}
          replayChainRows={replayChainRows}
          renderIvDeltaCell={renderIvDeltaCell}
          renderPressureCell={renderPressureCell}
          renderLtpStack={renderLtpStack}
        />
      ) : null}
    </div>
  );
}


function buildStrikeChoices(overview: MarketOverview) {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === overview.snapshot.atmStrike);
  if (atmIndex < 0) {
    return strikes.slice(0, 12);
  }
  return strikes.slice(Math.max(0, atmIndex - 6), atmIndex + 7);
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

function mergeTickerItems(currentItems: MarketTickerItem[], nextItems: MarketTickerItem[]) {
  if (!nextItems.length) {
    return currentItems;
  }

  const seenSymbols = new Set<string>();
  const nextBySymbol = new Map(nextItems.map((item) => [item.symbol, item]));
  const mergedItems = currentItems.map((currentItem) => {
    seenSymbols.add(currentItem.symbol);
    const nextItem = nextBySymbol.get(currentItem.symbol);
    if (!nextItem) {
      return currentItem;
    }

    return mergeTickerItem(currentItem, nextItem);
  });

  for (const nextItem of nextItems) {
    if (!seenSymbols.has(nextItem.symbol)) {
      mergedItems.push(nextItem);
    }
  }

  return mergedItems;
}

function mergeTickerItem(currentItem: MarketTickerItem, nextItem: MarketTickerItem) {
  const spotPrice = isValidTickerNumber(nextItem.spotPrice) ? nextItem.spotPrice : currentItem.spotPrice;
  const previousClose = isValidTickerNumber(nextItem.previousClose) ? nextItem.previousClose : currentItem.previousClose;
  const change = nextItem.change ?? (spotPrice !== undefined && previousClose ? spotPrice - previousClose : currentItem.change);
  const changePercent = nextItem.changePercent ?? (change !== undefined && previousClose ? (change / previousClose) * 100 : currentItem.changePercent);

  return {
    ...nextItem,
    spotPrice,
    previousClose,
    change,
    changePercent
  };
}

function isValidTickerNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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


function buildStrikeMovementRows(overview: MarketOverview) {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === overview.snapshot.atmStrike);
  if (atmIndex < 0) {
    return [];
  }

  const windowStrikes = strikes.slice(Math.max(0, atmIndex - 2), atmIndex + 3);
  const trendSamples = windowStrikes
    .flatMap((strike) => {
      const ce = findOptionTick(overview, strike, "CE");
      const pe = findOptionTick(overview, strike, "PE");
      return [Math.abs(strikeTrendScore(ce)), Math.abs(strikeTrendScore(pe))];
    })
    .filter((score) => score > 0)
    .sort((left, right) => left - right);
  const medianTrend = trendSamples.length ? trendSamples[Math.floor(trendSamples.length / 2)] ?? 8 : 8;
  const trendThreshold = Math.max(4, medianTrend);

  return windowStrikes
    .map((strike, index, windowStrikes) => {
      const ce = findOptionTick(overview, strike, "CE");
      const pe = findOptionTick(overview, strike, "PE");
      const peScore = strikePressureScore(pe);
      const ceScore = strikePressureScore(ce);
      const peActivity = classifyOptionActivity(pe);
      const ceActivity = classifyOptionActivity(ce);
      const buyerMomentumScore = getBuyerMomentumScore(ce) + getBuyerMomentumScore(pe);
      const sellerSafetyScore = getSellerSafetyScore(ce) + getSellerSafetyScore(pe);
      const combinedScore = peScore + ceScore;
      const isThinMarket = combinedScore < 10;
      const netScore = peScore - ceScore;
      const netScorePercent = isThinMarket ? 0 : Math.round((netScore / combinedScore) * 100);
      const scoreBarPercent = isThinMarket ? 0 : Math.min(100, Math.abs(netScorePercent));
      const trendScore = strikeTrendScore(pe) - strikeTrendScore(ce);
      const trendDirection = !isThinMarket && Math.abs(trendScore) >= trendThreshold ? Math.sign(trendScore) : 0;
      const absoluteIndex = strikes.indexOf(strike);
      const distance = absoluteIndex - atmIndex;
      const bias = isThinMarket ? "Balanced" : netScore > 0 ? "Up / support" : netScore < 0 ? "Down / resistance" : "Balanced";
      const trend = trendDirection > 0 ? "Increasing support" : trendDirection < 0 ? "Increasing resistance" : "Flat";

      return {
        strike,
        isAtm: strike === overview.snapshot.atmStrike,
        distanceLabel: distance === 0 ? "ATM" : distance > 0 ? `ATM +${distance}` : `ATM ${distance}`,
        peScore,
        ceScore,
        peActivity,
        ceActivity,
        buyerMomentumScore,
        sellerSafetyScore,
        netScore,
        netScorePercent,
        scoreBarPercent,
        trendScore,
        trendDirection,
        bias,
        trend,
        trendIcon: trendDirection > 0 ? "▲" : trendDirection < 0 ? "▼" : "•",
        toneClass: isThinMarket ? "text-terminal-muted" : netScore > 0 ? "text-terminal-emerald" : netScore < 0 ? "text-terminal-red" : "text-terminal-blue",
        trendToneClass: trendDirection > 0 ? "text-terminal-emerald" : trendDirection < 0 ? "text-terminal-red" : "text-terminal-blue",
        sortOrder: windowStrikes.length - index
      };
    })
    .sort((left, right) => right.strike - left.strike);
}

function buildTradeInterpretation(rows: ReturnType<typeof buildStrikeMovementRows>) {
  const buyerScore = rows.reduce((sum, row) => sum + row.buyerMomentumScore, 0);
  const sellerScore = rows.reduce((sum, row) => sum + row.sellerSafetyScore, 0);
  return {
    buyerScore,
    sellerScore,
    buyerText: formatDirectionalScore(buyerScore, "CE buy", "PE buy"),
    sellerText: formatDirectionalScore(sellerScore, "Sell PE", "Sell CE")
  };
}

function formatDirectionalScore(score: number, positiveLabel: string, negativeLabel: string) {
  if (Math.abs(score) < 8) {
    return "Neutral";
  }
  return `${score > 0 ? positiveLabel : negativeLabel} ${formatSignedLarge(score)}`;
}

function buildStrikeMovementSummary(rows: ReturnType<typeof buildStrikeMovementRows>) {
  if (!rows.length) {
    return {
      bias: "--",
      strongestStrike: "--",
      trend: "--"
    };
  }

  const totalScore = rows.reduce((sum, row) => sum + row.netScore, 0);
  const strongest = [...rows].sort((left, right) => Math.abs(right.netScore) - Math.abs(left.netScore))[0];
  const building = [...rows].filter((row) => row.trendDirection !== 0).sort((left, right) => Math.abs(right.trendScore) - Math.abs(left.trendScore))[0];

  return {
    bias: totalScore > 0 ? "Upside support building" : totalScore < 0 ? "Downside resistance building" : "Balanced near ATM",
    strongestStrike: strongest ? `${formatStrike(strongest.strike)} (${strongest.bias})` : "--",
    trend: building ? `${formatStrike(building.strike)} ${building.trend}` : "Flat"
  };
}

function strikePressureScore(tick?: OverviewTick) {
  if (!tick) {
    return 0;
  }
  const score = toLots(tick.openInterest, tick) + toLots(tick.changeInOpenInterest, tick) * 1.5 + toLots(tick.volume, tick) * 0.5;
  return Math.max(0, Math.round(score));
}

function strikeTrendScore(tick?: OverviewTick) {
  if (!tick) {
    return 0;
  }
  const oiTrend = toLots(tick.changeInOpenInterest, tick);
  const ltpTrend = (tick.lastPriceChangePercent ?? 0) * 2;
  return Math.round(oiTrend + ltpTrend);
}

function classifyOptionActivity(tick?: OverviewTick): OptionActivityKind {
  if (!tick) {
    return "NEUTRAL";
  }
  const oiChange = tick.changeInOpenInterest ?? 0;
  const ltpChange = tick.lastPriceChange ?? 0;
  if (oiChange > 0 && ltpChange > 0) {
    return "LONG_BUILDUP";
  }
  if (oiChange > 0 && ltpChange < 0) {
    return "WRITING";
  }
  if (oiChange < 0 && ltpChange > 0) {
    return "SHORT_COVERING";
  }
  if (oiChange < 0 && ltpChange < 0) {
    return "LONG_UNWINDING";
  }
  return "NEUTRAL";
}

function getActivityLabel(activity: OptionActivityKind) {
  switch (activity) {
    case "LONG_BUILDUP":
      return "Long build";
    case "WRITING":
      return "Writing";
    case "SHORT_COVERING":
      return "Short cover";
    case "LONG_UNWINDING":
      return "Unwind";
    default:
      return "Neutral";
  }
}

function getActivityToneClass(activity: OptionActivityKind) {
  switch (activity) {
    case "LONG_BUILDUP":
      return "text-terminal-blue";
    case "WRITING":
      return "text-terminal-emerald";
    case "SHORT_COVERING":
      return "text-terminal-red";
    case "LONG_UNWINDING":
      return "text-terminal-amber";
    default:
      return "text-terminal-muted";
  }
}

function optionActivityWeight(tick?: OverviewTick) {
  if (!tick) {
    return 0;
  }
  return Math.round(Math.abs(toLots(tick.changeInOpenInterest, tick)) + Math.abs(toLots(tick.volume, tick)) * 0.05 + Math.abs(tick.lastPriceChangePercent ?? 0) * 2);
}

function getBuyerMomentumScore(tick?: OverviewTick) {
  const activity = classifyOptionActivity(tick);
  const weight = optionActivityWeight(tick);
  if (!tick || !weight) {
    return 0;
  }
  const direction = tick.optionType === "CE" ? 1 : -1;
  if (activity === "LONG_BUILDUP") {
    return direction * weight;
  }
  if (activity === "SHORT_COVERING") {
    return direction * Math.round(weight * 0.5);
  }
  if (activity === "WRITING") {
    return -direction * Math.round(weight * 0.6);
  }
  return 0;
}

function getSellerSafetyScore(tick?: OverviewTick) {
  const activity = classifyOptionActivity(tick);
  const weight = optionActivityWeight(tick);
  if (!tick || !weight) {
    return 0;
  }
  const supportDirection = tick.optionType === "PE" ? 1 : -1;
  if (activity === "WRITING") {
    return supportDirection * weight;
  }
  if (activity === "SHORT_COVERING") {
    return -supportDirection * weight;
  }
  if (activity === "LONG_BUILDUP") {
    return -supportDirection * Math.round(weight * 0.5);
  }
  return 0;
}

function buildZoneRows(overview: MarketOverview) {
  const resistance = overview.pressure.resistanceZones.slice(0, 2).map((zone, index) => ({
    label: `R${index + 1}`,
    value: zone.strikePrice,
    status: index === 0 ? "Strong" : "Moderate",
    tone: "red" as const,
    isCurrent: false
  }));
  const support = overview.pressure.supportZones.slice(0, 2).map((zone, index) => ({
    label: `S${index + 1}`,
    value: zone.strikePrice,
    status: index === 0 ? "Strong" : "Key Level",
    tone: "green" as const,
    isCurrent: false
  }));

  return [
    ...resistance,
    {
      label: "CMP",
      value: overview.snapshot.spotPrice,
      status: "Current",
      tone: "blue" as const,
      isCurrent: true
    },
    ...support
  ];
}


function buildPressureSummary(overview: MarketOverview) {
  const pressureGap = overview.pressure.bullishPressure - overview.pressure.bearishPressure;
  const pressureGapAbs = Math.abs(pressureGap);
  const support = overview.pressure.supportZones[0];
  const resistance = overview.pressure.resistanceZones[0];
  const supportDistance = support ? Math.abs(overview.snapshot.spotPrice - support.strikePrice) : undefined;
  const resistanceDistance = resistance ? Math.abs(resistance.strikePrice - overview.snapshot.spotPrice) : undefined;
  const bias = pressureGap >= 6 ? "Bullish" : pressureGap <= -6 ? "Bearish" : "Balanced";
  const pcr = overview.pressure.pcr;
  const pcrTone = pcr === undefined ? "blue" : pcr >= 1.05 ? "green" : pcr <= 0.95 ? "red" : "blue";
  const pcrAligned = (bias === "Bullish" && pcr !== undefined && pcr >= 1.05) || (bias === "Bearish" && pcr !== undefined && pcr <= 0.95);
  const maxPainStrike = overview.pressure.maxPain ?? calculateMaxPainStrike(overview);
  const maxPainDistance = maxPainStrike === undefined ? undefined : maxPainStrike - overview.snapshot.spotPrice;
  const currentActivityScore = calculateCurrentActivityScore(overview);
  const convictionScore = Math.min(100, Math.round(pressureGapAbs * 3 + currentActivityScore));
  const conviction = convictionScore >= 70 ? "High" : convictionScore >= 45 ? "Medium" : "Low";
  const convictionTone = conviction === "High" ? "green" : conviction === "Medium" ? "blue" : "red";
  const setupQuality = Math.min(100, Math.round(pressureGapAbs * 4 + (pcrAligned ? 18 : 0) + (convictionScore * 0.45) + getLevelProximityScore(supportDistance, resistanceDistance)));
  const setupQualityGrade = setupQuality >= 80 ? "A+" : setupQuality >= 70 ? "A" : setupQuality >= 55 ? "B" : setupQuality >= 40 ? "C" : "Wait";
  const setupQualityTone = setupQuality >= 70 ? "green" : setupQuality >= 40 ? "blue" : "red";
  const readiness = setupQuality >= 70 && convictionScore >= 45 && pressureGapAbs >= 6 ? "Actionable" : setupQuality >= 45 || pressureGapAbs >= 4 ? "Watch" : "Wait";
  const strongestSupport = support?.score ?? 0;
  const strongestResistance = resistance?.score ?? 0;
  const strongestLevelText =
    strongestSupport >= strongestResistance && support
      ? `${formatStrike(support.strikePrice)} PE`
      : resistance
        ? `${formatStrike(resistance.strikePrice)} CE`
        : "--";

  return {
    bias,
    biasDetail: `${pressureGapAbs} pt pressure spread`,
    readiness,
    readinessDetail: readiness === "Actionable" ? `Quality ${setupQuality}% with confirmed pressure` : readiness === "Watch" ? `Quality ${setupQuality}% but needs follow-through` : `Quality ${setupQuality}% / no clean edge`,
    pcrText: pcr?.toFixed(2) ?? "--",
    pcrDetail: pcr === undefined ? "PCR unavailable" : pcrAligned ? "PCR confirms bias" : pcr >= 1.05 ? "Put support heavy" : pcr <= 0.95 ? "Call pressure heavy" : "Balanced PCR",
    pcrTone: pcrTone as "blue" | "green" | "red",
    maxPainText: maxPainStrike === undefined ? "--" : formatStrike(maxPainStrike),
    maxPainDistanceText: formatMaxPainDistance(maxPainDistance),
    conviction,
    convictionScore,
    convictionDetail: currentActivityScore >= 35 ? "active tape" : currentActivityScore >= 18 ? "moderate tape" : "thin tape",
    convictionTone: convictionTone as "blue" | "green" | "red",
    setupQualityText: `${setupQualityGrade} / ${setupQuality}%`,
    setupQualityDetail: pcrAligned ? "PCR and pressure aligned" : bias === "Balanced" ? "Waiting for direction" : "Pressure needs PCR support",
    setupQualityTone: setupQualityTone as "blue" | "green" | "red",
    nearestSupportText: support ? formatStrike(support.strikePrice) : "--",
    nearestResistanceText: resistance ? formatStrike(resistance.strikePrice) : "--",
    supportDistanceText: supportDistance === undefined ? "No support zone" : `${formatStrike(supportDistance)} pts below/near`,
    resistanceDistanceText: resistanceDistance === undefined ? "No resistance zone" : `${formatStrike(resistanceDistance)} pts above/near`,
    strongestLevelText
  };
}

function calculateMaxPainStrike(overview: MarketOverview) {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  if (!strikes.length) {
    return undefined;
  }

  let bestStrike = strikes[0];
  let lowestPain = Number.POSITIVE_INFINITY;
  for (const candidate of strikes) {
    const pain = overview.snapshot.ticks.reduce((sum, tick) => {
      const openInterestLots = toLots(tick.openInterest, tick);
      const intrinsic = tick.optionType === "CE" ? Math.max(0, candidate - tick.strikePrice) : Math.max(0, tick.strikePrice - candidate);
      return sum + openInterestLots * intrinsic;
    }, 0);
    if (pain < lowestPain) {
      lowestPain = pain;
      bestStrike = candidate;
    }
  }

  return bestStrike;
}

function calculateCurrentActivityScore(overview: MarketOverview) {
  const totalOiLots = overview.snapshot.ticks.reduce((sum, tick) => sum + toLots(tick.openInterest, tick), 0);
  if (totalOiLots <= 0) {
    return 0;
  }
  const totalChangeLots = overview.snapshot.ticks.reduce((sum, tick) => sum + Math.abs(toLots(tick.changeInOpenInterest, tick)), 0);
  const totalVolumeLots = overview.snapshot.ticks.reduce((sum, tick) => sum + toLots(tick.volume, tick), 0);
  const activityRatio = (totalChangeLots + totalVolumeLots * 0.25) / totalOiLots;
  return Math.min(55, Math.round(activityRatio * 100));
}

function getLevelProximityScore(supportDistance?: number, resistanceDistance?: number) {
  const nearestDistance = Math.min(supportDistance ?? Number.POSITIVE_INFINITY, resistanceDistance ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(nearestDistance)) {
    return 0;
  }
  if (nearestDistance <= 25) {
    return 14;
  }
  if (nearestDistance <= 75) {
    return 10;
  }
  if (nearestDistance <= 150) {
    return 6;
  }
  return 2;
}

function formatMaxPainDistance(distance?: number) {
  if (distance === undefined) {
    return "Distance unavailable";
  }
  if (Math.abs(distance) < 0.01) {
    return "At spot";
  }
  return `${formatPrice(Math.abs(distance))} pts ${distance > 0 ? "above spot" : "below spot"}`;
}

function buildPressureSignals(overview: MarketOverview, chainStats: ReturnType<typeof buildChainStats>) {
  const summary = buildPressureSummary(overview);
  return [
    {
      label: "Direction",
      value: summary.bias,
      detail: summary.biasDetail,
      tone: summary.bias === "Bullish" ? "green" as const : summary.bias === "Bearish" ? "red" as const : "blue" as const
    },
    {
      label: "Strike Magnet",
      value: chainStats.maxOiStrikeText,
      detail: chainStats.maxOiSide,
      tone: "blue" as const
    },
    {
      label: "Support Gap",
      value: summary.nearestSupportText,
      detail: summary.supportDistanceText,
      tone: "green" as const
    },
    {
      label: "Resistance Gap",
      value: summary.nearestResistanceText,
      detail: summary.resistanceDistanceText,
      tone: "red" as const
    }
  ];
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

function formatPrice(value?: number) {
  return value === undefined ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function normalizeTradablePrice(value: number, tickSize = 0.05) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Number((Math.ceil((value - 1e-9) / tickSize) * tickSize).toFixed(2));
}

function formatTradablePrice(value: number, tickSize = 0.05) {
  return normalizeTradablePrice(value, tickSize).toFixed(2);
}

function getDefaultTrailDistanceForEntry(entryPrice: number) {
  return normalizeTradablePrice(entryPrice * 0.18);
}

function getDefaultTargetPrice(action: string, entryPrice: number) {
  return normalizeTradablePrice(action === "BUY" ? entryPrice * 1.35 : Math.max(0, entryPrice * 0.65));
}

function getTrailingStopLoss(action: string, referencePrice: number, trailDistance: number) {
  const rawStopLoss = action === "BUY" ? Math.max(0, referencePrice - trailDistance) : referencePrice + trailDistance;
  return normalizeTradablePrice(rawStopLoss);
}

function formatIstTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const istDate = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const hours = String(istDate.getUTCHours()).padStart(2, "0");
  const minutes = String(istDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(istDate.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatIstShortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const istDate = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const day = String(istDate.getUTCDate()).padStart(2, "0");
  const month = monthNames[istDate.getUTCMonth()] ?? "Jan";
  const hours = String(istDate.getUTCHours()).padStart(2, "0");
  const minutes = String(istDate.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}`;
}

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function formatLarge(value?: number, mode: NumberFormatMode = "indian") {
  if (value === undefined) {
    return "--";
  }
  const absoluteValue = Math.abs(value);
  if (mode === "metric") {
    if (absoluteValue >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(1)}B`;
    }
    if (absoluteValue >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (absoluteValue >= 1000) {
      return `${(value / 1000).toFixed(0)}K`;
    }
    return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }
  if (absoluteValue >= 10000000) {
    return `${(value / 10000000).toFixed(1)}Cr`;
  }
  if (absoluteValue >= 100000) {
    return `${(value / 100000).toFixed(1)}L`;
  }
  if (absoluteValue >= 1000) {
    return `${(value / 1000).toFixed(0)}K`;
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function toLots(value: number | undefined, tick?: Pick<OverviewTick, "lotSize" | "underlyingSymbol">) {
  const lotSize = tick?.lotSize && tick.lotSize > 0 ? tick.lotSize : getLotSizeForUnderlying(tick?.underlyingSymbol);
  return (value ?? 0) / lotSize;
}

function formatQuantityValue(value: number | undefined, tick: OverviewTick | undefined, preferences: DisplayPreferences, signed = false) {
  if (value === undefined) {
    return "--";
  }
  const displayValue = preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value;
  const sign = signed && displayValue >= 0 ? "+" : "";
  return `${sign}${formatLarge(displayValue, preferences.numberFormatMode)}`;
}

function formatOptionalNumber(value: number | undefined, digits: number) {
  if (value === undefined) {
    return "--";
  }
  return value.toFixed(digits);
}

function getLotSizeForUnderlying(underlyingSymbol?: string) {
  const lotSizes: Record<string, number> = {
    NIFTY: 65,
    BANKNIFTY: 30,
    FINNIFTY: 60,
    MIDCPNIFTY: 120,
    NIFTYNXT50: 25,
    SENSEX: 20,
    BANKEX: 30,
    CRUDEOIL: 100,
    NATURALGAS: 1250,
    COPPER: 2500,
    SILVER: 30
  };
  return lotSizes[String(underlyingSymbol ?? "").toUpperCase()] ?? 1;
}

function formatLotsAndQty(lots: number, lotSize: number, quantity: number) {
  return `${lots} x ${lotSize} = ${quantity} qty`;
}

function formatCurrency(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatLtpChange(value?: number, percent?: number) {
  if (value === undefined) {
    return "Chg --";
  }

  const sign = value >= 0 ? "+" : "";
  const percentText = percent === undefined ? "" : ` (${sign}${percent.toFixed(1)}%)`;
  return `${sign}${value.toFixed(2)}${percentText}`;
}

function formatSignedLarge(value?: number, mode: NumberFormatMode = "indian") {
  if (value === undefined) {
    return "--";
  }
  return `${value >= 0 ? "+" : ""}${formatLarge(value, mode)}`;
}

function scoreToPercent(score: number) {
  return Math.max(5, Math.min(100, Math.round(score / 15000)));
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

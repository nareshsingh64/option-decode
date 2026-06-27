"use client";

import { BellRing, Clock3, LineChart, LogOut, Pause, Play, Plus, RefreshCw, ShieldCheck, SkipBack, SkipForward, UserCircle, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

interface OverviewTick {
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

interface PaperSummary {
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

interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
  updatedAt: string;
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

interface AdminOverview {
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

interface ReplaySnapshotSummary {
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

const REFRESH_SECONDS = 30;
const FAST_REFRESH_SECONDS = 5;

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
  }, [initialView, refreshAdminOverview, refreshPaperSummary, refreshReplayTimeline]);

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
      <MarketTicker items={overview.ticker ?? []} />

      <section className="flex flex-wrap items-end justify-between gap-3 rounded border border-terminal-line bg-terminal-panel/80 p-3">
        <div>
          <h2 className="text-base font-semibold">Market Controls</h2>
          <p className="mt-1 text-sm text-terminal-muted">Last refresh {formatIstShortDateTime(lastRefresh)} IST</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1 text-xs uppercase text-terminal-muted">
            Watchlist
            <div className="flex gap-2">
              <input list="watchlist-symbols" value={newWatchSymbol} onChange={(event) => setNewWatchSymbol(event.target.value)} className="h-10 min-w-36 rounded border border-terminal-line bg-terminal-input px-3 text-sm uppercase text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="Search list" />
              <datalist id="watchlist-symbols">
                {(watchlist?.symbols ?? overview.underlyings).map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
              </datalist>
              <button className="grid h-10 w-10 place-items-center rounded border border-terminal-blue bg-terminal-blue text-white transition hover:opacity-90" type="button" onClick={() => {
                const symbol = newWatchSymbol.trim().toUpperCase();
                if (symbol) {
                  void loadMarketSelection(symbol);
                }
              }} aria-label="Open watchlist symbol">
                <Play size={15} />
              </button>
            </div>
          </div>
          <form key={`${overview.selectedUnderlying}-${overview.selectedExpiry}`} className="flex flex-wrap gap-3" onSubmit={handleMarketControlSubmit}>
            <input name="view" type="hidden" value={initialView} />
            <label className="grid gap-1 text-xs uppercase text-terminal-muted">
              Symbol
              <input name="underlying" list="underlying-symbols" defaultValue={overview.selectedUnderlying} className="h-10 min-w-40 rounded border border-terminal-line bg-terminal-input px-3 text-sm uppercase text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="NIFTY, CRUDEOIL..." />
              <datalist id="underlying-symbols">
                {overview.underlyings.map((underlying) => (
                  <option key={underlying} value={underlying}>
                    {underlying}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="grid gap-1 text-xs uppercase text-terminal-muted">
              Expiry
              <select name="expiry" defaultValue={overview.selectedExpiry} className="h-10 min-w-40 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none transition focus:border-terminal-blue">
                {overview.expiries.length ? (
                  overview.expiries.map((expiry) => (
                    <option key={expiry} value={expiry}>
                      {expiry}
                    </option>
                  ))
                ) : (
                  <option value={overview.selectedExpiry}>{overview.selectedExpiry}</option>
                )}
              </select>
            </label>
            <button className="h-10 rounded border border-terminal-blue bg-terminal-blue px-4 text-sm font-semibold text-white transition hover:opacity-90" type="submit">
              Apply
            </button>
          </form>
          <form className="flex gap-2" onSubmit={handleAddWatchSymbol}>
            <input value={newWatchSymbol} onChange={(event) => setNewWatchSymbol(event.target.value)} className="h-10 w-28 rounded border border-terminal-line bg-terminal-input px-3 text-sm uppercase text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="Add" />
            <button className="grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="submit" aria-label="Add watchlist symbol">
              <Plus size={16} />
            </button>
          </form>
          <button className="grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="button" onClick={refreshOverview} aria-label="Refresh market data">
            <RefreshCw size={17} className={isRefreshing ? "animate-spin" : ""} />
          </button>
        </div>
        {watchlistError ? <p className="basis-full text-sm text-terminal-red">{watchlistError}</p> : null}
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label={`${overview.snapshot.underlyingSymbol} Spot`} value={formatPrice(overview.snapshot.spotPrice)} tone="blue" detail={`ATM ${formatStrike(overview.snapshot.atmStrike)}`} />
        <MetricCard label="Bullish Pressure" value={`${overview.pressure.bullishPressure}%`} tone="emerald" detail="PE support pressure" />
        <MetricCard label="Bearish Pressure" value={`${overview.pressure.bearishPressure}%`} tone="red" detail="CE resistance pressure" />
        <MetricCard label="PCR" value={overview.pressure.pcr?.toFixed(2) ?? "--"} tone="blue" detail={`Updated ${snapshotAge} IST`} />
      </section>

      {initialView === "dashboard" ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.45fr)]">
          <Panel title="Trading Command Center">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              <StatusTile icon={<ShieldCheck size={18} />} label="Market Bias" value={pressureSummary.bias} detail={pressureSummary.biasDetail} tone={pressureSummary.bias === "Bullish" ? "green" : pressureSummary.bias === "Bearish" ? "red" : "blue"} />
              <StatusTile icon={<LineChart size={18} />} label="PCR Live" value={pressureSummary.pcrText} detail={pressureSummary.pcrDetail} tone={pressureSummary.pcrTone} />
              <StatusTile icon={<LineChart size={18} />} label="Max Pain" value={pressureSummary.maxPainText} detail={pressureSummary.maxPainDistanceText} tone="blue" />
              <StatusTile icon={<ShieldCheck size={18} />} label="Conviction" value={pressureSummary.conviction} detail={`${pressureSummary.convictionScore}% ${pressureSummary.convictionDetail}`} tone={pressureSummary.convictionTone} />
              <StatusTile icon={<BellRing size={18} />} label="Setup Quality" value={pressureSummary.setupQualityText} detail={pressureSummary.setupQualityDetail} tone={pressureSummary.setupQualityTone} />
              <StatusTile icon={<WalletCards size={18} />} label="Paper P/L" value={formatCurrency((paperSummary?.stats.realizedPnl ?? 0) + (paperSummary?.stats.markToMarketPnl ?? 0))} />
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <SignalCell label="Nearest Support" value={pressureSummary.nearestSupportText} detail={pressureSummary.supportDistanceText} tone="green" />
              <SignalCell label="Nearest Resistance" value={pressureSummary.nearestResistanceText} detail={pressureSummary.resistanceDistanceText} tone="red" />
              <SignalCell label="Trade Readiness" value={pressureSummary.readiness} detail={pressureSummary.readinessDetail} tone="blue" />
            </div>
          </Panel>
          <Panel title="Session Snapshot">
            <div className="grid gap-3 text-sm">
              <SummaryLine label="Snapshot time" value={`${snapshotAge} IST`} />
              <SummaryLine label="Tracked expiry" value={overview.snapshot.expiry} />
              <SummaryLine label="Total CE OI" value={formatLarge(chainStats.totalCeOi, numberFormatMode)} />
              <SummaryLine label="Total PE OI" value={formatLarge(chainStats.totalPeOi, numberFormatMode)} />
              <SummaryLine label="Max OI Strike" value={chainStats.maxOiStrikeText} />
            </div>
          </Panel>
        </section>
      ) : null}

      {initialView === "dashboard" ? (
        <Panel title="ATM +/-2 Strike Movement Score">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.35fr)]">
            <div className="grid gap-2">
              {strikeMovementRows.map((row) => (
                <div key={row.strike} className={`grid gap-2 rounded border px-3 py-2 sm:grid-cols-[4.5rem_minmax(6rem,0.8fr)_minmax(6rem,1fr)_minmax(6rem,1fr)_minmax(7rem,0.8fr)] sm:items-center ${row.isAtm ? "border-terminal-blue/60 bg-terminal-blue/10" : "border-terminal-line bg-white/[0.03]"}`}>
                  <div>
                    <p className="text-xs uppercase text-terminal-muted">{row.distanceLabel}</p>
                    <p className="font-semibold text-terminal-text">{formatStrike(row.strike)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-terminal-muted">Net score</p>
                    <p className={`font-semibold ${row.toneClass}`}>{formatSignedLarge(row.netScore, numberFormatMode)} / {row.netScorePercent}%</p>
                    <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10">
                      <div className={`h-full rounded ${row.netScore > 0 ? "bg-terminal-emerald" : row.netScore < 0 ? "bg-terminal-red" : "bg-terminal-blue"}`} style={{ width: `${row.scoreBarPercent}%` }} />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-terminal-muted">Move bias</p>
                    <p className={`font-semibold ${row.toneClass}`}>{row.bias}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-terminal-muted">Score trend</p>
                    <p className={`font-semibold ${row.trendToneClass}`}>{row.trendIcon} {row.trend}</p>
                  </div>
                  <div className="text-sm text-terminal-muted sm:text-right">
                    <p><span className={getActivityToneClass(row.peActivity)}>{getActivityLabel(row.peActivity)}</span> PE {formatLarge(row.peScore, numberFormatMode)}</p>
                    <p><span className={getActivityToneClass(row.ceActivity)}>{getActivityLabel(row.ceActivity)}</span> CE {formatLarge(row.ceScore, numberFormatMode)}</p>
                    <p className={row.buyerMomentumScore >= 0 ? "text-terminal-emerald" : "text-terminal-red"}>B {formatSignedLarge(row.buyerMomentumScore, numberFormatMode)}</p>
                    <p className={row.sellerSafetyScore >= 0 ? "text-terminal-emerald" : "text-terminal-red"}>S {formatSignedLarge(row.sellerSafetyScore, numberFormatMode)}</p>
                  </div>
                </div>
              ))}
              {!strikeMovementRows.length ? <p className="rounded border border-terminal-line bg-white/[0.03] px-3 py-4 text-center text-sm text-terminal-muted">No ATM strike score available.</p> : null}
            </div>
            <div className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <SignalCell label="Buyer Momentum" value={tradeInterpretation.buyerText} detail={`Score ${formatSignedLarge(tradeInterpretation.buyerScore, numberFormatMode)}`} tone={tradeInterpretation.buyerScore > 8 ? "green" : tradeInterpretation.buyerScore < -8 ? "red" : "blue"} />
                <SignalCell label="Seller Safety" value={tradeInterpretation.sellerText} detail={`Score ${formatSignedLarge(tradeInterpretation.sellerScore, numberFormatMode)}`} tone={tradeInterpretation.sellerScore > 8 ? "green" : tradeInterpretation.sellerScore < -8 ? "red" : "blue"} />
              </div>
              <SummaryLine label="Likely pull" value={strikeMovementSummary.bias} />
              <SummaryLine label="Strongest strike" value={strikeMovementSummary.strongestStrike} />
              <SummaryLine label="Building score" value={strikeMovementSummary.trend} />
              <p className="text-xs leading-5 text-terminal-muted">Positive score means PE support is stronger than CE resistance at that strike. Negative score means CE resistance is stronger. The trend uses OI and LTP change to show whether that pressure is building or fading near ATM.</p>
            </div>
          </div>
        </Panel>
      ) : null}

      {initialView === "pressure" ? (
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.6fr)]">
        <Panel title="Live Market Pressure">
          <div className="grid gap-4 md:grid-cols-2">
            <PressureGauge label="Bullish Pressure" value={overview.pressure.bullishPressure} tone="emerald" detail="PE support dominance" />
            <PressureGauge label="Bearish Pressure" value={overview.pressure.bearishPressure} tone="red" detail="CE resistance dominance" />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <SignalCell label="Bias" value={pressureSummary.bias} detail={pressureSummary.biasDetail} tone="blue" />
            <SignalCell label="Readiness" value={pressureSummary.readiness} detail={pressureSummary.readinessDetail} tone="green" />
            <SignalCell label="PCR Context" value={overview.pressure.pcr?.toFixed(2) ?? "--"} detail={chainStats.breadth} tone="blue" />
          </div>
        </Panel>
        <Panel title="Refresh Status">
          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-terminal-muted">Next refresh</span>
              <span className="font-semibold text-terminal-blue">{secondsToRefresh}s</span>
            </div>
            <div className="h-2 rounded bg-white/10">
              <div className="h-2 rounded bg-terminal-blue transition-all" style={{ width: `${Math.max(0, Math.min(100, ((REFRESH_SECONDS - secondsToRefresh) / REFRESH_SECONDS) * 100))}%` }} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-terminal-muted">Last local update</span>
              <span className="text-right">
                <span className="block font-semibold">{formatIstTime(lastRefresh)}</span>
                <span className={`text-xs font-semibold ${isMarketStreamConnected ? "text-terminal-emerald" : "text-terminal-amber"}`}>{isMarketStreamConnected ? "Live stream" : "Polling fallback"}</span>
              </span>
            </div>
            <SummaryLine label="Data coverage" value={`${overview.snapshot.ticks.length} contracts`} />
            <SummaryLine label="Strongest level" value={pressureSummary.strongestLevelText} />
            {refreshError ? <p className="text-terminal-red">{refreshError}</p> : null}
          </div>
        </Panel>
      </section>
      ) : null}

      {initialView === "pressure" ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <Panel title="Support & Resistance Pressure">
            <div className="space-y-4">
              {overview.pressure.supportZones.slice(0, 2).map((zone) => (
                <PressureBar key={`support-${zone.strikePrice}`} label={`Support ${formatStrike(zone.strikePrice)} PE`} value={scoreToPercent(zone.score)} tone="emerald" />
              ))}
              {overview.pressure.resistanceZones.slice(0, 2).map((zone) => (
                <PressureBar key={`resistance-${zone.strikePrice}`} label={`Resistance ${formatStrike(zone.strikePrice)} CE`} value={scoreToPercent(zone.score)} tone="blue" />
              ))}
            </div>
          </Panel>
          <TerminalPanel title="Support & Resistance Zones">
            <div className="grid gap-1">
              {zoneRows.map((row) => (
                <div key={row.label} className={`grid grid-cols-[3rem_minmax(6rem,1fr)_minmax(5rem,0.7fr)] items-center rounded px-2 py-2 ${row.isCurrent ? "bg-terminal-blue/15" : ""}`}>
                  <span className={`text-sm font-semibold ${row.tone === "green" ? "text-terminal-emerald" : row.tone === "red" ? "text-terminal-red" : "text-terminal-blue"}`}>{row.label}</span>
                  <span className={`text-center text-sm font-semibold ${row.isCurrent ? "text-terminal-blue" : "text-terminal-text"}`}>{formatStrike(row.value)}</span>
                  <span className={`text-right text-sm ${row.isCurrent ? "text-terminal-blue" : "text-terminal-muted"}`}>{row.status}</span>
                </div>
              ))}
            </div>
          </TerminalPanel>
          <Panel title="Pressure Signal Board">
            <div className="grid gap-3">
              {buildPressureSignals(overview, chainStats).map((signal) => (
                <SignalCell key={signal.label} label={signal.label} value={signal.value} detail={signal.detail} tone={signal.tone} />
              ))}
            </div>
          </Panel>
        </section>
      ) : null}

      {initialView === "dashboard" || initialView === "alerts" ? (
        <Panel title={initialView === "alerts" ? "Alert Center" : "Live Alerts"}>
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {initialView === "alerts" ? (
                <div className="flex flex-wrap gap-2">
                  {(["all", "critical", "warning", "info", "dismissed"] as const).map((filter) => (
                    <button key={filter} className={`min-h-9 rounded border px-3 py-1.5 text-xs font-semibold uppercase transition ${alertFilter === filter ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line text-terminal-muted hover:border-terminal-blue hover:text-terminal-text"}`} type="button" onClick={() => setAlertFilter(filter)}>
                      {filter}
                    </button>
                  ))}
                </div>
              ) : (
                <a className="flex min-h-9 items-center rounded border border-terminal-line px-3 py-1.5 text-xs font-semibold uppercase text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-blue" href={alertCenterHref}>
                  Open Alert Center
                </a>
              )}
              <div className="text-sm text-terminal-muted">
                <span className="font-semibold text-terminal-text">{activeAlertCount}</span> active / {overview.alerts.length} total
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {displayedAlerts.map((alert) => {
                const dismissed = dismissedAlertIds.includes(alert.id);

                return (
                  <div key={alert.id} className={`rounded border p-3 ${alert.severity === "critical" ? "border-terminal-red/70 bg-terminal-red/10" : alert.severity === "warning" ? "border-terminal-amber/70 bg-terminal-amber/10" : "border-terminal-blue/50 bg-terminal-blue/10"} ${dismissed ? "opacity-60" : ""}`}>
                    <div className="flex items-start gap-2">
                      <BellRing size={16} className={alert.severity === "critical" ? "mt-0.5 shrink-0 text-terminal-red" : alert.severity === "warning" ? "mt-0.5 shrink-0 text-terminal-amber" : "mt-0.5 shrink-0 text-terminal-blue"} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold">{alert.title}</p>
                          <span className="rounded border border-white/10 px-1.5 py-0.5 text-[0.65rem] uppercase text-terminal-muted">{alert.severity}</span>
                          {dismissed ? <span className="rounded border border-terminal-line px-1.5 py-0.5 text-[0.65rem] uppercase text-terminal-muted">dismissed</span> : null}
                        </div>
                        <p className="mt-1 text-sm text-terminal-muted">{alert.message}</p>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <p className="text-xs text-terminal-muted">{formatIstTime(alert.createdAt)} IST</p>
                          <button className="min-h-8 rounded border border-terminal-line px-2 py-1 text-xs text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="button" onClick={() => (dismissed ? handleRestoreAlert(alert.id) : handleDismissAlert(alert.id))}>
                            {dismissed ? "Restore" : "Dismiss"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {!displayedAlerts.length ? <p className="rounded border border-terminal-line bg-white/[0.03] px-3 py-4 text-center text-sm text-terminal-muted md:col-span-2 xl:col-span-3">{initialView === "alerts" ? "No alerts in this filter." : "No active alerts."}</p> : null}
            </div>
          </div>
        </Panel>
      ) : null}

      {initialView === "account" ? (
        <Panel title="Account">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.45fr)]">
            <div className="grid gap-4 rounded border border-terminal-line bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded border border-terminal-blue/60 bg-terminal-blue/15 text-terminal-blue">
                    <UserCircle size={22} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase text-terminal-muted">Current User</p>
                    <h2 className="mt-1 text-lg font-semibold text-terminal-text">{authUser?.displayName || authUser?.email || "Not signed in"}</h2>
                  </div>
                </div>
                {authUser ? (
                  <button className="flex min-h-9 items-center gap-2 rounded border border-terminal-line px-3 py-1.5 text-sm text-terminal-muted transition hover:border-terminal-red hover:text-terminal-red disabled:cursor-not-allowed disabled:opacity-50" disabled={isAuthSubmitting} type="button" onClick={handleLogout}>
                    <LogOut size={15} />
                    Sign out
                  </button>
                ) : null}
              </div>

              {authUser ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <SignalCell label="Role" value={authUser.role} detail={authUser.emailVerified ? "Email verified" : "Email pending"} tone="blue" />
                  <SignalCell label="Plan" value={authUser.plan?.name ?? "No plan"} detail={authUser.plan?.status ?? "Inactive"} tone="green" />
                  <SignalCell label="Replay Limit" value={authUser.plan?.replayLimit === undefined ? "Unlimited" : String(authUser.plan.replayLimit)} detail={authUser.plan?.realtime ? "Realtime enabled" : "Delayed tier"} tone="blue" />
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-3">
                  <StatusTile icon={<ShieldCheck size={18} />} label="Trial Access" value="14 days" />
                  <StatusTile icon={<LineChart size={18} />} label="Analytics" value="Starter" />
                  <StatusTile icon={<WalletCards size={18} />} label="Paper Trades" value="Ready" />
                </div>
              )}

              {authUser && !authUser.emailVerified ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-terminal-amber/50 bg-terminal-amber/10 px-3 py-3">
                  <div>
                    <p className="text-sm font-semibold text-terminal-amber">Email verification pending</p>
                    <p className="mt-1 text-xs text-terminal-muted">Verify your email to keep account recovery and security controls active.</p>
                  </div>
                  <button className="h-9 rounded border border-terminal-amber/70 px-3 text-xs font-semibold text-terminal-amber transition hover:bg-terminal-amber hover:text-terminal-bg disabled:cursor-not-allowed disabled:opacity-50" disabled={isAuthSubmitting} type="button" onClick={handleResendVerification}>
                    Resend Verification
                  </button>
                </div>
              ) : null}

              {authUser ? (
                <div className="grid gap-2 text-sm">
                  <SummaryLine label="Email" value={authUser.email} />
                  <SummaryLine label="Last login" value={authUser.lastLoginAt ? formatIstShortDateTime(authUser.lastLoginAt) : "--"} />
                  <SummaryLine label="Plan code" value={authUser.plan?.code ?? "--"} />
                  <SummaryLine label="Premium alerts" value={authUser.plan?.premiumAlerts ? "Enabled" : "Not enabled"} />
                  <SummaryLine label="Realtime market feed" value={authUser.plan?.realtime ? "Enabled" : "Plan limited"} />
                </div>
              ) : (
                <p className="text-sm leading-6 text-terminal-muted">Create a trial account to start saving preferences and prepare the app for subscription-based access to replay, alerts, and live modules.</p>
              )}
            </div>

            <form className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-4" onSubmit={handleAuthSubmit}>
              <div className="flex rounded border border-terminal-line bg-terminal-input p-1 text-sm">
                <button className={`min-h-9 flex-1 rounded px-3 font-semibold transition ${authMode === "login" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => {
                  setAuthMode("login");
                  setAuthError(null);
                  setAuthMessage(null);
                }}>
                  Login
                </button>
                <button className={`min-h-9 flex-1 rounded px-3 font-semibold transition ${authMode === "register" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => {
                  setAuthMode("register");
                  setAuthError(null);
                  setAuthMessage(null);
                }}>
                  Register
                </button>
              </div>
              {authMode === "register" ? (
                <label className="grid gap-1 text-xs uppercase text-terminal-muted">
                  Name
                  <input value={authDisplayName} onChange={(event) => setAuthDisplayName(event.target.value)} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="Your name" />
                </label>
              ) : null}
              <label className="grid gap-1 text-xs uppercase text-terminal-muted">
                Email
                <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none transition focus:border-terminal-blue" placeholder="name@example.com" type="email" />
              </label>
              <label className="grid gap-1 text-xs uppercase text-terminal-muted">
                Password
                <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm text-terminal-text outline-none transition focus:border-terminal-blue" minLength={8} placeholder="Minimum 8 characters" type="password" />
              </label>
              <button className="h-10 rounded border border-terminal-emerald bg-terminal-emerald px-4 text-sm font-semibold text-terminal-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" disabled={isAuthSubmitting} type="submit">
                {isAuthSubmitting ? "Working..." : authMode === "register" ? "Create Trial Account" : "Login"}
              </button>
              {authError ? <p className="text-sm text-terminal-red">{authError}</p> : null}
              {authMessage ? <p className="text-sm text-terminal-emerald">{authMessage}</p> : null}
            </form>
          </div>
        </Panel>
      ) : null}

      {initialView === "admin" ? (
        <Panel title="Admin Console">
          <div className="grid gap-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase text-terminal-muted">Protected Admin Area</p>
                <h2 className="mt-1 text-lg font-semibold text-terminal-text">Users, plans, and platform status</h2>
              </div>
              <button className="h-9 rounded border border-terminal-blue/70 bg-terminal-blue/10 px-3 text-xs font-semibold text-terminal-blue transition hover:bg-terminal-blue hover:text-white" type="button" onClick={refreshAdminOverview}>
                Refresh Admin Data
              </button>
            </div>

            {adminError ? <p className="rounded border border-terminal-red/50 bg-terminal-red/10 px-3 py-2 text-terminal-red">{adminError}</p> : null}

            <div className="grid gap-3 md:grid-cols-5">
              <StatusTile icon={<UserCircle size={18} />} label="Users" value={String(adminOverview?.metrics.users ?? 0)} />
              <StatusTile icon={<ShieldCheck size={18} />} label="Admins" value={String(adminOverview?.metrics.admins ?? 0)} />
              <StatusTile icon={<WalletCards size={18} />} label="Subscriptions" value={String(adminOverview?.metrics.activeSubscriptions ?? 0)} />
              <StatusTile icon={<LineChart size={18} />} label="Snapshots Today" value={String(adminOverview?.metrics.snapshotsToday ?? 0)} />
              <StatusTile icon={<Play size={18} />} label="Open Paper" value={String(adminOverview?.metrics.openPaperPositions ?? 0)} />
            </div>

            <div className="rounded border border-terminal-line bg-white/[0.03]">
              <PaperSectionHeader title="Users" meta={`${adminOverview?.users.length ?? 0} latest`} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1120px] border-collapse text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                    <tr>
                      <th className="px-3 py-3 text-left">User</th>
                      <th className="px-3 py-3 text-left">Plan</th>
                      <th className="px-3 py-3 text-left">Role</th>
                      <th className="px-3 py-3 text-right">Verified</th>
                      <th className="px-3 py-3 text-right">Status</th>
                      <th className="px-3 py-3 text-right">Last Login</th>
                      <th className="px-3 py-3 text-right">Created</th>
                      <th className="px-3 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(adminOverview?.users ?? []).map((user) => (
                      <tr key={user.id} className="border-t border-terminal-line/80">
                        <td className="px-3 py-3">
                          <div className="font-semibold text-terminal-text">{user.displayName || user.email}</div>
                          <div className="text-xs text-terminal-muted">{user.email}</div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-semibold text-terminal-text">{user.plan?.name ?? "--"}</div>
                          <div className="text-xs text-terminal-muted">{user.plan?.status ?? "No subscription"}</div>
                        </td>
                        <td className="px-3 py-3">
                          <select value={user.role} onChange={(event) => handleUpdateAdminUserRole(user.id, event.target.value as AdminOverview["users"][number]["role"])} className="h-9 rounded border border-terminal-line bg-terminal-input px-2 text-sm text-terminal-text outline-none focus:border-terminal-blue" disabled={updatingAdminUserId === user.id}>
                            <option value="ADMIN">ADMIN</option>
                            <option value="SUBSCRIBER">SUBSCRIBER</option>
                            <option value="TRIAL">TRIAL</option>
                            <option value="FREE">FREE</option>
                          </select>
                        </td>
                        <td className={`px-3 py-3 text-right font-semibold ${user.emailVerified ? "text-terminal-emerald" : "text-terminal-amber"}`}>{user.emailVerified ? "Yes" : "No"}</td>
                        <td className={`px-3 py-3 text-right font-semibold ${user.disabled ? "text-terminal-red" : "text-terminal-emerald"}`}>{user.disabled ? "Disabled" : "Active"}</td>
                        <td className="px-3 py-3 text-right text-xs text-terminal-muted">{user.lastLoginAt ? formatIstShortDateTime(user.lastLoginAt) : "--"}</td>
                        <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(user.createdAt)}</td>
                        <td className="px-3 py-3 text-right">
                          <button className={`h-9 rounded border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${user.disabled ? "border-terminal-emerald/70 bg-terminal-emerald/10 text-terminal-emerald hover:bg-terminal-emerald hover:text-terminal-bg" : "border-terminal-red/70 bg-terminal-red/10 text-terminal-red hover:bg-terminal-red hover:text-white"}`} disabled={updatingAdminUserId === user.id} type="button" onClick={() => handleUpdateAdminUserDisabled(user.id, !user.disabled)}>
                            {updatingAdminUserId === user.id ? "Saving..." : user.disabled ? "Enable" : "Disable"}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {adminOverview && !adminOverview.users.length ? (
                      <tr><td colSpan={8} className="px-3 py-6 text-center text-terminal-muted">No users found.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded border border-terminal-line bg-white/[0.03]">
              <PaperSectionHeader title="Plans" meta={`${adminOverview?.plans.length ?? 0} tiers`} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[840px] border-collapse text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                    <tr>
                      <th className="px-3 py-3 text-left">Plan</th>
                      <th className="px-3 py-3 text-right">Monthly</th>
                      <th className="px-3 py-3 text-right">Replay</th>
                      <th className="px-3 py-3 text-right">Realtime</th>
                      <th className="px-3 py-3 text-right">Premium Alerts</th>
                      <th className="px-3 py-3 text-right">Subscriptions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(adminOverview?.plans ?? []).map((plan) => (
                      <tr key={plan.id} className="border-t border-terminal-line/80">
                        <td className="px-3 py-3">
                          <div className="font-semibold text-terminal-text">{plan.name}</div>
                          <div className="text-xs text-terminal-muted">{plan.code}</div>
                        </td>
                        <td className="px-3 py-3 text-right">{formatCurrency(plan.monthlyPrice ?? 0)}</td>
                        <td className="px-3 py-3 text-right">{plan.replayLimit === undefined ? "Unlimited" : plan.replayLimit}</td>
                        <td className={`px-3 py-3 text-right font-semibold ${plan.realtime ? "text-terminal-emerald" : "text-terminal-muted"}`}>{plan.realtime ? "Yes" : "No"}</td>
                        <td className={`px-3 py-3 text-right font-semibold ${plan.premiumAlerts ? "text-terminal-emerald" : "text-terminal-muted"}`}>{plan.premiumAlerts ? "Yes" : "No"}</td>
                        <td className="px-3 py-3 text-right">{plan.subscriberCount}</td>
                      </tr>
                    ))}
                    {adminOverview && !adminOverview.plans.length ? (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-terminal-muted">No plans found.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      {initialView === "settings" ? (
        <Panel title="Settings">
          <div className="grid gap-4 md:grid-cols-2">
            <SettingsSwitch
              label="Number Format"
              leftLabel="L"
              rightLabel="M"
              checked={numberFormatMode === "metric"}
              onChange={(checked) => setNumberFormatMode(checked ? "metric" : "indian")}
              detail={numberFormatMode === "metric" ? "Uses K, M, B scaling" : "Uses K, L, Cr scaling"}
            />
            <SettingsSwitch
              label="OI / Volume Values"
              leftLabel="Contracts"
              rightLabel="Numbers"
              checked={quantityDisplayMode === "numbers"}
              onChange={(checked) => setQuantityDisplayMode(checked ? "numbers" : "lots")}
              detail={quantityDisplayMode === "numbers" ? "Shows raw exchange quantity" : "Shows contract-normalized values"}
            />
            <SettingsSwitch
              label="Visible Strikes"
              leftLabel="VIX"
              rightLabel="ATM"
              checked={visibleStrikeMode === "atm"}
              onChange={(checked) => setVisibleStrikeMode(checked ? "atm" : "vix")}
              detail={visibleStrikeMode === "atm" ? "Shows ATM +/- 6 strikes" : "Shows India VIX expected range"}
            />
          </div>
        </Panel>
      ) : null}

      {initialView === "option-chain" ? (
      <section className="grid min-w-0 gap-3 2xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 rounded border border-terminal-line bg-terminal-panel/80">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-terminal-line p-4">
            <div>
              <h2 className="text-base font-semibold">Live Option Chain Intelligence</h2>
              <p className="mt-1 text-sm text-terminal-muted">
                {overview.snapshot.underlyingSymbol} expiry {overview.snapshot.expiry}, ATM {formatStrike(overview.snapshot.atmStrike)}
              </p>
              <p className="mt-1 text-xs text-terminal-muted">
                VIX range {formatStrike(chainRange.lower)}-{formatStrike(chainRange.upper)} using India VIX {chainRange.vix.toFixed(2)}%
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-terminal-muted">
              <label className="flex h-9 items-center gap-2 rounded border border-terminal-line bg-terminal-input px-3">
                <span>VIX</span>
                <input className="accent-terminal-blue" checked={visibleStrikeMode === "atm"} onChange={(event) => setVisibleStrikeMode(event.target.checked ? "atm" : "vix")} type="checkbox" />
                <span>ATM +/-</span>
              </label>
              <Clock3 size={15} />
              <span>{isMarketStreamConnected ? "SSE live" : "Auto-refresh 30s"}</span>
            </div>
          </div>
          <div className="grid gap-3 border-b border-terminal-line p-3 md:grid-cols-4">
            <SignalCell label="CE Open Interest" value={formatLarge(chainStats.totalCeOi, numberFormatMode)} detail={formatSignedLarge(chainStats.totalCeChange, numberFormatMode)} tone="red" />
            <SignalCell label="PE Open Interest" value={formatLarge(chainStats.totalPeOi, numberFormatMode)} detail={formatSignedLarge(chainStats.totalPeChange, numberFormatMode)} tone="green" />
            <SignalCell label="OI Breadth" value={chainStats.breadth} detail={`PCR ${overview.pressure.pcr?.toFixed(2) ?? "--"}`} tone="blue" />
            <SignalCell label="Max OI Strike" value={chainStats.maxOiStrikeText} detail={chainStats.maxOiSide} tone="blue" />
          </div>
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-xs xl:text-sm">
              <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                <tr>
                  <th className="px-2 py-3 text-left">CE IV/Δ</th>
                  <th className="px-2 py-3 text-left">CE OI</th>
                  <th className="px-2 py-3 text-left">CE Chg</th>
                  <th className="px-2 py-3 text-left">CE Vol</th>
                  <th className="px-2 py-3 text-left">CE LTP</th>
                  <th className="px-2 py-3 text-center">Strike</th>
                  <th className="px-2 py-3 text-right">PE LTP</th>
                  <th className="px-2 py-3 text-right">PE Vol</th>
                  <th className="px-2 py-3 text-right">PE Chg</th>
                  <th className="px-2 py-3 text-right">PE OI</th>
                  <th className="px-2 py-3 text-right">PE IV/Δ</th>
                </tr>
              </thead>
              <tbody>
                {chainRows.map((row) => (
                  <tr key={row.strike} className={row.strike === overview.snapshot.atmStrike ? "border-y border-terminal-blue/70 bg-terminal-blue/10" : "border-t border-terminal-line/80"}>
                    <td className="px-2 py-3">{renderIvDeltaCell(row.ceIv, row.ceDelta, "left")}</td>
                    <td className="px-2 py-3">{renderPressureCell(row.ceOi, row.ceOiRank, row.ceOiPercent, "CE")}</td>
                    <td className="px-2 py-3">{renderPressureCell(row.ceChg, row.ceChgRank, row.ceChgPercent, "CE")}</td>
                    <td className="px-2 py-3">{renderPressureCell(row.ceVol, row.ceVolRank, row.ceVolPercent, "CE")}</td>
                    <td className="px-2 py-3">{renderLtpStack(row.ceLtp, row.ceLtpChange, row.ceLtpChangePercent, "left", row.ceActivity)}</td>
                    <td className="px-2 py-3 text-center font-semibold text-terminal-text">{row.strike}</td>
                    <td className="px-2 py-3 text-right">{renderLtpStack(row.peLtp, row.peLtpChange, row.peLtpChangePercent, "right", row.peActivity)}</td>
                    <td className="px-2 py-3">{renderPressureCell(row.peVol, row.peVolRank, row.peVolPercent, "PE")}</td>
                    <td className="px-2 py-3">{renderPressureCell(row.peChg, row.peChgRank, row.peChgPercent, "PE")}</td>
                    <td className="px-2 py-3">{renderPressureCell(row.peOi, row.peOiRank, row.peOiPercent, "PE")}</td>
                    <td className="px-2 py-3">{renderIvDeltaCell(row.peIv, row.peDelta, "right")}</td>
                  </tr>
                ))}
                {!chainRows.length ? (
                  <tr>
                    <td colSpan={11} className="px-2 py-8 text-center text-terminal-muted">
                      No strikes available inside the current VIX range.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid gap-3">
          <TerminalPanel title={`${overview.snapshot.underlyingSymbol} Option Chain - Top Strikes`}>
            <div className="grid gap-1">
              {topStrikeRows.map((row) => (
                <div key={`${row.strike}-${row.optionType}`} className="grid grid-cols-[minmax(5rem,1fr)_minmax(6rem,1fr)_minmax(4rem,0.5fr)] items-center border-b border-terminal-line/80 py-2 last:border-b-0">
                  <span className="text-sm font-medium text-terminal-muted">{formatLarge(row.openInterest, numberFormatMode)} OI</span>
                  <span className="text-center text-sm font-semibold text-terminal-text">
                    {formatStrike(row.strike)} {row.optionType}
                  </span>
                  <span className={`text-right text-sm font-semibold ${row.changePercent >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>
                    {row.changePercent >= 0 ? "▲" : "▼"} {Math.abs(row.changePercent).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </TerminalPanel>
          <TerminalPanel title="Support & Resistance Zones">
            <div className="grid gap-1">
              {zoneRows.map((row) => (
                <div key={row.label} className={`grid grid-cols-[3rem_minmax(6rem,1fr)_minmax(5rem,0.7fr)] items-center rounded px-2 py-2 ${row.isCurrent ? "bg-terminal-blue/15" : ""}`}>
                  <span className={`text-sm font-semibold ${row.tone === "green" ? "text-terminal-emerald" : row.tone === "red" ? "text-terminal-red" : "text-terminal-blue"}`}>{row.label}</span>
                  <span className={`text-center text-sm font-semibold ${row.isCurrent ? "text-terminal-blue" : "text-terminal-text"}`}>{formatStrike(row.value)}</span>
                  <span className={`text-right text-sm ${row.isCurrent ? "text-terminal-blue" : "text-terminal-muted"}`}>{row.status}</span>
                </div>
              ))}
            </div>
          </TerminalPanel>
        </div>
      </section>
      ) : null}

      {initialView === "paper" ? (
          <Panel title="Paper Trading">
            <div className="grid gap-4 text-sm">
              <div className="grid gap-3 md:grid-cols-4">
                <StatusTile icon={<Play size={18} />} label="Replay" value="Ready" />
                <StatusTile icon={<WalletCards size={18} />} label="Open Paper" value={String(paperSummary?.stats.openPositions ?? 0)} />
                <StatusTile icon={<LineChart size={18} />} label="MTM P/L" value={formatCurrency(paperSummary?.stats.markToMarketPnl ?? 0)} />
                <StatusTile icon={<ShieldCheck size={18} />} label="Risk Mode" value="Strict" />
              </div>

              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.4fr)]">
                <div className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-3 md:grid-cols-3">
                  <SignalCell label="Entry Trigger" value={formatPrice(orderEntryPrice)} detail={`${orderAction === "BUY" ? "BUY fills when LTP <= entry" : "SELL fills when LTP >= entry"} / LTP ${formatPrice(marketEntryPrice)}`} tone="blue" />
                  <SignalCell label="Risk / Reward" value={riskReward ? `1:${riskReward.toFixed(1)}` : "--"} detail={`${formatCurrency(estimatedRisk)} trail risk`} tone="green" />
                  <SignalCell label="Target Payoff" value={formatCurrency(estimatedReward)} detail={`${formatPrice(orderTargetValue)} target`} tone="green" />
                </div>
                <div className="grid gap-2 rounded border border-terminal-line bg-white/[0.03] p-3">
                  <SummaryLine label="Filled orders" value={String(paperSummary?.stats.filledOrders ?? 0)} />
                  <SummaryLine label="Pending orders" value={String(paperSummary?.stats.pendingOrders ?? 0)} />
                  <SummaryLine label="Realized P/L" value={formatCurrency(paperSummary?.stats.realizedPnl ?? 0)} />
                </div>
              </div>

              <form className="rounded border border-terminal-line bg-white/[0.03]" onSubmit={handlePaperOrder}>
                <PaperSectionHeader title="Paper Order Ticket" meta={`${overview.snapshot.underlyingSymbol} ${overview.snapshot.expiry}`} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1280px] border-collapse text-sm">
                    <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                      <tr>
                        <th className="px-3 py-3 text-left">Symbol</th>
                        <th className="px-3 py-3 text-left">Order</th>
                        <th className="px-3 py-3 text-left">Type</th>
                        <th className="px-3 py-3 text-left">Strike</th>
                        <th className="px-3 py-3 text-right">LTP</th>
                        <th className="px-3 py-3 text-right">Entry</th>
                        <th className="px-3 py-3 text-right">SL</th>
                        <th className="px-3 py-3 text-right">Target</th>
                        <th className="px-3 py-3 text-right">Contracts</th>
                        <th className="px-3 py-3 text-right">Qty</th>
                        <th className="px-3 py-3 text-right">Risk</th>
                        <th className="px-3 py-3 text-right">Reward</th>
                        <th className="px-3 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-terminal-line/80">
                        <td className="px-3 py-3">
                          <div className="font-semibold">{overview.snapshot.underlyingSymbol}</div>
                          <div className="text-xs text-terminal-muted">{overview.snapshot.expiry}</div>
                        </td>
                        <td className="px-3 py-3">
                          <select value={orderAction} onChange={(event) => {
                            setOrderAction(event.target.value as "BUY" | "SELL");
                            setIsOrderStopLossEdited(false);
                            setIsOrderTargetEdited(false);
                          }} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-sm font-semibold text-terminal-text outline-none focus:border-terminal-blue">
                            <option value="BUY">BUY</option>
                            <option value="SELL">SELL</option>
                          </select>
                        </td>
                        <td className="px-3 py-3">
                          <select value={orderOptionType} onChange={(event) => setOrderOptionType(event.target.value as "CE" | "PE")} className="h-9 w-20 rounded border border-terminal-line bg-terminal-input px-2 text-sm text-terminal-text outline-none focus:border-terminal-blue">
                            <option value="CE">CE</option>
                            <option value="PE">PE</option>
                          </select>
                        </td>
                        <td className="px-3 py-3">
                          <select value={orderStrike} onChange={(event) => setOrderStrike(event.target.value)} className="h-9 w-28 rounded border border-terminal-line bg-terminal-input px-2 text-sm text-terminal-text outline-none focus:border-terminal-blue">
                            {strikeChoices.map((strike) => (
                              <option key={strike} value={strike}>{formatStrike(strike)}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="font-semibold text-terminal-text">{orderTick?.lastPrice !== undefined ? formatPrice(orderTick.lastPrice) : "--"}</div>
                          <div className={`text-xs ${orderTick?.lastPriceChange === undefined ? "text-terminal-muted" : orderTick.lastPriceChange >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>{formatLtpChange(orderTick?.lastPriceChange, orderTick?.lastPriceChangePercent)}</div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <input value={orderEntry} onBlur={() => setOrderEntry((value) => (value ? formatTradablePrice(Number(value)) : value))} onChange={(event) => setOrderEntry(event.target.value)} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-text outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                        </td>
                        <td className="px-3 py-3 text-right">
                          <input value={orderStopLoss} onChange={(event) => {
                            setIsOrderStopLossEdited(true);
                            setOrderStopLoss(event.target.value);
                          }} onBlur={() => setOrderStopLoss((value) => (value ? formatTradablePrice(Number(value)) : value))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-red outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                          <div className="mt-1 text-xs text-terminal-muted">Trail {formatPrice(orderTrailDistanceValue)}</div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <input value={orderTarget} onChange={(event) => {
                            setIsOrderTargetEdited(true);
                            setOrderTarget(event.target.value);
                          }} onBlur={() => setOrderTarget((value) => (value ? formatTradablePrice(Number(value)) : value))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-emerald outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                        </td>
                        <td className="px-3 py-3 text-right">
                          <input value={orderLots} onChange={(event) => setOrderLots(event.target.value)} className="h-9 w-20 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm text-terminal-text outline-none focus:border-terminal-blue" min="1" step="1" type="number" />
                        </td>
                        <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(Number(orderLots || 0), orderLotSize, orderQuantity)}</td>
                        <td className="px-3 py-3 text-right text-terminal-red">{formatCurrency(estimatedRisk)}</td>
                        <td className="px-3 py-3 text-right text-terminal-emerald">{formatCurrency(estimatedReward)}</td>
                        <td className="px-3 py-3 text-right">
                          <button className={`h-9 min-w-36 rounded border px-3 text-sm font-semibold transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${orderAction === "BUY" ? "border-terminal-emerald bg-terminal-emerald text-terminal-bg" : "border-terminal-red bg-terminal-red text-white"}`} disabled={isPlacingOrder || orderEntryPrice <= 0} type="submit">
                            {isPlacingOrder ? "Placing..." : `${orderAction === "BUY" ? "Buy" : "Sell"} Trigger`}
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {paperError ? <p className="border-t border-terminal-line px-3 py-2 text-xs text-terminal-red">{paperError}</p> : null}
              </form>

              <div className="rounded border border-terminal-line bg-white/[0.03]">
                <PaperSectionHeader title="Pending Orders" meta={`${pendingPaperOrders.length} waiting`} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1340px] border-collapse text-sm">
                    <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                      <tr>
                        <th className="px-3 py-3 text-left">Order</th>
                        <th className="px-3 py-3 text-right">Contracts</th>
                        <th className="px-3 py-3 text-right">Qty</th>
                        <th className="px-3 py-3 text-right">Entry</th>
                        <th className="px-3 py-3 text-right">Current LTP</th>
                        <th className="px-3 py-3 text-right">Trigger</th>
                        <th className="px-3 py-3 text-right">SL</th>
                        <th className="px-3 py-3 text-right">Target</th>
                        <th className="px-3 py-3 text-right">Placed</th>
                        <th className="px-3 py-3 text-right">Status</th>
                        <th className="px-3 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingPaperOrders.slice(0, 8).map((order) => {
                        const draft = pendingOrderDrafts[order.id] ?? {
                          lots: String(order.lots),
                          requestedPrice: formatTradablePrice(order.requestedPrice),
                          stopLoss: formatTradablePrice(order.stopLoss),
                          targetPrice: formatTradablePrice(order.targetPrice)
                        };
                        const draftLots = Math.max(1, Math.floor(Number(draft.lots || order.lots)));
                        const draftEntry = normalizeTradablePrice(Number(draft.requestedPrice || order.requestedPrice));
                        const draftStopLoss = normalizeTradablePrice(Number(draft.stopLoss || order.stopLoss));
                        const draftTrailDistance = normalizeTradablePrice(Math.abs(draftEntry - draftStopLoss));
                        const draftTargetPrice = normalizeTradablePrice(Number(draft.targetPrice || order.targetPrice));
                        const draftQuantity = draftLots * order.lotSize;
                        const currentPrice = order.currentPrice;
                        const willFill = currentPrice !== undefined ? (order.action === "BUY" ? currentPrice <= draftEntry : currentPrice >= draftEntry) : false;

                        return (
                          <tr key={order.id} className="border-t border-terminal-line/80">
                            <td className="px-3 py-3">
                              <div className="font-semibold">{order.underlyingSymbol} {formatStrike(order.strikePrice)} {order.optionType}</div>
                              <div className="text-xs text-terminal-muted">{order.expiry} / {order.action}</div>
                              {order.ownerEmail ? <div className="text-xs text-terminal-blue">{order.ownerName ?? order.ownerEmail}</div> : null}
                            </td>
                            <td className="px-3 py-3 text-right">
                              <input value={draft.lots} onChange={(event) => setPendingOrderDrafts((drafts) => ({ ...drafts, [order.id]: { ...draft, lots: event.target.value } }))} className="h-9 w-20 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm text-terminal-text outline-none focus:border-terminal-blue" min="1" step="1" type="number" />
                            </td>
                            <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(draftLots, order.lotSize, draftQuantity)}</td>
                            <td className="px-3 py-3 text-right">
                              <input value={draft.requestedPrice} onBlur={() => setPendingOrderDrafts((drafts) => {
                                const currentDraft = drafts[order.id] ?? draft;
                                const nextEntry = normalizeTradablePrice(Number(currentDraft.requestedPrice || order.requestedPrice));
                                return {
                                  ...drafts,
                                  [order.id]: {
                                    ...currentDraft,
                                    requestedPrice: currentDraft.requestedPrice ? formatTradablePrice(Number(currentDraft.requestedPrice)) : currentDraft.requestedPrice,
                                    stopLoss: nextEntry > 0 ? formatTradablePrice(getTrailingStopLoss(order.action, nextEntry, getDefaultTrailDistanceForEntry(nextEntry))) : currentDraft.stopLoss,
                                    targetPrice: nextEntry > 0 ? formatTradablePrice(getDefaultTargetPrice(order.action, nextEntry)) : currentDraft.targetPrice
                                  }
                                };
                              })} onChange={(event) => setPendingOrderDrafts((drafts) => {
                                const nextEntryText = event.target.value;
                                const nextEntry = normalizeTradablePrice(Number(nextEntryText));
                                return {
                                  ...drafts,
                                  [order.id]: {
                                    ...draft,
                                    requestedPrice: nextEntryText,
                                    stopLoss: nextEntry > 0 ? formatTradablePrice(getTrailingStopLoss(order.action, nextEntry, getDefaultTrailDistanceForEntry(nextEntry))) : draft.stopLoss,
                                    targetPrice: nextEntry > 0 ? formatTradablePrice(getDefaultTargetPrice(order.action, nextEntry)) : draft.targetPrice
                                  }
                                };
                              })} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-text outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                            </td>
                            <td className={`px-3 py-3 text-right font-semibold ${willFill ? "text-terminal-emerald" : "text-terminal-blue"}`}>{formatPrice(currentPrice)}</td>
                            <td className="px-3 py-3 text-right text-xs text-terminal-muted">{order.action === "BUY" ? "LTP <= Entry" : "LTP >= Entry"}</td>
                            <td className="px-3 py-3 text-right">
                              <input value={draft.stopLoss} onBlur={() => setPendingOrderDrafts((drafts) => ({ ...drafts, [order.id]: { ...draft, stopLoss: draft.stopLoss ? formatTradablePrice(Number(draft.stopLoss)) : draft.stopLoss } }))} onChange={(event) => setPendingOrderDrafts((drafts) => ({ ...drafts, [order.id]: { ...draft, stopLoss: event.target.value } }))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-red outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                              <div className="mt-1 text-xs text-terminal-muted">Trail {formatPrice(draftTrailDistance)}</div>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <input value={draft.targetPrice} onBlur={() => setPendingOrderDrafts((drafts) => ({ ...drafts, [order.id]: { ...draft, targetPrice: draft.targetPrice ? formatTradablePrice(Number(draft.targetPrice)) : draft.targetPrice } }))} onChange={(event) => setPendingOrderDrafts((drafts) => ({ ...drafts, [order.id]: { ...draft, targetPrice: event.target.value } }))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-emerald outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                            </td>
                            <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(order.createdAt)}</td>
                            <td className="px-3 py-3 text-right">
                              <span className={`rounded border px-2 py-1 text-xs font-semibold ${willFill ? "border-terminal-emerald/70 bg-terminal-emerald/10 text-terminal-emerald" : "border-terminal-amber/70 bg-terminal-amber/10 text-terminal-amber"}`}>
                                {willFill ? "Ready" : order.status}
                              </span>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex justify-end gap-2">
                                <button className="h-9 rounded border border-terminal-blue/70 bg-terminal-blue/10 px-3 text-xs font-semibold text-terminal-blue transition hover:bg-terminal-blue hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={updatingPendingOrderId === order.id || cancelingPendingOrderId === order.id || draftEntry <= 0 || draftTargetPrice <= 0} type="button" onClick={() => handleUpdatePendingOrder(order.id)}>
                                  {updatingPendingOrderId === order.id ? "Saving" : "Save"}
                                </button>
                                <button className="h-9 rounded border border-terminal-red/70 bg-terminal-red/10 px-3 text-xs font-semibold text-terminal-red transition hover:bg-terminal-red hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={updatingPendingOrderId === order.id || cancelingPendingOrderId === order.id} type="button" onClick={() => handleCancelPendingOrder(order.id)}>
                                  {cancelingPendingOrderId === order.id ? "Canceling" : "Cancel"}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {paperSummary && !pendingPaperOrders.length ? (
                        <tr><td colSpan={11} className="px-3 py-6 text-center text-terminal-muted">No pending paper orders.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded border border-terminal-line bg-white/[0.03]">
                <PaperSectionHeader title="Open Paper Positions" meta={`${formatCurrency(paperSummary?.stats.markToMarketPnl ?? 0)} MTM`} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1180px] border-collapse text-sm">
                    <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                      <tr>
                        <th className="px-3 py-3 text-left">Trade</th>
                        <th className="px-3 py-3 text-right">Qty</th>
                        <th className="px-3 py-3 text-right">Entry</th>
                        <th className="px-3 py-3 text-right">LTP</th>
                        <th className="px-3 py-3 text-right">Trail SL</th>
                        <th className="px-3 py-3 text-right">Target</th>
                        <th className="px-3 py-3 text-right">P/L</th>
                        <th className="px-3 py-3 text-right">Opened</th>
                        <th className="px-3 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(paperSummary?.openPositions ?? []).slice(0, 8).map((position) => {
                        const draft = positionRiskDrafts[position.id] ?? {
                          stopLoss: formatTradablePrice(position.stopLoss),
                          trailDistance: formatTradablePrice(position.trailDistance),
                          targetPrice: formatTradablePrice(position.targetPrice)
                        };

                        return (
                          <tr key={position.id} className="border-t border-terminal-line/80">
                            <td className="px-3 py-3">
                              <div className="font-semibold">{position.underlyingSymbol} {formatStrike(position.strikePrice)} {position.optionType}</div>
                              <div className="text-xs text-terminal-muted">{position.expiry} / {position.action}</div>
                              {position.ownerEmail ? <div className="text-xs text-terminal-blue">{position.ownerName ?? position.ownerEmail}</div> : null}
                            </td>
                            <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(position.lots, position.lotSize, position.quantity)}</td>
                            <td className="px-3 py-3 text-right">{formatPrice(position.entryPrice)}</td>
                            <td className="px-3 py-3 text-right">{formatPrice(position.currentPrice)}</td>
                            <td className="px-3 py-3 text-right">
                              <input value={draft.trailDistance} onBlur={() => setPositionRiskDrafts((drafts) => ({ ...drafts, [position.id]: { ...draft, trailDistance: draft.trailDistance ? formatTradablePrice(Number(draft.trailDistance)) : draft.trailDistance } }))} onChange={(event) => setPositionRiskDrafts((drafts) => {
                                const nextTrailDistance = event.target.value;
                                const nextStopLoss = nextTrailDistance ? formatTradablePrice(getTrailingStopLoss(position.action, position.bestPrice, Number(nextTrailDistance))) : draft.stopLoss;
                                return { ...drafts, [position.id]: { ...draft, trailDistance: nextTrailDistance, stopLoss: nextStopLoss } };
                              })} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-red outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                              <div className="mt-1 text-xs text-terminal-muted">SL {draft.stopLoss}</div>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <input value={draft.targetPrice} onBlur={() => setPositionRiskDrafts((drafts) => ({ ...drafts, [position.id]: { ...draft, targetPrice: draft.targetPrice ? formatTradablePrice(Number(draft.targetPrice)) : draft.targetPrice } }))} onChange={(event) => setPositionRiskDrafts((drafts) => ({ ...drafts, [position.id]: { ...draft, targetPrice: event.target.value } }))} className="h-9 w-24 rounded border border-terminal-line bg-terminal-input px-2 text-right text-sm font-semibold text-terminal-emerald outline-none focus:border-terminal-blue" min="0" step="0.05" type="number" />
                            </td>
                            <td className={`px-3 py-3 text-right font-semibold ${position.unrealizedPnl >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>{formatCurrency(position.unrealizedPnl)}</td>
                            <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(position.openedAt)}</td>
                            <td className="px-3 py-3">
                              <div className="flex justify-end gap-2">
                                <button className="h-9 rounded border border-terminal-blue/70 bg-terminal-blue/10 px-3 text-xs font-semibold text-terminal-blue transition hover:bg-terminal-blue hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={updatingRiskPositionId === position.id} type="button" onClick={() => handleUpdatePositionRisk(position.id)}>
                                  {updatingRiskPositionId === position.id ? "Saving" : "Save"}
                                </button>
                                <button className="h-9 rounded border border-terminal-red/70 bg-terminal-red/10 px-3 text-xs font-semibold text-terminal-red transition hover:bg-terminal-red hover:text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={closingPositionId === position.id} type="button" onClick={() => handleClosePosition(position.id)}>
                                  {closingPositionId === position.id ? "Exiting" : "Exit"}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {paperSummary && !paperSummary.openPositions.length ? (
                        <tr><td colSpan={9} className="px-3 py-6 text-center text-terminal-muted">No open paper positions.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded border border-terminal-line bg-white/[0.03]">
                <PaperSectionHeader title="Closed Trades" meta={`${formatCurrency(paperSummary?.stats.realizedPnl ?? 0)} realized`} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1240px] border-collapse text-sm">
                    <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                      <tr>
                        <th className="px-3 py-3 text-left">Trade</th>
                        <th className="px-3 py-3 text-left">Reason</th>
                        <th className="px-3 py-3 text-right">Entry Time</th>
                        <th className="px-3 py-3 text-right">Entry</th>
                        <th className="px-3 py-3 text-right">SL</th>
                        <th className="px-3 py-3 text-right">Target</th>
                        <th className="px-3 py-3 text-right">Exit</th>
                        <th className="px-3 py-3 text-right">Qty</th>
                        <th className="px-3 py-3 text-right">Charges</th>
                        <th className="px-3 py-3 text-right">Net P/L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(paperSummary?.closedTrades ?? []).slice(0, 8).map((trade) => (
                        <tr key={trade.id} className="border-t border-terminal-line/80">
                          <td className="px-3 py-3">
                            <div className="font-semibold">{trade.underlyingSymbol} {formatStrike(trade.strikePrice)} {trade.optionType}</div>
                            <div className="text-xs text-terminal-muted">{trade.expiry} / {trade.action}</div>
                            {trade.ownerEmail ? <div className="text-xs text-terminal-blue">{trade.ownerName ?? trade.ownerEmail}</div> : null}
                          </td>
                          <td className="px-3 py-3 text-terminal-muted">{trade.exitReason}</td>
                          <td className="px-3 py-3 text-right text-xs text-terminal-muted">{formatIstShortDateTime(trade.openedAt)}</td>
                          <td className="px-3 py-3 text-right">{formatPrice(trade.entryPrice)}</td>
                          <td className="px-3 py-3 text-right text-terminal-red">{formatPrice(trade.stopLoss)}</td>
                          <td className="px-3 py-3 text-right text-terminal-emerald">{formatPrice(trade.targetPrice)}</td>
                          <td className="px-3 py-3 text-right">{formatPrice(trade.exitPrice)}</td>
                          <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(trade.lots, trade.lotSize, trade.quantity)}</td>
                          <td className="px-3 py-3 text-right text-terminal-muted">{formatCurrency(-Math.abs(trade.charges))}</td>
                          <td className={`px-3 py-3 text-right font-semibold ${trade.netPnl >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>{formatCurrency(trade.netPnl)}</td>
                        </tr>
                      ))}
                      {paperSummary && !paperSummary.closedTrades.length ? (
                        <tr><td colSpan={10} className="px-3 py-6 text-center text-terminal-muted">No closed trades yet.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded border border-terminal-line bg-white/[0.03]">
                <PaperSectionHeader title="Recent Filled Orders" meta={`${paperSummary?.stats.filledOrders ?? 0} filled`} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] border-collapse text-sm">
                    <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                      <tr>
                        <th className="px-3 py-3 text-left">Order</th>
                        <th className="px-3 py-3 text-right">Qty</th>
                        <th className="px-3 py-3 text-right">Price</th>
                        <th className="px-3 py-3 text-right">SL</th>
                        <th className="px-3 py-3 text-right">Target</th>
                        <th className="px-3 py-3 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentPaperOrders.slice(0, 6).map((order) => (
                        <tr key={order.id} className="border-t border-terminal-line/80">
                          <td className="px-3 py-3">
                            <div className="font-semibold">{order.underlyingSymbol} {formatStrike(order.strikePrice)} {order.optionType}</div>
                            <div className="text-xs text-terminal-muted">{order.expiry} / {formatIstShortDateTime(order.createdAt)}</div>
                            {order.ownerEmail ? <div className="text-xs text-terminal-blue">{order.ownerName ?? order.ownerEmail}</div> : null}
                          </td>
                          <td className="px-3 py-3 text-right text-terminal-muted">{formatLotsAndQty(order.lots, order.lotSize, order.quantity)}</td>
                          <td className="px-3 py-3 text-right">{formatPrice(order.filledPrice ?? order.requestedPrice)}</td>
                          <td className="px-3 py-3 text-right text-terminal-red">{formatPrice(order.stopLoss)}</td>
                          <td className="px-3 py-3 text-right text-terminal-emerald">{formatPrice(order.targetPrice)}</td>
                          <td className="px-3 py-3 text-right text-terminal-emerald">{order.status}</td>
                        </tr>
                      ))}
                      {paperSummary && !recentPaperOrders.length ? (
                        <tr><td colSpan={6} className="px-3 py-6 text-center text-terminal-muted">No filled paper orders yet.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </Panel>
      ) : null}

      {initialView === "replay" ? (
        <Panel title="Replay Lab">
          <div className="grid gap-4 text-sm">
            <div className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-3 md:grid-cols-[minmax(10rem,0.5fr)_minmax(12rem,0.7fr)_auto] md:items-end">
              <label className="grid gap-1 text-xs uppercase text-terminal-muted">
                Replay Expiry
                <select value={replayExpiry} onChange={(event) => {
                  setReplayExpiry(event.target.value);
                  setReplayStartSnapshotId("");
                  setReplayOverview(null);
                  setReplaySnapshots([]);
                  replaySnapshotsRef.current = [];
                  setReplayIndex(0);
                  replayIndexRef.current = 0;
                  setIsReplayPlaying(false);
                }} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none focus:border-terminal-blue">
                  {overview.expiries.length ? overview.expiries.map((expiry) => (
                    <option key={expiry} value={expiry}>{expiry}</option>
                  )) : <option value={overview.selectedExpiry}>{overview.selectedExpiry}</option>}
                </select>
              </label>
              <label className="grid gap-1 text-xs uppercase text-terminal-muted">
                Start Time
                <select value={replayStartSnapshotId} onChange={(event) => {
                  setReplayStartSnapshotId(event.target.value);
                  const nextIndex = replaySnapshots.findIndex((snapshot) => snapshot.id === event.target.value);
                  if (nextIndex >= 0) {
                    void loadReplaySnapshotAtIndex(nextIndex);
                  }
                }} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none focus:border-terminal-blue">
                  {replaySnapshots.length ? replaySnapshots.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>{formatIstTime(snapshot.snapshotTime)} IST - {formatPrice(snapshot.spotPrice)}</option>
                  )) : <option value="">Load snapshots first</option>}
                </select>
              </label>
              <button className="h-10 rounded border border-terminal-blue bg-terminal-blue px-4 text-sm font-semibold text-white transition hover:opacity-90" type="button" onClick={refreshReplayTimeline}>
                Load Replay
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <StatusTile icon={<Play size={18} />} label="Replay" value={isReplayPlaying ? "Playing" : replayOverview ? "Paused" : "Ready"} />
              <StatusTile icon={<Clock3 size={18} />} label="Snapshots" value={String(replaySnapshots.length)} />
              <StatusTile icon={<ShieldCheck size={18} />} label="Data Source" value="Stored ticks" />
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <SignalCell label="Replay Spot" value={formatPrice((replayOverview ?? overview).snapshot.spotPrice)} detail={`${formatIstTime((replayOverview ?? overview).snapshot.snapshotTime)} IST`} tone="blue" />
              <SignalCell label="Move From Open" value={formatCurrency(replayStats.moveFromStart)} detail={replayStats.movePercentText} tone={replayStats.moveFromStart >= 0 ? "green" : "red"} />
              <SignalCell label="Replay Bias" value={buildPressureSummary(replayOverview ?? overview).bias} detail={`PCR ${(replayOverview ?? overview).pressure.pcr?.toFixed(2) ?? "--"}`} tone="blue" />
              <SignalCell label="Timeline Range" value={replayStats.rangeText} detail={replayStats.windowText} tone="blue" />
            </div>
            <div className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button className="grid h-9 w-9 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-50" disabled={!replaySnapshots.length || replayIndex <= 0} type="button" onClick={() => loadReplaySnapshotAtIndex(Math.max(0, replayIndex - 1))} aria-label="Previous replay snapshot">
                    <SkipBack size={16} />
                  </button>
                  <button className="grid h-10 w-10 place-items-center rounded border border-terminal-blue bg-terminal-blue text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" disabled={!replaySnapshots.length} type="button" onClick={() => setIsReplayPlaying((value) => !value)} aria-label={isReplayPlaying ? "Pause replay" : "Play replay"}>
                    {isReplayPlaying ? <Pause size={17} /> : <Play size={17} />}
                  </button>
                  <button className="grid h-9 w-9 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-50" disabled={!replaySnapshots.length || replayIndex >= replaySnapshots.length - 1} type="button" onClick={() => loadReplaySnapshotAtIndex(Math.min(replaySnapshots.length - 1, replayIndex + 1))} aria-label="Next replay snapshot">
                    <SkipForward size={16} />
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs uppercase text-terminal-muted">
                  Speed
                  <select value={replaySpeedMs} onChange={(event) => setReplaySpeedMs(Number(event.target.value))} className="h-9 rounded border border-terminal-line bg-terminal-input px-2 text-sm normal-case text-terminal-text outline-none focus:border-terminal-blue">
                    <option value={2500}>1x</option>
                    <option value={1500}>2x</option>
                    <option value={750}>5x</option>
                  </select>
                </label>
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between text-xs text-terminal-muted">
                  <span>{replaySnapshots[replayIndex] ? formatIstTime(replaySnapshots[replayIndex].snapshotTime) : "--"} IST</span>
                  <span>{replaySnapshots.length ? `${replayIndex + 1} / ${replaySnapshots.length}` : "0 / 0"}</span>
                </div>
                <div className="h-2 rounded bg-white/10">
                  <div className="h-2 rounded bg-terminal-blue transition-all" style={{ width: `${replaySnapshots.length > 1 ? (replayIndex / (replaySnapshots.length - 1)) * 100 : 0}%` }} />
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Snapshot Timeline</span>
                <button className="min-h-9 rounded border border-terminal-line px-3 py-1.5 text-xs text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="button" onClick={refreshReplayTimeline}>
                  Reload
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {replaySnapshots.map((snapshot) => (
                  <button key={snapshot.id} className={`shrink-0 rounded border px-3 py-2 text-left transition ${replayOverview?.snapshot.snapshotTime === snapshot.snapshotTime ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line bg-white/[0.03] text-terminal-muted hover:border-terminal-blue hover:text-terminal-text"}`} type="button" onClick={() => handleReplaySnapshot(snapshot.id)}>
                    <span className="block text-xs">{formatIstTime(snapshot.snapshotTime)}</span>
                    <span className="block text-[0.7rem]">{formatPrice(snapshot.spotPrice)}</span>
                  </button>
                ))}
                {!replaySnapshots.length ? <p className="rounded border border-terminal-line bg-white/[0.03] px-3 py-4 text-terminal-muted">No stored snapshots found.</p> : null}
              </div>
              {replayError ? <p className="text-terminal-red">{replayError}</p> : null}
            </div>
            <div className="min-w-0 rounded border border-terminal-line bg-terminal-panel/80">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-terminal-line p-4">
                <div>
                  <h2 className="text-base font-semibold">Replay Snapshot</h2>
                  <p className="mt-1 text-sm text-terminal-muted">
                    {(replayOverview ?? overview).snapshot.underlyingSymbol} {(replayOverview ?? overview).snapshot.expiry} at {formatIstTime((replayOverview ?? overview).snapshot.snapshotTime)} IST
                  </p>
                  <p className="mt-1 text-xs text-terminal-muted">
                    VIX range {formatStrike(replayChainRange.lower)}-{formatStrike(replayChainRange.upper)} using India VIX {replayChainRange.vix.toFixed(2)}%
                  </p>
                </div>
                <span className="text-sm font-semibold text-terminal-blue">Spot {formatPrice((replayOverview ?? overview).snapshot.spotPrice)}</span>
              </div>
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-[1080px] border-collapse text-sm">
                  <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                    <tr>
                      <th className="px-4 py-3 text-left">CE IV/Δ</th>
                      <th className="px-4 py-3 text-left">CE OI</th>
                      <th className="px-4 py-3 text-left">CE Chg</th>
                      <th className="px-4 py-3 text-left">CE Vol</th>
                      <th className="px-4 py-3 text-left">CE LTP</th>
                      <th className="px-4 py-3 text-center">Strike</th>
                      <th className="px-4 py-3 text-right">PE LTP</th>
                      <th className="px-4 py-3 text-right">PE Vol</th>
                      <th className="px-4 py-3 text-right">PE Chg</th>
                      <th className="px-4 py-3 text-right">PE OI</th>
                      <th className="px-4 py-3 text-right">PE IV/Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {replayChainRows.map((row) => (
                      <tr key={row.strike} className={row.strike === (replayOverview ?? overview).snapshot.atmStrike ? "border-y border-terminal-blue/70 bg-terminal-blue/10" : "border-t border-terminal-line/80"}>
                        <td className="px-4 py-3">{renderIvDeltaCell(row.ceIv, row.ceDelta, "left")}</td>
                        <td className="px-4 py-3">{renderPressureCell(row.ceOi, row.ceOiRank, row.ceOiPercent, "CE")}</td>
                        <td className="px-4 py-3">{renderPressureCell(row.ceChg, row.ceChgRank, row.ceChgPercent, "CE")}</td>
                        <td className="px-4 py-3">{renderPressureCell(row.ceVol, row.ceVolRank, row.ceVolPercent, "CE")}</td>
                        <td className="px-4 py-3">{renderLtpStack(row.ceLtp, row.ceLtpChange, row.ceLtpChangePercent, "left", row.ceActivity)}</td>
                        <td className="px-4 py-3 text-center font-semibold text-terminal-text">{row.strike}</td>
                        <td className="px-4 py-3 text-right">{renderLtpStack(row.peLtp, row.peLtpChange, row.peLtpChangePercent, "right", row.peActivity)}</td>
                        <td className="px-4 py-3">{renderPressureCell(row.peVol, row.peVolRank, row.peVolPercent, "PE")}</td>
                        <td className="px-4 py-3">{renderPressureCell(row.peChg, row.peChgRank, row.peChgPercent, "PE")}</td>
                        <td className="px-4 py-3">{renderPressureCell(row.peOi, row.peOiRank, row.peOiPercent, "PE")}</td>
                        <td className="px-4 py-3">{renderIvDeltaCell(row.peIv, row.peDelta, "right")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

async function fetchMarketOverview(underlying: string, expiry: string): Promise<MarketOverview> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams({ underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }
  const response = await fetch(`${apiUrl}/api/market/overview?${search.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Market refresh failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<MarketOverview>;
}

async function fetchMarketTicker(symbols?: string[]): Promise<Pick<MarketOverview, "indiaVix" | "ticker">> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams();
  const normalizedSymbols = [...new Set((symbols ?? []).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (normalizedSymbols.length) {
    search.set("symbols", normalizedSymbols.join(","));
  }
  const query = search.size ? `?${search.toString()}` : "";
  const response = await fetch(`${apiUrl}/api/market/ticker${query}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Ticker refresh failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<Pick<MarketOverview, "indiaVix" | "ticker">>;
}

function buildMarketStreamUrl(underlying: string, expiry: string, symbols?: string[]) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams({ underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }

  const normalizedSymbols = [...new Set((symbols ?? []).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (normalizedSymbols.length) {
    search.set("symbols", normalizedSymbols.join(","));
  }

  return `${apiUrl}/api/market/stream?${search.toString()}`;
}

function buildClientViewHref(view: DashboardView, underlying: string, expiry: string) {
  const search = new URLSearchParams({ view, underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }
  return `/app?${search.toString()}`;
}

async function fetchPaperSummary(): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/summary`, {
    cache: "no-store",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Paper summary failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<PaperSummary>;
}

async function fetchDefaultWatchlist(): Promise<Watchlist> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/watchlist/default`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Watchlist failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<Watchlist>;
}

async function updateDefaultWatchlist(symbols: string[]): Promise<Watchlist> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/watchlist/default`, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ symbols })
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Watchlist update failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<Watchlist>;
}

async function fetchAuthUser(): Promise<{ user: AuthUser | null }> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/me`, {
    cache: "no-store",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Account lookup failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<{ user: AuthUser | null }>;
}

async function submitAuth(mode: "login" | "register", payload: { email: string; password: string; displayName?: string }): Promise<{ user: AuthUser }> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/${mode}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({
      email: payload.email,
      password: payload.password,
      displayName: payload.displayName?.trim() || undefined
    })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Account request failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<{ user: AuthUser }>;
}

async function logoutAuthUser(): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/logout`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Logout failed with HTTP ${response.status}`);
  }
}

async function resendVerificationEmail(): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/resend-verification`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Verification email failed with HTTP ${response.status}`);
  }
}

async function fetchAdminOverview(): Promise<AdminOverview> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/admin/overview`, {
    cache: "no-store",
    credentials: "include"
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Admin console failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<AdminOverview>;
}

async function updateAdminUserRole(userId: string, role: AdminOverview["users"][number]["role"]) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/admin/users/${userId}/role`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ role })
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Role update failed with HTTP ${response.status}`);
  }
}

async function updateAdminUserDisabled(userId: string, disabled: boolean) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/admin/users/${userId}/disabled`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ disabled })
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `User status update failed with HTTP ${response.status}`);
  }
}

async function fetchReplayTimeline(underlying: string, expiry: string): Promise<ReplaySnapshotSummary[]> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams({ underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }
  const response = await fetch(`${apiUrl}/api/replay/timeline?${search.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Replay timeline failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { snapshots: ReplaySnapshotSummary[] };
  return [...payload.snapshots].reverse();
}

async function fetchReplaySnapshot(snapshotId: string, baseOverview: MarketOverview): Promise<MarketOverview> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/replay/snapshot/${snapshotId}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Replay snapshot failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Pick<MarketOverview, "alerts" | "pressure" | "snapshot">;
  return {
    ...baseOverview,
    selectedUnderlying: payload.snapshot.underlyingSymbol,
    selectedExpiry: payload.snapshot.expiry,
    snapshot: payload.snapshot,
    pressure: payload.pressure,
    alerts: payload.alerts
  };
}

async function placePaperOrder(payload: {
  underlyingSymbol: string;
  expiry: string;
  action: "BUY" | "SELL";
  optionType: "CE" | "PE";
  strikePrice: number;
  lots: number;
  requestedPrice: number;
  stopLoss: number;
  trailingStop: boolean;
  trailDistance: number;
  targetPrice: number;
  strategyName: string;
  reasonText: string;
}): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Paper order failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<PaperSummary>;
}

async function closePaperPosition(positionId: string): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/positions/${positionId}/close`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ exitReason: "MANUAL" })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Position close failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<PaperSummary>;
}

async function updatePendingPaperOrder(orderId: string, payload: {
  lots: number;
  requestedPrice: number;
  stopLoss: number;
  trailingStop: boolean;
  trailDistance: number;
  targetPrice: number;
}): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/orders/${orderId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Pending order update failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<PaperSummary>;
}

async function cancelPendingPaperOrder(orderId: string): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/orders/${orderId}/cancel`, {
    method: "POST",
    credentials: "include"
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Pending order cancel failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<PaperSummary>;
}

async function updatePaperPositionRisk(positionId: string, stopLoss: number, targetPrice: number, trailDistance: number): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/positions/${positionId}/risk`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ stopLoss, trailDistance, targetPrice })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Position risk update failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<PaperSummary>;
}

interface VixStrikeRange {
  lower: number;
  upper: number;
  expectedMove: number;
  vix: number;
}

interface DisplayPreferences {
  numberFormatMode: NumberFormatMode;
  quantityDisplayMode: QuantityDisplayMode;
}

function buildVixStrikeRange(overview: MarketOverview): VixStrikeRange {
  const spot = overview.snapshot.spotPrice;
  const vix = overview.indiaVix && overview.indiaVix > 0 ? overview.indiaVix : 15;
  const daysToExpiry = getDaysToExpiry(overview.snapshot.expiry, overview.snapshot.snapshotTime);
  const expectedMove = spot > 0 ? spot * (vix / 100) * Math.sqrt(daysToExpiry / 365) : 0;

  return {
    lower: Math.max(0, spot - expectedMove),
    upper: spot + expectedMove,
    expectedMove,
    vix
  };
}

function buildAtmStrikeRange(overview: MarketOverview): VixStrikeRange {
  const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))].sort((left, right) => left - right);
  const atmIndex = strikes.findIndex((strike) => strike === overview.snapshot.atmStrike);
  if (atmIndex < 0) {
    return buildVixStrikeRange(overview);
  }
  const visibleStrikes = strikes.slice(Math.max(0, atmIndex - 6), atmIndex + 7);
  return {
    lower: visibleStrikes[0] ?? overview.snapshot.atmStrike,
    upper: visibleStrikes[visibleStrikes.length - 1] ?? overview.snapshot.atmStrike,
    expectedMove: Math.abs((visibleStrikes[visibleStrikes.length - 1] ?? overview.snapshot.atmStrike) - overview.snapshot.atmStrike),
    vix: overview.indiaVix && overview.indiaVix > 0 ? overview.indiaVix : 15
  };
}

function getDaysToExpiry(expiry: string, snapshotTime: string) {
  const expiryTime = Date.parse(`${expiry}T15:30:00+05:30`);
  const snapshotDate = Date.parse(snapshotTime);
  if (!Number.isFinite(expiryTime) || !Number.isFinite(snapshotDate)) {
    return 1;
  }
  return Math.max(1, Math.ceil((expiryTime - snapshotDate) / 86_400_000));
}

function buildChainRows(overview: MarketOverview, range: VixStrikeRange, preferences: DisplayPreferences) {
  const ticksByStrike = new Map<number, Partial<Record<"CE" | "PE", OverviewTick>>>();

  for (const tick of overview.snapshot.ticks) {
    const row = ticksByStrike.get(tick.strikePrice) ?? {};
    row[tick.optionType] = tick;
    ticksByStrike.set(tick.strikePrice, row);
  }

  const allRows = [...ticksByStrike.entries()]
    .filter(([strike]) => strike >= range.lower && strike <= range.upper)
    .map(([strike, pair]) => ({
      strike,
      ceOi: formatQuantityValue(pair.CE?.openInterest, pair.CE, preferences),
      ceOiLots: toLots(pair.CE?.openInterest, pair.CE),
      ceOiRaw: pair.CE?.openInterest ?? 0,
      ceChg: formatQuantityValue(pair.CE?.changeInOpenInterest, pair.CE, preferences, true),
      ceChgLots: Math.abs(toLots(pair.CE?.changeInOpenInterest, pair.CE)),
      ceChgRaw: Math.abs(pair.CE?.changeInOpenInterest ?? 0),
      ceVol: formatQuantityValue(pair.CE?.volume, pair.CE, preferences),
      ceVolLots: toLots(pair.CE?.volume, pair.CE),
      ceVolRaw: pair.CE?.volume ?? 0,
      ceLtp: pair.CE?.lastPrice,
      ceLtpChange: pair.CE?.lastPriceChange,
      ceLtpChangePercent: pair.CE?.lastPriceChangePercent,
      ceActivity: classifyOptionActivity(pair.CE),
      ceIv: pair.CE?.impliedVolatility,
      ceDelta: pair.CE?.delta,
      peLtp: pair.PE?.lastPrice,
      peLtpChange: pair.PE?.lastPriceChange,
      peLtpChangePercent: pair.PE?.lastPriceChangePercent,
      peActivity: classifyOptionActivity(pair.PE),
      peIv: pair.PE?.impliedVolatility,
      peDelta: pair.PE?.delta,
      peVol: formatQuantityValue(pair.PE?.volume, pair.PE, preferences),
      peVolLots: toLots(pair.PE?.volume, pair.PE),
      peVolRaw: pair.PE?.volume ?? 0,
      peChg: formatQuantityValue(pair.PE?.changeInOpenInterest, pair.PE, preferences, true),
      peChgLots: Math.abs(toLots(pair.PE?.changeInOpenInterest, pair.PE)),
      peChgRaw: Math.abs(pair.PE?.changeInOpenInterest ?? 0),
      peOi: formatQuantityValue(pair.PE?.openInterest, pair.PE, preferences),
      peOiLots: toLots(pair.PE?.openInterest, pair.PE),
      peOiRaw: pair.PE?.openInterest ?? 0,
      ceOiPercent: 0,
      ceChgPercent: 0,
      ceVolPercent: 0,
      peOiPercent: 0,
      peChgPercent: 0,
      peVolPercent: 0,
      ceOiRank: undefined as 1 | 2 | undefined,
      ceChgRank: undefined as 1 | 2 | undefined,
      ceVolRank: undefined as 1 | 2 | undefined,
      peOiRank: undefined as 1 | 2 | undefined,
      peChgRank: undefined as 1 | 2 | undefined,
      peVolRank: undefined as 1 | 2 | undefined
    }))
    .sort((left, right) => right.strike - left.strike);

  const visibleRows = allRows;

  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceOiLots, row.ceOiRaw, preferences), (row, percent) => {
    row.ceOiPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceChgLots, row.ceChgRaw, preferences), (row, percent) => {
    row.ceChgPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.ceVolLots, row.ceVolRaw, preferences), (row, percent) => {
    row.ceVolPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peOiLots, row.peOiRaw, preferences), (row, percent) => {
    row.peOiPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peChgLots, row.peChgRaw, preferences), (row, percent) => {
    row.peChgPercent = percent;
  });
  applyPressurePercents(visibleRows, (row) => displayRankValue(row.peVolLots, row.peVolRaw, preferences), (row, percent) => {
    row.peVolPercent = percent;
  });

  applyPressureRanks(visibleRows, (row) => row.ceOiLots, (row, rank) => {
    row.ceOiRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.ceChgLots, (row, rank) => {
    row.ceChgRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.ceVolLots, (row, rank) => {
    row.ceVolRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.peOiLots, (row, rank) => {
    row.peOiRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.peChgLots, (row, rank) => {
    row.peChgRank = rank;
  });
  applyPressureRanks(visibleRows, (row) => row.peVolLots, (row, rank) => {
    row.peVolRank = rank;
  });

  return visibleRows;
}

function displayRankValue(lotsValue: number, rawValue: number, preferences: DisplayPreferences) {
  return preferences.quantityDisplayMode === "lots" ? lotsValue : rawValue;
}

function applyPressurePercents<T>(rows: T[], getValue: (row: T) => number, setPercent: (row: T, percent: number) => void) {
  const maxValue = Math.max(0, ...rows.map(getValue));
  for (const row of rows) {
    const percent = maxValue > 0 ? Math.round((getValue(row) / maxValue) * 100) : 0;
    setPercent(row, percent);
  }
}

function applyPressureRanks<T>(rows: T[], getValue: (row: T) => number, setRank: (row: T, rank: 1 | 2) => void) {
  const rankedRows = [...rows]
    .filter((row) => getValue(row) > 0)
    .sort((left, right) => getValue(right) - getValue(left))
    .slice(0, 2);

  rankedRows.forEach((row, index) => {
    setRank(row, (index + 1) as 1 | 2);
  });
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

function MarketTicker({ items }: { items: MarketTickerItem[] }) {
  const visibleItems = items.length ? items : [{ symbol: "NIFTY", displayName: "NIFTY", segment: "IDX_I" }];
  const tickerItems = [...visibleItems, ...visibleItems];

  return (
    <section className="overflow-hidden rounded border border-terminal-line bg-terminal-panel/90" aria-label="Market ticker">
      <div className="flex border-b border-terminal-line/70 px-3 py-2 text-xs font-semibold uppercase text-terminal-muted">
        <span>Market Ticker</span>
      </div>
      <div className="relative overflow-hidden py-2">
        <div className="market-ticker-track flex w-max gap-2 px-2">
          {tickerItems.map((item, index) => {
            const change = item.change ?? 0;
            const hasChange = item.change !== undefined && item.changePercent !== undefined;
            const toneClass = !hasChange ? "text-terminal-muted" : change >= 0 ? "text-terminal-emerald" : "text-terminal-red";
            const sign = change > 0 ? "+" : "";

            return (
              <div key={`${item.symbol}-${index}`} className="flex min-w-max items-center gap-2 rounded border border-terminal-line bg-terminal-input px-3 py-1.5 text-sm">
                <span className="font-semibold text-terminal-text">{item.displayName}</span>
                <span className="text-terminal-muted">{formatPrice(item.spotPrice)}</span>
                <span className={`font-semibold ${toneClass}`}>
                  {hasChange ? `${sign}${formatPrice(change)} (${sign}${item.changePercent?.toFixed(2)}%)` : "Chg --"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
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

function buildTopStrikeRows(overview: MarketOverview, preferences: DisplayPreferences) {
  const getQuantity = (tick: OverviewTick) => (preferences.quantityDisplayMode === "lots" ? toLots(tick.openInterest, tick) : tick.openInterest ?? 0);
  return [...overview.snapshot.ticks]
    .filter((tick) => (tick.openInterest ?? 0) > 0)
    .sort((left, right) => getQuantity(right) - getQuantity(left))
    .slice(0, 4)
    .map((tick) => ({
      strike: tick.strikePrice,
      optionType: tick.optionType,
      openInterest: getQuantity(tick),
      changePercent: tick.openInterest ? ((tick.changeInOpenInterest ?? 0) / tick.openInterest) * 100 : 0
    }));
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

function buildChainStats(overview: MarketOverview, preferences: DisplayPreferences) {
  const ceTicks = overview.snapshot.ticks.filter((tick) => tick.optionType === "CE");
  const peTicks = overview.snapshot.ticks.filter((tick) => tick.optionType === "PE");
  const getQuantity = (value: number | undefined, tick: OverviewTick) => (preferences.quantityDisplayMode === "lots" ? toLots(value, tick) : value ?? 0);
  const totalCeOi = ceTicks.reduce((sum, tick) => sum + getQuantity(tick.openInterest, tick), 0);
  const totalPeOi = peTicks.reduce((sum, tick) => sum + getQuantity(tick.openInterest, tick), 0);
  const totalCeChange = ceTicks.reduce((sum, tick) => sum + getQuantity(tick.changeInOpenInterest, tick), 0);
  const totalPeChange = peTicks.reduce((sum, tick) => sum + getQuantity(tick.changeInOpenInterest, tick), 0);
  const maxOiTick = [...overview.snapshot.ticks].sort((left, right) => getQuantity(right.openInterest, right) - getQuantity(left.openInterest, left))[0];
  const breadth = totalPeOi > totalCeOi * 1.05 ? "Put Support" : totalCeOi > totalPeOi * 1.05 ? "Call Resistance" : "Balanced";

  return {
    totalCeOi,
    totalPeOi,
    totalCeChange,
    totalPeChange,
    breadth,
    maxOiStrikeText: maxOiTick ? `${formatStrike(maxOiTick.strikePrice)} ${maxOiTick.optionType}` : "--",
    maxOiSide: maxOiTick ? `${formatQuantityValue(maxOiTick.openInterest, maxOiTick, preferences)} OI` : "--"
  };
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
  const maxPainStrike = calculateMaxPainStrike(overview);
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

function TerminalPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-terminal-blue/30 bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SettingsSwitch({ label, leftLabel, rightLabel, checked, onChange, detail }: { label: string; leftLabel: string; rightLabel: string; checked: boolean; onChange: (checked: boolean) => void; detail: string }) {
  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-semibold text-terminal-text">{label}</p>
          <p className="mt-1 text-sm text-terminal-muted">{detail}</p>
        </div>
        <label className="flex h-10 shrink-0 items-center rounded border border-terminal-line bg-terminal-input p-1 text-xs font-semibold uppercase text-terminal-muted">
          <span className={`rounded px-2 py-1.5 ${!checked ? "bg-terminal-blue text-white" : ""}`}>{leftLabel}</span>
          <input className="sr-only" checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
          <span className={`rounded px-2 py-1.5 ${checked ? "bg-terminal-blue text-white" : ""}`}>{rightLabel}</span>
        </label>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function PaperSectionHeader({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-line px-3 py-3">
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-terminal-muted">{meta}</span>
    </div>
  );
}

function PressureGauge({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: "emerald" | "red" }) {
  const colorClass = tone === "emerald" ? "text-terminal-emerald" : "text-terminal-red";
  const barClass = tone === "emerald" ? "bg-terminal-emerald" : "bg-terminal-red";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm text-terminal-muted">{label}</span>
        <span className={`text-lg font-semibold ${colorClass}`}>{value}%</span>
      </div>
      <div className="h-3 rounded bg-white/10">
        <div className={`h-3 rounded ${barClass} transition-all`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <p className="mt-2 text-xs text-terminal-muted">{detail}</p>
    </div>
  );
}

function PressureBar({ label, value, tone }: { label: string; value: number; tone: "blue" | "emerald" }) {
  const barClass = tone === "emerald" ? "bg-terminal-emerald" : "bg-terminal-blue";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-terminal-muted">{label}</span>
        <span className="font-semibold">{value}%</span>
      </div>
      <div className="h-2 rounded bg-white/10">
        <div className={`h-2 rounded ${barClass}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function SignalCell({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "blue" | "green" | "red" }) {
  const toneClass = tone === "green" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <p className="text-xs uppercase text-terminal-muted">{label}</p>
      <p className={`mt-2 text-lg font-semibold ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs text-terminal-muted">{detail}</p>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-line/70 pb-2 last:border-b-0 last:pb-0">
      <span className="text-terminal-muted">{label}</span>
      <span className="text-right font-semibold text-terminal-text">{value}</span>
    </div>
  );
}

function StatusTile({ icon, label, value, detail, tone = "blue" }: { icon: ReactNode; label: string; value: string; detail?: string; tone?: "blue" | "green" | "red" }) {
  const toneClass = tone === "green" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <div className={`flex items-center gap-2 ${toneClass}`}>{icon}</div>
      <p className="mt-3 text-xs uppercase text-terminal-muted">{label}</p>
      <p className={`mt-1 font-semibold ${toneClass}`}>{value}</p>
      {detail ? <p className="mt-1 text-xs text-terminal-muted">{detail}</p> : null}
    </div>
  );
}

function PaperRiskCell({ label, value, tone = "blue" }: { label: string; value: string; tone?: "blue" | "green" | "red" }) {
  const toneClass = tone === "green" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <div className="rounded border border-terminal-line bg-terminal-input p-2">
      <p className="uppercase text-terminal-muted">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

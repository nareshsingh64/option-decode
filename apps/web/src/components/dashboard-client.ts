import type {
  AdminOverview,
  AlertThreshold,
  AuthUser,
  DashboardView,
  MarketOverview,
  PaperSummary,
  ReplaySnapshotSummary,
  Watchlist
} from "./live-dashboard";

export async function fetchMarketOverview(underlying: string, expiry: string): Promise<MarketOverview> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams({ underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }
  const response = await fetch(`${apiUrl}/api/market/overview?${search.toString()}`, {
    cache: "no-store",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Market refresh failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<MarketOverview>;
}

export async function fetchMarketTicker(symbols?: string[]): Promise<Pick<MarketOverview, "indiaVix" | "ticker">> {
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

export function buildMarketStreamUrl(underlying: string, expiry: string, symbols?: string[]) {
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

export function buildClientViewHref(view: DashboardView, underlying: string, expiry: string) {
  const search = new URLSearchParams({ view, underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }
  return `/app?${search.toString()}`;
}

export async function fetchPaperSummary(): Promise<PaperSummary> {
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

export async function fetchDefaultWatchlist(): Promise<Watchlist> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/watchlist/default`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Watchlist failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<Watchlist>;
}

export async function updateDefaultWatchlist(symbols: string[]): Promise<Watchlist> {
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

export async function fetchAuthUser(): Promise<{ user: AuthUser | null }> {
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

export async function submitAuth(mode: "login" | "register", payload: { email: string; password: string; displayName?: string }): Promise<{ user: AuthUser }> {
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

export async function logoutAuthUser(): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/logout`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Logout failed with HTTP ${response.status}`);
  }
}

export async function resendVerificationEmail(): Promise<void> {
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

export async function fetchAlertThresholds(): Promise<AlertThreshold[]> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/settings/alert-thresholds`, {
    cache: "no-store",
    credentials: "include"
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Alert settings failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { thresholds: AlertThreshold[] };
  return payload.thresholds;
}

export async function updateAlertThreshold(underlying: string, threshold: Omit<AlertThreshold, "underlyingSymbol">): Promise<AlertThreshold> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/settings/alert-thresholds/${encodeURIComponent(underlying)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify(threshold)
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Alert settings update failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { threshold: AlertThreshold };
  return payload.threshold;
}

export async function registerBrowserPush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("This browser does not support push notifications.");
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const keyResponse = await fetch(`${apiUrl}/api/push/vapid-public-key`, {
    cache: "no-store",
    credentials: "include"
  });
  if (!keyResponse.ok) {
    throw new Error(`Push setup failed with HTTP ${keyResponse.status}`);
  }
  const keyPayload = (await keyResponse.json()) as { enabled: boolean; publicKey?: string | null };
  if (!keyPayload.enabled || !keyPayload.publicKey) {
    throw new Error("Browser push is not configured on the server.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const registration = await navigator.serviceWorker.register("/push-sw.js");
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyPayload.publicKey)
  });
  const response = await fetch(`${apiUrl}/api/push/subscriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify(subscription.toJSON())
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Push registration failed with HTTP ${response.status}`);
  }
}

export async function disableBrowserPush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("This browser does not support push notifications.");
  }

  const registration = await navigator.serviceWorker.getRegistration("/push-sw.js");
  const subscription = await registration?.pushManager.getSubscription();
  const endpoint = subscription?.endpoint;
  if (subscription) {
    await subscription.unsubscribe();
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/push/subscriptions`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify(endpoint ? { endpoint } : {})
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Push disable failed with HTTP ${response.status}`);
  }
}

export function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }
  return output;
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
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

export async function updateAdminUserRole(userId: string, role: AdminOverview["users"][number]["role"]) {
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

export async function updateAdminUserDisabled(userId: string, disabled: boolean) {
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

export async function fetchReplayTradingDates(underlying: string, expiry: string): Promise<string[]> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams({ underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }
  const response = await fetch(`${apiUrl}/api/replay/trading-dates?${search.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Replay trading dates failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { tradingDates: string[] };
  return payload.tradingDates;
}

export async function fetchReplayTimeline(underlying: string, expiry: string, tradingDate?: string): Promise<ReplaySnapshotSummary[]> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams({ underlying });
  if (expiry) {
    search.set("expiry", expiry);
  }
  if (tradingDate) {
    search.set("tradingDate", tradingDate);
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

export async function fetchReplaySnapshot(snapshotId: string, baseOverview: MarketOverview): Promise<MarketOverview> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/replay/snapshot/${snapshotId}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Replay snapshot failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Pick<MarketOverview, "alerts" | "pressure" | "snapshot" | "recommendations" | "marketPulse">;
  return {
    ...baseOverview,
    selectedUnderlying: payload.snapshot.underlyingSymbol,
    selectedExpiry: payload.snapshot.expiry,
    snapshot: payload.snapshot,
    pressure: payload.pressure,
    alerts: payload.alerts,
    recommendations: payload.recommendations,
    marketPulse: payload.marketPulse
  };
}

export interface PaperOrderLegPayload {
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
  legRole?: "MAIN" | "HEDGE";
}

export async function placePaperOrder(payload: PaperOrderLegPayload): Promise<PaperSummary> {
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

// Build multi-leg at entry: places a main leg plus one or more hedge legs
// together in one ticket, linked as a single strategy.
export async function placeMultiLegPaperOrder(legs: PaperOrderLegPayload[]): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/orders/multi-leg`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ legs })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Multi-leg paper order failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<PaperSummary>;
}

export async function closePaperPosition(positionId: string): Promise<PaperSummary> {
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

export async function updatePendingPaperOrder(orderId: string, payload: {
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

export async function cancelPendingPaperOrder(orderId: string): Promise<PaperSummary> {
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

export async function updatePaperPositionRisk(positionId: string, stopLoss: number, targetPrice: number, trailDistance: number, trailingStop: boolean): Promise<PaperSummary> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/paper/positions/${positionId}/risk`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ stopLoss, trailDistance, targetPrice, trailingStop })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Position risk update failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<PaperSummary>;
}

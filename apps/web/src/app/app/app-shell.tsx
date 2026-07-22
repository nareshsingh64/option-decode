"use client";

import { Activity, Bell, CandlestickChart, Crosshair, FlaskConical, LogOut, Play, Settings, ShieldCheck, UserCircle, WalletCards } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LiveDashboard } from "../../components/live-dashboard";
import type { AuthUser, DashboardView, MarketOverview } from "../../components/live-dashboard";

const protectedNavItems: Array<[DashboardView, string, LucideIcon]> = [
  ["dashboard", "Dashboard", Activity],
  ["new-dashboard", "Strike Matrix", Crosshair],
  ["option-chain", "Option Chain", CandlestickChart],
  ["pressure", "Pressure Engine", ShieldCheck],
  ["replay", "Replay Lab", Play],
  ["paper", "Paper Trading", WalletCards],
  ["paper-pro", "Paper Trading Pro", FlaskConical],
  ["alerts", "Alerts", Bell],
  ["account", "Account", UserCircle],
  ["admin", "Admin", ShieldCheck],
  ["settings", "Settings", Settings]
];

interface AppShellProps {
  initialOverview: MarketOverview;
  initialAuthUser: AuthUser;
  initialParams?: {
    underlying?: string;
    expiry?: string;
    auth?: string;
  };
  requestedView: DashboardView;
}

export function AppShell({ initialOverview, initialAuthUser, initialParams, requestedView }: AppShellProps) {
  const router = useRouter();
  const [authUser, setAuthUser] = useState<AuthUser | null>(initialAuthUser);
  const [activeView, setActiveView] = useState(requestedView);
  const [currentParams, setCurrentParams] = useState(initialParams);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // Role-based tab access: admins see everything; other users see only
  // their assigned tabs (Account and Settings are always available).
  // A missing allowedViews (older cached session payload) means no
  // restriction, so existing sessions keep working until refresh.
  const navItems = useMemo(() => protectedNavItems.filter(([view]) => {
    if (view === "admin") {
      return authUser?.role === "ADMIN";
    }
    if (view === "account" || view === "settings") {
      return true;
    }
    if (authUser?.role === "ADMIN" || !authUser?.allowedViews) {
      return true;
    }
    return authUser.allowedViews.includes(view);
  }), [authUser?.role, authUser?.allowedViews]);

  useEffect(() => {
    // Guard direct URL access to an unassigned tab: fall back to the first
    // tab this user is actually allowed to see.
    const isAllowed = navItems.some(([view]) => view === requestedView);
    setActiveView(isAllowed ? requestedView : navItems[0]?.[0] ?? "account");
  }, [requestedView, navItems]);

  useEffect(() => {
    setCurrentParams(initialParams);
  }, [initialParams]);

  const handleViewChange = useCallback((view: DashboardView) => {
    // Role-based tab access: ignore programmatic navigation (quick-order
    // buttons, signal handoffs, header shortcuts) to tabs this user was
    // not assigned - the nav filter above is the single source of truth.
    if (!navItems.some(([allowedView]) => allowedView === view)) {
      return;
    }
    setActiveView(view);
    window.history.pushState(null, "", buildViewHref(view, currentParams));
  }, [currentParams, navItems]);

  const handleMarketSelectionChange = useCallback((params: { underlying: string; expiry: string }) => {
    setCurrentParams((current) => ({
      ...current,
      underlying: params.underlying,
      expiry: params.expiry
    }));
    window.history.pushState(null, "", buildViewHref(activeView, params));
  }, [activeView]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logoutAuthUser();
      setAuthUser(null);
      router.replace("/");
      router.refresh();
    } finally {
      setIsLoggingOut(false);
    }
  };

  const nav = useMemo(
    () =>
      navItems.map(([view, label, Icon]) => (
        <a key={view} className={`flex min-h-10 items-center gap-3 rounded px-3 py-2 transition hover:bg-white/5 hover:text-terminal-text ${activeView === view ? "bg-terminal-blue/15 text-terminal-blue" : ""}`} href={buildViewHref(view, currentParams)} onClick={(event) => {
          event.preventDefault();
          handleViewChange(view);
        }}>
          <Icon size={17} />
          <span className="flex-1">{label}</span>
          {view === "alerts" && initialOverview.alerts.length ? <span className="rounded-full bg-terminal-red px-2 py-0.5 text-[0.65rem] font-semibold text-white">{initialOverview.alerts.length}</span> : null}
        </a>
      )),
    [activeView, currentParams, handleViewChange, initialOverview.alerts.length, navItems]
  );

  return (
    <main className="min-h-screen">
      <section className="flex min-h-screen w-full flex-col px-3 py-3 sm:px-4 lg:px-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-terminal-line/80 pb-3">
          <div>
            <p className="text-xs font-semibold uppercase text-terminal-emerald">Option Decode</p>
            <h1 className="mt-1 text-2xl font-semibold text-terminal-text sm:text-3xl">Decode Market Pressure Before You Trade</h1>
          </div>
          <div className="flex items-center gap-2">
            <a className="relative grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-panel text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" aria-label="Notifications" href={buildViewHref("alerts", currentParams)} onClick={(event) => {
              event.preventDefault();
              handleViewChange("alerts");
            }}>
              <Bell size={18} />
              {initialOverview.alerts.length ? <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-terminal-red px-1 text-[0.65rem] font-semibold text-white">{initialOverview.alerts.length}</span> : null}
            </a>
            <a className="rounded border border-terminal-line bg-terminal-panel px-4 py-2 text-sm font-semibold text-terminal-text transition hover:border-terminal-blue" href={buildViewHref("account", currentParams)} onClick={(event) => {
              event.preventDefault();
              handleViewChange("account");
            }}>
              Account
            </a>
            <button className="inline-flex min-h-10 items-center gap-2 rounded border border-terminal-red/60 bg-terminal-panel px-4 py-2 text-sm font-semibold text-terminal-red transition hover:bg-terminal-red hover:text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={isLoggingOut} type="button" onClick={handleLogout}>
              <LogOut size={16} />
              {isLoggingOut ? "Logging out..." : "Logout"}
            </button>
          </div>
        </header>

        <nav className="mt-3 flex gap-2 overflow-x-auto border-b border-terminal-line pb-3 text-sm text-terminal-muted lg:hidden" aria-label="Mobile sections">
          {navItems.map(([view, label, Icon]) => (
            <a key={view} className={`flex shrink-0 items-center gap-2 rounded border px-3 py-2 transition ${activeView === view ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line bg-terminal-panel hover:border-terminal-blue hover:text-terminal-text"}`} href={buildViewHref(view, currentParams)} onClick={(event) => {
              event.preventDefault();
              handleViewChange(view);
            }}>
              <Icon size={16} />
              <span>{label}</span>
              {view === "alerts" && initialOverview.alerts.length ? <span className="rounded-full bg-terminal-red px-1.5 py-0.5 text-[0.65rem] font-semibold text-white">{initialOverview.alerts.length}</span> : null}
            </a>
          ))}
        </nav>

        <div className="grid min-h-0 flex-1 gap-4 py-3 lg:grid-cols-[14.5rem_minmax(0,1fr)] xl:grid-cols-[15.5rem_minmax(0,1fr)]">
          <aside className="hidden min-h-0 border-r border-terminal-line pr-3 lg:block">
            <nav className="sticky top-3 space-y-1 text-sm text-terminal-muted">{nav}</nav>
          </aside>

          <LiveDashboard initialOverview={initialOverview} initialParams={currentParams} initialView={activeView} onAuthUserChange={setAuthUser} onMarketSelectionChange={handleMarketSelectionChange} onNavigateToView={handleViewChange} />
        </div>
      </section>
    </main>
  );
}

function buildViewHref(view: DashboardView, params?: { underlying?: string; expiry?: string }) {
  const search = new URLSearchParams({ view });
  if (params?.underlying) {
    search.set("underlying", params.underlying);
  }
  if (params?.expiry) {
    search.set("expiry", params.expiry);
  }
  return `/app?${search.toString()}`;
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

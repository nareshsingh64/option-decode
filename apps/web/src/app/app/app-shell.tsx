"use client";

import { Activity, Bell, CandlestickChart, LogOut, Play, Settings, ShieldCheck, UserCircle, WalletCards } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LiveDashboard } from "../../components/live-dashboard";
import type { AuthUser, DashboardView, MarketOverview } from "../../components/live-dashboard";

const protectedNavItems: Array<[DashboardView, string, LucideIcon]> = [
  ["dashboard", "Dashboard", Activity],
  ["option-chain", "Option Chain", CandlestickChart],
  ["pressure", "Pressure Engine", ShieldCheck],
  ["replay", "Replay Lab", Play],
  ["paper", "Paper Trading", WalletCards],
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
  const [fitScreenMode, setFitScreenMode] = useState(false);
  const navItems = useMemo(() => protectedNavItems.filter(([view]) => view !== "admin" || authUser?.role === "ADMIN"), [authUser?.role]);

  useEffect(() => {
    setActiveView(requestedView);
  }, [requestedView]);

  useEffect(() => {
    setCurrentParams(initialParams);
  }, [initialParams]);

  useEffect(() => {
    try {
      setFitScreenMode(window.localStorage.getItem("option-decode-fit-screen") === "true");
    } catch {
      setFitScreenMode(false);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("option-decode-fit-screen", String(fitScreenMode));
    } catch {
      // Ignore storage failures; the in-memory toggle still works for this session.
    }
  }, [fitScreenMode]);

  const handleViewChange = useCallback((view: DashboardView) => {
    setActiveView(view);
    window.history.pushState(null, "", buildViewHref(view, currentParams));
  }, [currentParams]);

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
    <main className={fitScreenMode ? "h-screen overflow-hidden" : "min-h-screen"}>
      <section className={`flex w-full flex-col px-3 sm:px-4 lg:px-5 ${fitScreenMode ? "h-screen overflow-hidden py-2" : "min-h-screen py-3"}`}>
        <header className={`flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-terminal-line/80 ${fitScreenMode ? "pb-2" : "pb-3"}`}>
          <div>
            <p className="text-xs font-semibold uppercase text-terminal-emerald">Option Decode</p>
            <h1 className={`${fitScreenMode ? "mt-0.5 text-xl" : "mt-1 text-2xl sm:text-3xl"} font-semibold text-terminal-text`}>Decode Market Pressure Before You Trade</h1>
          </div>
          <div className="flex items-center gap-2">
            <button className={`min-h-10 rounded border px-3 py-2 text-sm font-semibold transition ${fitScreenMode ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line bg-terminal-panel text-terminal-muted hover:border-terminal-blue hover:text-terminal-text"}`} type="button" onClick={() => setFitScreenMode((enabled) => !enabled)}>
              Fit Screen
            </button>
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

        <nav className={`${fitScreenMode ? "mt-2 pb-2" : "mt-3 pb-3"} flex shrink-0 gap-2 overflow-x-auto border-b border-terminal-line text-sm text-terminal-muted lg:hidden`} aria-label="Mobile sections">
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

        <div className={`grid min-h-0 flex-1 gap-4 ${fitScreenMode ? "overflow-hidden py-2" : "py-3"} lg:grid-cols-[14.5rem_minmax(0,1fr)] xl:grid-cols-[15.5rem_minmax(0,1fr)]`}>
          <aside className="hidden min-h-0 border-r border-terminal-line pr-3 lg:block">
            <nav className="sticky top-3 space-y-1 text-sm text-terminal-muted">{nav}</nav>
          </aside>

          <LiveDashboard fitScreenMode={fitScreenMode} initialOverview={initialOverview} initialParams={currentParams} initialView={activeView} onAuthUserChange={setAuthUser} onFitScreenModeChange={setFitScreenMode} onMarketSelectionChange={handleMarketSelectionChange} />
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

import { Activity, Bell, CandlestickChart, Play, Settings, ShieldCheck, UserCircle, WalletCards } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { LiveDashboard } from "../../components/live-dashboard";
import type { DashboardView, MarketOverview } from "../../components/live-dashboard";

const navItems: Array<[DashboardView, string, LucideIcon]> = [
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

interface AppPageProps {
  searchParams?: Promise<{
    underlying?: string;
    expiry?: string;
    view?: string;
    auth?: string;
  }>;
}

export default async function AppPage({ searchParams }: AppPageProps) {
  const params = await searchParams;
  const overview = await getMarketOverview(params);
  const activeView = normalizeView(params?.view);

  return (
    <main className="min-h-screen">
      <section className="flex min-h-screen w-full flex-col px-3 py-3 sm:px-4 lg:px-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-terminal-line/80 pb-3">
          <div>
            <p className="text-xs font-semibold uppercase text-terminal-emerald">Option Decode</p>
            <h1 className="mt-1 text-2xl font-semibold text-terminal-text sm:text-3xl">Decode Market Pressure Before You Trade</h1>
          </div>
          <div className="flex items-center gap-2">
            <a className="relative grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-panel text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" aria-label="Notifications" href={buildViewHref("alerts", params)}>
              <Bell size={18} />
              {overview.alerts.length ? <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-terminal-red px-1 text-[0.65rem] font-semibold text-white">{overview.alerts.length}</span> : null}
            </a>
            <a className="rounded border border-terminal-emerald bg-terminal-emerald px-4 py-2 text-sm font-semibold text-terminal-bg transition hover:opacity-90" href="/app?view=account&auth=register">
              Start Free Trial
            </a>
          </div>
        </header>

        <nav className="mt-3 flex gap-2 overflow-x-auto border-b border-terminal-line pb-3 text-sm text-terminal-muted lg:hidden" aria-label="Mobile sections">
          {navItems.map(([view, label, Icon]) => (
            <a key={view} className={`flex shrink-0 items-center gap-2 rounded border px-3 py-2 transition ${activeView === view ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line bg-terminal-panel hover:border-terminal-blue hover:text-terminal-text"}`} href={buildViewHref(view, params)}>
              <Icon size={16} />
              <span>{label}</span>
              {view === "alerts" && overview.alerts.length ? <span className="rounded-full bg-terminal-red px-1.5 py-0.5 text-[0.65rem] font-semibold text-white">{overview.alerts.length}</span> : null}
            </a>
          ))}
        </nav>

        <div className="grid min-h-0 flex-1 gap-4 py-3 lg:grid-cols-[14.5rem_minmax(0,1fr)] xl:grid-cols-[15.5rem_minmax(0,1fr)]">
          <aside className="hidden min-h-0 border-r border-terminal-line pr-3 lg:block">
            <nav className="sticky top-3 space-y-1 text-sm text-terminal-muted">
              {navItems.map(([view, label, Icon]) => (
                <a key={view} className={`flex min-h-10 items-center gap-3 rounded px-3 py-2 transition hover:bg-white/5 hover:text-terminal-text ${activeView === view ? "bg-terminal-blue/15 text-terminal-blue" : ""}`} href={buildViewHref(view, params)}>
                  <Icon size={17} />
                  <span className="flex-1">{label}</span>
                  {view === "alerts" && overview.alerts.length ? <span className="rounded-full bg-terminal-red px-2 py-0.5 text-[0.65rem] font-semibold text-white">{overview.alerts.length}</span> : null}
                </a>
              ))}
            </nav>
          </aside>

          <LiveDashboard initialOverview={overview} initialParams={params} initialView={activeView} />
        </div>
      </section>
    </main>
  );
}

function normalizeView(value?: string): DashboardView {
  const views: DashboardView[] = ["dashboard", "option-chain", "pressure", "replay", "paper", "alerts", "account", "admin", "settings"];
  return views.includes(value as DashboardView) ? (value as DashboardView) : "dashboard";
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

async function getMarketOverview(params?: { underlying?: string; expiry?: string }): Promise<MarketOverview> {
  const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const search = new URLSearchParams();
  if (params?.underlying) {
    search.set("underlying", params.underlying);
  }
  if (params?.expiry) {
    search.set("expiry", params.expiry);
  }
  const query = search.size ? `?${search.toString()}` : "";
  const response = await fetch(`${apiUrl}/api/market/overview${query}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Market overview failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<MarketOverview>;
}

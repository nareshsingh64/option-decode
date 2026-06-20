import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "./app-shell";
import type { AuthUser, DashboardView, MarketOverview } from "../../components/live-dashboard";

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
  const authUser = await getAuthUser();
  if (!authUser) {
    redirect("/login");
  }

  const overview = await getMarketOverview(params);
  const requestedView = normalizeView(params?.view);

  return <AppShell initialOverview={overview} initialAuthUser={authUser} initialParams={params} requestedView={requestedView} />;
}

function normalizeView(value?: string): DashboardView {
  const views: DashboardView[] = ["dashboard", "option-chain", "pressure", "replay", "paper", "alerts", "account", "admin", "settings"];
  return views.includes(value as DashboardView) ? (value as DashboardView) : "dashboard";
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

async function getAuthUser(): Promise<AuthUser | null> {
  const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiUrl}/api/auth/me`, {
    cache: "no-store",
    headers: cookieHeader ? { cookie: cookieHeader } : undefined
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { user: AuthUser | null };
  return payload.user;
}

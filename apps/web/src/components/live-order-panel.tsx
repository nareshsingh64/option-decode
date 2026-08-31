"use client";

// Live Order panel - REAL orders on a REAL brokerage account.
//
// The UI's job here is different from Paper Trade Pro's. There, the interface
// helps you explore. Here it has to make the consequences unmissable and make
// an accidental order hard to place. Hence:
//
//   - The kill-switch state is the first thing rendered, not a footnote.
//   - Placement is TWO steps. Preview shows the real margin and the real
//     shortfall; only then does a confirm button appear, and it expires in 10s.
//   - Every rupee figure says which product type it is for, because MARGIN and
//     INTRADAY are different products even though they price the same.
//   - The token countdown is always visible. A position you cannot close
//     because your token lapsed is the worst outcome this module has.

import { useCallback, useEffect, useMemo, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface CredentialStatus {
  present: boolean;
  brokerClientId?: string;
  tokenExpiresAt?: string;
  hoursRemaining?: number;
  verifiedOk: boolean;
  renewable: boolean;
  canOpen: boolean;
  reason?: string;
}

interface FundLimit {
  availableBalance: number;
  withdrawableBalance: number;
  utilizedAmount: number;
  collateralAmount: number;
}

interface MarginLeg {
  securityId: string;
  optionType: "CE" | "PE";
  strikePrice: number;
  transactionType: "BUY" | "SELL";
  standaloneMargin: number;
  role: "RISK" | "HEDGE";
}

interface MarginView {
  asOf: string;
  productType: string;
  funds: FundLimit;
  requirement: { total: number; span: number | null; exposure: number | null; commodity: number | null; currency: string };
  hedge: { grossMargin: number; netMargin: number; benefitAmount: number; benefitPct: number; legs: MarginLeg[] };
  headroom: { free: number; utilizationPct: number; insufficientBalance: number; wouldBreach: boolean };
}

interface Preview {
  confirmToken: string;
  expiresAt: string;
  quantity: number;
  exchangeSegment: string;
  lotSize: number;
  notional: number;
  margin: MarginView;
  warnings: string[];
}

interface LiveSummary {
  enabled: boolean;
  credential: CredentialStatus;
  account: {
    id: string;
    brokerClientId: string;
    tradingEnabled: boolean;
    maxOrderMargin: number;
    maxOpenMargin: number;
    maxMarginUtilPct: number;
    allowUndefinedRisk: boolean;
  } | null;
  funds: FundLimit | null;
  orders: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
}

const rupees = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value)
    ? "--"
    : `₹${Math.round(value).toLocaleString("en-IN")}`;

export function LiveOrderPanel() {
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placeResult, setPlaceResult] = useState<string | null>(null);
  // Counts the confirm window down so the button cannot be pressed against a
  // preview whose prices have moved.
  const [secondsLeft, setSecondsLeft] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/live/summary`, { cache: "no-store", credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSummary((await response.json()) as LiveSummary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the live account.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 30s is fine for this panel today. The SSE delta channel described in
    // docs/live-order-module.md replaces this poll when it lands; do NOT keep
    // both, or the poll re-introduces the staleness the stream exists to fix.
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!preview) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((new Date(preview.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) setPreview(null);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [preview]);

  const credential = summary?.credential;
  const account = summary?.account;

  const gateMessage = useMemo(() => {
    if (!summary) return null;
    if (!summary.enabled) return "Live trading is disabled on this deployment (LIVE_TRADING_ENABLED=false).";
    if (!credential?.present) return "No broker credential on file. Add your Dhan access token below.";
    if (!credential.verifiedOk) return "The stored token has never authenticated. Re-paste it.";
    if (!account) return "No live account yet.";
    if (!account.tradingEnabled) return "Live trading is not enabled on this account.";
    return null;
  }, [summary, credential, account]);

  const confirmPlace = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/live/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirmToken: preview.confirmToken })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      setPlaceResult(`Placed ${body.orders?.length ?? 0} order(s). Group ${String(body.groupId ?? "").slice(0, 8)}.`);
      setPreview(null);
      await refresh();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Placement failed.");
    } finally {
      setBusy(false);
    }
  }, [preview, refresh]);

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Live Orders</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            summary?.enabled && account?.tradingEnabled
              ? "bg-red-100 text-red-800"
              : "bg-slate-200 text-slate-700"
          }`}
        >
          {summary?.enabled && account?.tradingEnabled ? "LIVE — real money" : "DISABLED"}
        </span>
      </header>

      {error ? <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">{error}</p> : null}

      {gateMessage ? (
        <p className="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">{gateMessage}</p>
      ) : null}

      {/* Token life. Always visible, because a lapsed token means you cannot
          close a position, not merely that you cannot open one. */}
      {credential?.present ? (
        <div className="rounded border border-slate-200 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span>
              Dhan client <strong>{credential.brokerClientId}</strong>
            </span>
            <span className={credential.canOpen ? "text-slate-700" : "text-red-700"}>
              Token: {credential.hoursRemaining === undefined ? "unknown expiry" : `${credential.hoursRemaining.toFixed(1)}h left`}
              {credential.renewable ? " · renewable" : " · NOT renewable"}
            </span>
          </div>
          {credential.reason ? <p className="mt-1 text-xs text-red-700">{credential.reason}</p> : null}
        </div>
      ) : null}

      {summary?.funds ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Available" value={rupees(summary.funds.availableBalance)} />
          <Stat label="Utilised" value={rupees(summary.funds.utilizedAmount)} />
          <Stat label="Withdrawable" value={rupees(summary.funds.withdrawableBalance)} />
          <Stat label="Per-order cap" value={rupees(account?.maxOrderMargin)} />
        </div>
      ) : null}

      {/* Preview -> confirm. The confirm button only exists once a preview has
          returned, and it disappears when the 10s window closes. */}
      {previewError ? <p className="rounded bg-red-50 p-2 text-sm text-red-800">{previewError}</p> : null}
      {placeResult ? <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-900">{placeResult}</p> : null}

      {preview ? (
        <div className="space-y-2 rounded border-2 border-amber-400 bg-amber-50 p-3">
          <h3 className="text-sm font-semibold text-amber-900">Confirm — this places a real order</h3>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Stat label={`Margin (${preview.margin.productType})`} value={rupees(preview.margin.requirement.total)} />
            <Stat label="Hedge benefit" value={rupees(preview.margin.hedge.benefitAmount)} />
            <Stat label="Utilisation" value={`${preview.margin.headroom.utilizationPct.toFixed(0)}%`} />
            <Stat label="Quantity sent" value={`${preview.quantity} (${preview.exchangeSegment === "MCX_COMM" ? "lots" : "contracts"})`} />
          </div>
          {preview.warnings.map((warning) => (
            <p key={warning} className="text-xs text-amber-900">
              {warning}
            </p>
          ))}
          <button
            type="button"
            disabled={busy || secondsLeft === 0}
            onClick={() => void confirmPlace()}
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Placing…" : `Place real order (${secondsLeft}s)`}
          </button>
        </div>
      ) : null}

      {/* The gate message above tells the user to add a token "below", so the
          form has to actually be here. It was not, until a run through the real
          UI caught the panel promising something it did not provide. */}
      {!credential?.present ? <CredentialForm onSaved={refresh} /> : null}

      <OpenPositions positions={summary?.positions ?? []} />
      <RecentOrders orders={summary?.orders ?? []} />

      {/* Stated plainly rather than hidden: the ticket builder is not built.
          /api/live/preview and /api/live/orders both work, but nothing in this
          panel composes a basket yet, so an order cannot be placed from here. */}
      <p className="rounded border border-dashed border-slate-300 p-2 text-xs text-slate-600">
        Order entry is not built yet. This panel shows account state, positions and orders; composing a
        basket still has to come from the Strike Matrix hand-off (see docs/live-order-module.md, phase 2).
      </p>

      <p className="text-xs text-slate-500">
        Margin figures come from Dhan&apos;s calculator and are estimates: the exchange revalues SPAN six times a
        trading day. Treat them as ±20%.
      </p>
    </section>
  );
}

function CredentialForm({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/live/credential`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ brokerClientId: clientId.trim(), accessToken: token.trim() })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      // Clear immediately on success. The token is verified and encrypted
      // server-side; there is no reason for it to linger in component state.
      setToken("");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the credential.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded border border-slate-300 p-3">
      <h3 className="text-sm font-semibold">Add your Dhan access token</h3>
      <p className="text-xs text-slate-600">
        Verified against Dhan before it is stored, then encrypted at rest. It is never returned by any
        endpoint, logged, or emailed. Tokens live 24 hours and an expired one cannot be renewed — only
        regenerated at web.dhan.co.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="text-slate-500">Dhan client id</span>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="1100000001"
            autoComplete="off"
          />
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Access token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="eyJ0eXAiOi…"
            autoComplete="off"
          />
        </label>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
      <button
        type="button"
        disabled={busy || !clientId.trim() || !token.trim()}
        onClick={() => void submit()}
        className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Verifying with Dhan…" : "Verify and save"}
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="rounded border border-slate-200 p-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm font-semibold">{value ?? "--"}</div>
    </div>
  );
}

function OpenPositions({ positions }: { positions: Array<Record<string, unknown>> }) {
  if (!positions.length) {
    return <p className="text-sm text-slate-500">No open live positions.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-slate-500">
            <th className="py-1">Symbol</th>
            <th>Net qty</th>
            <th>Avg cost</th>
            <th>Unrealised</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={String(position.id)} className="border-t border-slate-100">
              <td className="py-1">{String(position.tradingSymbol ?? position.securityId)}</td>
              <td>{String(position.netQty)}</td>
              <td>{rupees(position.avgCostPrice as number)}</td>
              <td className={Number(position.unrealizedPnl) < 0 ? "text-red-700" : "text-emerald-700"}>
                {rupees(position.unrealizedPnl as number)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentOrders({ orders }: { orders: Array<Record<string, unknown>> }) {
  if (!orders.length) {
    return <p className="text-sm text-slate-500">No live orders yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-slate-500">
            <th className="py-1">Contract</th>
            <th>Side</th>
            <th>Lots</th>
            <th>Price</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.slice(0, 15).map((order) => (
            <tr key={String(order.id)} className="border-t border-slate-100">
              <td className="py-1">
                {String(order.underlyingSymbol)} {String(order.strikePrice)} {String(order.optionType)}
              </td>
              <td>{String(order.transactionType)}</td>
              <td>{String(order.lots)}</td>
              <td>{rupees(order.price as number)}</td>
              <td>
                {/* UNKNOWN is shown in red on purpose. It means we do not know
                    whether the order exists, which needs a human, and it must
                    never look like an ordinary resting state. */}
                <span className={String(order.status) === "UNKNOWN" ? "font-semibold text-red-700" : ""}>
                  {String(order.status)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

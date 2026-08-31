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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

interface ChainStrike {
  optionType: "CE" | "PE";
  strikePrice: number;
  securityId: string;
  lastPrice: number;
  openInterest: number | null;
  tradeable: boolean;
  reason?: string;
}

type LegTemplate = { side: "BUY" | "SELL"; optionType: "CE" | "PE"; label: string };

// Only DEFINED-RISK structures are offered. Undefined-risk ones are blocked
// server-side by LiveAccount.allowUndefinedRisk anyway - a one-lot naked index
// short needs more margin than the measured account balance - so offering them
// would just be a menu of things that get rejected.
const STRUCTURES: Record<string, LegTemplate[]> = {
  BEAR_CALL_SPREAD: [
    { side: "SELL", optionType: "CE", label: "Short call" },
    { side: "BUY", optionType: "CE", label: "Long call (wing)" }
  ],
  BULL_PUT_SPREAD: [
    { side: "SELL", optionType: "PE", label: "Short put" },
    { side: "BUY", optionType: "PE", label: "Long put (wing)" }
  ],
  IRON_CONDOR: [
    { side: "SELL", optionType: "PE", label: "Short put" },
    { side: "BUY", optionType: "PE", label: "Long put (wing)" },
    { side: "SELL", optionType: "CE", label: "Short call" },
    { side: "BUY", optionType: "CE", label: "Long call (wing)" }
  ],
  IRON_BUTTERFLY: [
    { side: "SELL", optionType: "PE", label: "Short put (ATM)" },
    { side: "BUY", optionType: "PE", label: "Long put (wing)" },
    { side: "SELL", optionType: "CE", label: "Short call (ATM)" },
    { side: "BUY", optionType: "CE", label: "Long call (wing)" }
  ]
};

// Which states the broker will still accept a change or a cancel for. Anything
// else - TRADED, REJECTED, CANCELLED - is finished, and offering a control that
// can only fail is worse than offering none. Module scope so the Orders tab
// badge and the row buttons cannot drift apart on what "working" means.
const WORKING_STATES = new Set(["SENT", "OPEN", "PARTIAL"]);

const rupees = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value)
    ? "--"
    : `₹${Math.round(value).toLocaleString("en-IN")}`;

export function LiveOrderPanel({ underlyingSymbol, expiryLabel }: { underlyingSymbol?: string; expiryLabel?: string }) {
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placeResult, setPlaceResult] = useState<string | null>(null);
  // Counts the confirm window down so the button cannot be pressed against a
  // preview whose prices have moved.
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [tab, setTab] = useState<"positions" | "orders" | "place" | "token">("positions");

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

  // 1 second. Affordable only because /api/live/summary no longer costs a broker
  // call per request: funds are cached for 10s server-side, and position marks
  // come from the worker's Redis tick cache, so a refresh is one DB read plus
  // one MGET. Do not raise this expecting fresher data - the mark is as fresh as
  // the feed, and the ORDER state is as fresh as the 20s reconciler.
  //
  // Paused while the tab is hidden. A background tab polling a live-money
  // endpoint once a second, all day, is pure waste - and browsers throttle it
  // unpredictably anyway, so the data would not even be reliable.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), 1_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
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

  // Only states the broker will still act on count as "working" for the badge.
  const workingOrderCount = (summary?.orders ?? []).filter((o) => WORKING_STATES.has(String(o.status))).length;

  const gateMessage = useMemo(() => {
    if (!summary) return null;
    if (!summary.enabled) return "Live trading is disabled on this deployment (LIVE_TRADING_ENABLED=false).";
    if (!credential?.present) return "No broker credential on file. Add your Dhan access token below.";
    if (!credential.verifiedOk) return "The stored token has never authenticated. Re-paste it.";
    if (!account) return "No live account yet.";
    if (!account.tradingEnabled) return "Live trading is not enabled on this account.";
    return null;
  }, [summary, credential, account]);

  // Completing a Dhan consent redirect must not depend on which tab is open.
  // It lived inside the credential form until the page gained tabs, at which
  // point the form stopped being mounted most of the time - and a redirect that
  // lands on the Positions tab would have been silently dropped.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenId = params.get("tokenId");
    const state = params.get("state");
    if (!tokenId || !state) return;
    setTab("token");
    void (async () => {
      try {
        const response = await fetch(`${API_URL}/api/live/credential/consume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ tokenId, state })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not complete the Dhan login.");
      } finally {
        // Strip the single-use exchange code out of the address bar whatever
        // happened - it is spent, and leaving it in history is gratuitous.
        params.delete("tokenId");
        params.delete("state");
        const query = params.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }
    })();
  }, [refresh]);

  const runPreview = useCallback(async (ticket: unknown) => {
    setBusy(true);
    setPreviewError(null);
    setPlaceResult(null);
    try {
      const response = await fetch(`${API_URL}/api/live/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(ticket)
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      setPreview(body as Preview);
    } catch (err) {
      setPreview(null);
      setPreviewError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }, []);

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

      {/* Token life stays OUTSIDE the tabs. A lapsed token means you cannot
          close a position, not merely that you cannot open one, so it must be
          visible from whichever tab the trader happens to be on. */}
      {/* Token life and funds on ONE line rather than a card plus a four-card
          grid. Both still sit outside the tabs - a lapsed token means you
          cannot CLOSE a position - but they are reference numbers, not the
          thing being watched, and they were taking three rows to say it. */}
      {credential?.present || summary?.funds ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded border border-slate-200 px-3 py-1.5 text-xs">
          {credential?.present ? (
            <>
              <span className="text-slate-500">
                Dhan <strong className="text-slate-800">{credential.brokerClientId}</strong>
              </span>
              <span className={credential.canOpen ? "text-slate-600" : "font-semibold text-red-700"}>
                token{" "}
                {credential.hoursRemaining === undefined ? "expiry unknown" : `${credential.hoursRemaining.toFixed(1)}h`}
                {credential.renewable ? "" : " · not renewable"}
              </span>
            </>
          ) : null}
          {summary?.funds ? (
            <>
              <span className="text-slate-500">
                available <strong className="text-slate-800">{rupees(summary.funds.availableBalance)}</strong>
              </span>
              <span className="text-slate-500">used {rupees(summary.funds.utilizedAmount)}</span>
              <span className="text-slate-500">
                cap {account && account.maxOrderMargin > 0 ? rupees(account.maxOrderMargin) : "available margin"}
              </span>
            </>
          ) : null}
          {credential?.reason ? <span className="text-red-700">{credential.reason}</span> : null}
        </div>
      ) : null}

      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {([
          ["positions", `Positions${summary?.positions.length ? ` (${summary.positions.length})` : ""}`],
          ["orders", `Orders${workingOrderCount ? ` (${workingOrderCount})` : ""}`],
          ["place", "Place order"],
          ["token", "Broker token"]
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              tab === key
                ? "border-slate-800 font-semibold text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* The preview/confirm block sits above the tabs on purpose. Once a
          preview exists it is a ten-second decision, and it must not be
          possible to navigate away from it by accident. */}
      {previewError ? <p className="rounded bg-red-50 p-2 text-sm text-red-800">{previewError}</p> : null}
      {placeResult ? <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-900">{placeResult}</p> : null}

      {preview ? (
        <div className="space-y-2 rounded border-2 border-amber-400 bg-amber-50 p-3">
          <h3 className="text-sm font-semibold text-amber-900">Confirm — this places a real order</h3>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Stat label={`Margin (${preview.margin.productType})`} value={rupees(preview.margin.requirement.total)} />
            <Stat label="Hedge benefit" value={rupees(preview.margin.hedge.benefitAmount)} />
            <Stat label="Utilisation" value={`${preview.margin.headroom.utilizationPct.toFixed(0)}%`} />
            <Stat
              label="Quantity sent"
              value={`${preview.quantity} (${preview.exchangeSegment === "MCX_COMM" ? "lots" : "contracts"})`}
            />
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

      {tab === "positions" ? <OpenPositions positions={summary?.positions ?? []} /> : null}

      {tab === "orders" ? <RecentOrders orders={summary?.orders ?? []} onChanged={refresh} /> : null}

      {tab === "place" ? (
        gateMessage ? (
          <p className="text-sm text-slate-600">Order entry opens once the account is ready — see Broker token.</p>
        ) : underlyingSymbol && expiryLabel ? (
          <TicketBuilder
            underlyingSymbol={underlyingSymbol}
            expiryLabel={expiryLabel}
            busy={busy}
            onPreview={runPreview}
          />
        ) : (
          <p className="text-sm text-slate-600">Pick an underlying and expiry in Market Controls above.</p>
        )
      ) : null}

      {tab === "token" ? <CredentialForm onSaved={refresh} hasCredential={Boolean(credential?.present)} /> : null}

      <p className="text-xs text-slate-500">
        Margin figures come from Dhan&apos;s calculator and are estimates: the exchange revalues SPAN six times a
        trading day. Treat them as ±20%.
      </p>
    </section>
  );
}

function TicketBuilder({
  underlyingSymbol,
  expiryLabel,
  busy,
  onPreview
}: {
  underlyingSymbol: string;
  expiryLabel: string;
  busy: boolean;
  onPreview: (ticket: unknown) => Promise<void>;
}) {
  const [structure, setStructure] = useState<string>("BEAR_CALL_SPREAD");
  const [lots, setLots] = useState(1);
  const [strikes, setStrikes] = useState<Record<number, number | "">>({});
  const [chain, setChain] = useState<ChainStrike[]>([]);
  const [chainError, setChainError] = useState<string | null>(null);

  const template = STRUCTURES[structure] ?? [];

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const url = `${API_URL}/api/live/chain?underlying=${encodeURIComponent(underlyingSymbol)}&expiry=${encodeURIComponent(expiryLabel)}`;
        const response = await fetch(url, { credentials: "include", cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
        if (!cancelled) {
          setChain((body.strikes ?? []) as ChainStrike[]);
          setChainError(null);
        }
      } catch (err) {
        if (!cancelled) setChainError(err instanceof Error ? err.message : "Could not load the chain.");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [underlyingSymbol, expiryLabel]);

  // Changing structure invalidates the strikes: a bear call spread's picks are
  // meaningless as an iron condor's.
  useEffect(() => setStrikes({}), [structure]);

  const optionsFor = (optionType: "CE" | "PE") =>
    chain.filter((row) => row.optionType === optionType).sort((a, b) => a.strikePrice - b.strikePrice);

  const complete = template.length > 0 && template.every((_, index) => Number(strikes[index]) > 0);

  const submit = () => {
    const legs = template.map((leg, index) => ({
      side: leg.side,
      optionType: leg.optionType,
      strikePrice: Number(strikes[index])
    }));
    // securityId and price are deliberately absent - the server resolves the
    // contract from the strike. See legSchema in apps/api/src/live-routes.ts.
    void onPreview({ underlyingSymbol, expiryLabel, structure, lots, legs });
  };

  return (
    <div className="space-y-3 rounded border border-slate-300 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-slate-500">Structure</span>
          <select
            value={structure}
            onChange={(event) => setStructure(event.target.value)}
            className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm"
          >
            {Object.keys(STRUCTURES).map((key) => (
              <option key={key} value={key}>
                {key.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Lots</span>
          <input
            type="number"
            min={1}
            value={lots}
            onChange={(event) => setLots(Math.max(1, Number(event.target.value) || 1))}
            className="mt-1 block w-20 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <span className="text-xs text-slate-500">
          {underlyingSymbol} · {expiryLabel}
        </span>
      </div>

      {chainError ? <p className="text-xs text-red-700">{chainError}</p> : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {template.map((leg, index) => (
          <label key={`${leg.side}-${leg.optionType}-${index}`} className="text-xs">
            <span className="text-slate-500">
              {leg.label} · {leg.side} {leg.optionType}
            </span>
            <select
              value={strikes[index] ?? ""}
              onChange={(event) =>
                setStrikes((prev) => ({ ...prev, [index]: event.target.value ? Number(event.target.value) : "" }))
              }
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">Select strike…</option>
              {optionsFor(leg.optionType).map((row) => (
                // Untradeable strikes are shown but disabled, with the reason.
                // Hiding them would leave the trader wondering where a strike
                // went; the server would refuse it anyway.
                <option key={row.strikePrice} value={row.strikePrice} disabled={!row.tradeable}>
                  {row.strikePrice} · ₹{row.lastPrice}
                  {row.tradeable ? "" : ` — ${row.reason}`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <button
        type="button"
        disabled={busy || !complete}
        onClick={submit}
        className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Pricing…" : "Preview margin"}
      </button>
      <p className="text-xs text-slate-500">
        Preview prices the basket and runs every cap. Nothing reaches the broker until you confirm, and the
        confirmation expires after 10 seconds.
      </p>
    </div>
  );
}

function CredentialForm({
  onSaved,
  hasCredential
}: {
  onSaved: () => Promise<void> | void;
  hasCredential: boolean;
}) {
  // Collapsed by default once a credential exists, so the panel is not
  // dominated by a form most of the time - but one click away, every day.
  const [open, setOpen] = useState(!hasCredential);
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partnerLogin, setPartnerLogin] = useState(false);

  // Which credential paths this deployment actually supports. Asked of the
  // server because it depends on partner config the browser cannot see.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${API_URL}/api/live/credential/options`, { credentials: "include" });
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled) setPartnerLogin(Boolean(body.partnerLogin));
      } catch {
        // Falls back to the manual paste form, which always works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startPartnerLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/live/credential/consent`, {
        method: "POST",
        credentials: "include"
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      // Full navigation, not a popup: Dhan's login is a 2FA flow and popup
      // blockers are a bad place to discover that.
      window.location.href = body.loginUrl as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the Dhan login.");
      setBusy(false);
    }
  };

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

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/live/credential`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  if (hasCredential && !open) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded border border-slate-200 p-2 text-xs">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded border border-slate-400 px-2 py-1 font-medium"
        >
          Replace access token
        </button>
        <button type="button" disabled={busy} onClick={() => void disconnect()} className="text-red-700 underline">
          Disconnect broker
        </button>
        <span className="text-slate-500">
          Tokens expire every 24h, and must be regenerated after any change to Dhan&apos;s IP allowlist.
        </span>
        {error ? <span className="text-red-700">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded border border-slate-300 p-3">
      {hasCredential ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-600">
            Replacing the stored token. The new one is verified against Dhan before it overwrites the old.
          </p>
          <button type="button" onClick={() => setOpen(false)} className="text-xs underline">
            Cancel
          </button>
        </div>
      ) : null}

      {partnerLogin ? (
        <div className="space-y-2 border-b border-slate-200 pb-3">
          <h3 className="text-sm font-semibold">Connect your Dhan account</h3>
          <p className="text-xs text-slate-600">
            You sign in on Dhan&apos;s own page with your usual 2FA. We never see your password, and your
            client id comes back automatically. Note a token connected this way cannot be auto-renewed —
            Dhan only renews tokens minted from Dhan Web — so you will reconnect roughly daily.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void startPartnerLogin()}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Opening Dhan…" : "Connect with Dhan"}
          </button>
        </div>
      ) : null}

      <h3 className="text-sm font-semibold">
        {partnerLogin ? "Or paste an access token" : "Add your Dhan access token"}
      </h3>
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
  // Last seen price per position, and the direction of the last CHANGE.
  //
  // The direction is remembered rather than recomputed from "is this render's
  // price different from the previous one", because at a 1-second poll most
  // refreshes return the same price - so a naive comparison would flash the
  // colour off between ticks. Holding the last real move means green stays
  // green until the price actually falls.
  //
  // A ref, not state: this must not itself trigger a render, and it is read
  // during render purely to colour a cell.
  const marks = useRef(new Map<string, { price: number; dir: "up" | "down" | "flat" }>());

  if (!positions.length) {
    marks.current.clear();
    return <p className="text-sm text-slate-500">No open live positions.</p>;
  }

  // Realised and unrealised together: a position partly closed during the day
  // has both, and showing only the unrealised half understates what the day
  // actually did.
  const net = positions.reduce(
    (sum, p) => sum + Number(p.unrealizedPnl ?? 0) + Number(p.realizedPnl ?? 0),
    0
  );

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 rounded border border-slate-200 p-2">
        <span className="text-xs uppercase text-slate-500">Net P&amp;L (realised + unrealised)</span>
        <span className={`text-lg font-semibold ${net < 0 ? "text-red-700" : "text-emerald-700"}`}>
          {net < 0 ? "-" : "+"}
          {rupees(Math.abs(net))}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500">
              <th className="py-1 pr-2">S/B</th>
              <th>Contract</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Avg cost</th>
              <th className="text-right">LTP</th>
              <th className="text-right">Unrealised</th>
              <th className="text-right">Realised</th>
              <th className="text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              // netQty carries the direction: negative is short. Deriving the
              // marker from the sign rather than from a stored side means it
              // cannot disagree with the quantity beside it.
              const qty = Number(position.netQty ?? 0);
              const isShort = qty < 0;
              const rowNet = Number(position.unrealizedPnl ?? 0) + Number(position.realizedPnl ?? 0);

              const id = String(position.id);
              const ltp = position.lastPrice === null || position.lastPrice === undefined ? null : Number(position.lastPrice);
              const previous = marks.current.get(id);
              let dir: "up" | "down" | "flat" = previous?.dir ?? "flat";
              if (ltp !== null && previous && ltp !== previous.price) {
                dir = ltp > previous.price ? "up" : "down";
              }
              if (ltp !== null) marks.current.set(id, { price: ltp, dir });
              // markSource says whether this came from the live feed or from
              // Dhan's slower reconciled figure - worth surfacing, because a
              // stale mark and a live one look identical otherwise.
              const live = position.markSource === "LIVE_FEED";
              return (
                <tr key={String(position.id)} className="border-t border-slate-100">
                  <td className="py-1 pr-2">
                    <span
                      className={`font-bold ${isShort ? "text-red-700" : "text-emerald-700"}`}
                      title={isShort ? "Short - sold to open" : "Long - bought to open"}
                    >
                      {isShort ? "S" : "B"}
                    </span>
                  </td>
                  <td>{String(position.tradingSymbol ?? position.securityId)}</td>
                  <td className="text-right">{Math.abs(qty)}</td>
                  <td className="text-right">{rupees(position.avgCostPrice as number)}</td>
                  <td
                    className={`text-right tabular-nums font-medium ${
                      dir === "up" ? "text-emerald-700" : dir === "down" ? "text-red-700" : "text-slate-700"
                    }`}
                    title={
                      ltp === null
                        ? "No price yet"
                        : live
                          ? "Live from the Dhan feed"
                          : "From the last reconcile - the feed has nothing fresh for this contract"
                    }
                  >
                    {ltp === null ? "--" : ltp.toFixed(2)}
                    {dir === "up" ? " \u25b2" : dir === "down" ? " \u25bc" : ""}
                    {ltp !== null && !live ? <span className="text-slate-400"> *</span> : null}
                  </td>
                  <td className={`text-right ${Number(position.unrealizedPnl ?? 0) < 0 ? "text-red-700" : "text-emerald-700"}`}>
                    {rupees(position.unrealizedPnl as number)}
                  </td>
                  <td className="text-right">{rupees(position.realizedPnl as number)}</td>
                  <td className={`text-right font-medium ${rowNet < 0 ? "text-red-700" : "text-emerald-700"}`}>
                    {rupees(rowNet)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        LTP updates every second from the Dhan feed; an asterisk means the feed has nothing fresh for that
        contract and the price is from the last reconcile. Positions themselves come from Dhan and are
        refreshed every 20s, including any held on this account but not opened through this app.
      </p>
    </div>
  );
}

function RecentOrders({
  orders,
  onChanged
}: {
  orders: Array<Record<string, unknown>>;
  onChanged: () => Promise<void> | void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, run: () => Promise<Response>) => {
    setBusyId(id);
    setError(null);
    try {
      const response = await run();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusyId(null);
    }
  };

  const cancel = (id: string) =>
    act(id, () => fetch(`${API_URL}/api/live/orders/${id}`, { method: "DELETE", credentials: "include" }));

  const reprice = (id: string, current: number) => {
    const raw = window.prompt("New limit price", String(current));
    if (raw === null) return;
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      setError("That is not a valid price.");
      return;
    }
    void act(id, () =>
      fetch(`${API_URL}/api/live/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ price })
      })
    );
  };

  if (!orders.length) {
    return <p className="text-sm text-slate-500">No live orders yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      {error ? <p className="mb-1 text-xs text-red-700">{error}</p> : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-slate-500">
            <th className="py-1">Contract</th>
            <th>Side</th>
            <th>Lots</th>
            <th>Price</th>
            <th>Filled</th>
            <th>Status</th>
            <th />
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
                {String(order.filledQty ?? 0)}/{String(order.quantity ?? 0)}
                {order.avgFillPrice ? ` @ ${rupees(order.avgFillPrice as number)}` : ""}
              </td>
              <td>
                {/* UNKNOWN is shown in red on purpose. It means we do not know
                    whether the order exists, which needs a human, and it must
                    never look like an ordinary resting state. REJECTED is a
                    definite no and reads as ordinary. */}
                <span
                  className={
                    String(order.status) === "UNKNOWN"
                      ? "font-semibold text-red-700"
                      : String(order.status) === "REJECTED"
                        ? "text-slate-600"
                        : ""
                  }
                  title={order.rejectionReason ? String(order.rejectionReason) : undefined}
                >
                  {String(order.status)}
                </span>
              </td>
              <td className="whitespace-nowrap">
                {WORKING_STATES.has(String(order.status)) ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === String(order.id)}
                      onClick={() => reprice(String(order.id), Number(order.price ?? 0))}
                      className="mr-2 underline disabled:opacity-50"
                    >
                      Reprice
                    </button>
                    <button
                      type="button"
                      disabled={busyId === String(order.id)}
                      onClick={() => void cancel(String(order.id))}
                      className="text-red-700 underline disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

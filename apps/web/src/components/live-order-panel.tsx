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
  basketPriced?: boolean;
  funds: FundLimit;
  requirement: { total: number; span: number | null; exposure: number | null; commodity: number | null; currencyMargin: number | null };
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
    autoExitEnabled: boolean;
  } | null;
  funds: FundLimit | null;
  orders: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  closedToday?: Array<Record<string, unknown>>;
  exitAlerts?: Array<{ groupId: string; rule: string; action: string; detail: string | null; createdAt: string }>;
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
// Structures whose loss is unbounded. Offered only when the account carries
// allowUndefinedRisk, and named to match UNDEFINED_RISK_STRUCTURES server-side
// so the UI and the server agree on what counts as naked.
const UNDEFINED_RISK_STRUCTURES: Record<string, LegTemplate[]> = {
  NAKED_CALL: [{ side: "SELL", optionType: "CE", label: "Short call (naked)" }],
  NAKED_PUT: [{ side: "SELL", optionType: "PE", label: "Short put (naked)" }],
  SHORT_STRANGLE: [
    { side: "SELL", optionType: "PE", label: "Short put (naked)" },
    { side: "SELL", optionType: "CE", label: "Short call (naked)" }
  ]
};

const STRUCTURES: Record<string, LegTemplate[]> = {
  // Single bought leg. Risk is the premium paid and nothing more, so these are
  // NOT caught by the naked-short block - that exists for unbounded loss, which
  // a long option cannot have. Worth being explicit, because "naked" reads as
  // dangerous and here means only "unhedged".
  LONG_CALL: [{ side: "BUY", optionType: "CE", label: "Long call" }],
  LONG_PUT: [{ side: "BUY", optionType: "PE", label: "Long put" }],
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

// Plain-English names for what is stored as a rule id. The raw value is kept
// in the tooltip so a support question can be answered with the exact string
// that is in the database, not a prettified version of it.
const EXIT_REASON_LABELS: Record<string, string> = {
  MANUAL: "Closed by you",
  PANIC: "Panic close",
  STOP: "Your stop was hit",
  EXTERNAL: "Closed outside this app",
  PROFIT_TARGET: "Profit target",
  HARD_STOP_3X: "Hard stop (3x credit)",
  DTE_GAMMA: "Gamma window",
  DELTA_2X: "Short leg delta doubled",
  PREMIUM_2X: "Short leg premium doubled",
  EXPIRY_TODAY: "Expiry day"
};

function ClosedToday({ positions }: { positions: Array<Record<string, unknown>> }) {
  if (!positions.length) {
    return <p className="text-sm text-slate-500">Nothing closed today.</p>;
  }

  // Realised only. An unrealised figure on a closed position is meaningless -
  // there is nothing left to mark.
  const realised = positions.reduce((sum, p) => sum + Number(p.realizedPnl ?? 0), 0);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 rounded border border-slate-200 p-2">
        <span className="text-xs uppercase text-slate-500">Realised today</span>
        <span className={`text-lg font-semibold ${realised < 0 ? "text-red-700" : "text-emerald-700"}`}>
          {realised < 0 ? "-" : "+"}
          {rupees(Math.abs(realised))}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500">
              {/* No S/B column: netQty is 0 once flat, so the direction is not
                  recoverable from the position row, and a column of dashes is
                  worse than no column. */}
              <th className="py-1">Contract</th>
              <th>Expiry</th>
              <th className="text-right">Avg cost</th>
              <th className="text-right">Realised</th>
              <th className="text-right">Entered</th>
              <th className="text-right">Exited</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              const closedAt = position.closedAt ? new Date(String(position.closedAt)) : null;
              const realisedRow = Number(position.realizedPnl ?? 0);
              const reason = position.exitReason ? String(position.exitReason) : null;
              const detail = position.exitDetail ? String(position.exitDetail) : null;
              // The full sentence on hover, the label under the contract. A
              // tooltip alone would hide the fact that a reason exists at all,
              // and nobody hovers over something that looks inert.
              const hover = reason ? (detail ? `${reason} - ${detail}` : reason) : "No exit reason was recorded.";
              return (
                <tr key={String(position.id)} className="border-t border-slate-100">
                  <td className="whitespace-nowrap py-1" title={hover}>
                    <span className="cursor-help underline decoration-dotted underline-offset-2">
                      {String(position.tradingSymbol ?? position.securityId)}
                    </span>
                    {reason ? (
                      <span className="ml-2 text-xs text-slate-500">{EXIT_REASON_LABELS[reason] ?? reason}</span>
                    ) : null}
                  </td>
                  <td className="text-slate-600">{position.expiryLabel ? String(position.expiryLabel) : "--"}</td>
                  <td className="text-right">{rupees(position.avgCostPrice as number)}</td>
                  <td className={`text-right font-medium ${realisedRow < 0 ? "text-red-700" : "text-emerald-700"}`}>
                    {rupees(realisedRow)}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs text-slate-500">
                    {istStamp(position.openedAt)}
                  </td>
                  <td className="whitespace-nowrap text-right text-xs text-slate-500">
                    {closedAt ? istStamp(position.closedAt) : "--"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Closed since midnight IST. Realised P&amp;L comes from Dhan; a position squared off outside this app
        appears here too, because the reconciler treats the broker as the source of truth.
      </p>
    </div>
  );
}

// Which states the broker will still accept a change or a cancel for. Anything
// else - TRADED, REJECTED, CANCELLED - is finished, and offering a control that
// can only fail is worse than offering none. Module scope so the Orders tab
// badge and the row buttons cannot drift apart on what "working" means.
const WORKING_STATES = new Set(["SENT", "OPEN", "PARTIAL"]);

// Date AND time, in IST. Time alone was ambiguous the moment the closed tab
// started carrying anything but today's rows, and a bare ISO string is not
// something anyone reads at a glance.
const istStamp = (value: unknown): string => {
  if (!value) return "--";
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) return "--";
  return at.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
};

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
  // Carries a tone as well as text. A basket whose short legs were withheld
  // because the hedge did not fill is NOT a success, and reporting it in the
  // same green box as a clean placement is how a half-placed structure gets
  // missed.
  const [placeResult, setPlaceResult] = useState<{ text: string; ok: boolean } | null>(null);
  // Counts the confirm window down so the button cannot be pressed against a
  // preview whose prices have moved.
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [tab, setTab] = useState<"positions" | "closed" | "orders" | "place" | "token">("positions");

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

  const panic = useCallback(async () => {
    if (
      !window.confirm(
        "Cancel every working order and square off every open position at market?\n\nThis places real orders and cannot be undone."
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/live/panic`, { method: "POST", credentials: "include" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      const failures: string[] = body.failures ?? [];
      setPlaceResult({
        text:
          `Panic: cancelled ${body.ordersCancelled}, squared off ${body.positionsSquaredOff}.` +
          (failures.length ? ` ${failures.length} failed - see below.` : ""),
        ok: failures.length === 0
      });
      // Failures are surfaced, never swallowed: a partial panic is exactly the
      // situation where the trader must know which legs are still open.
      if (failures.length) setPreviewError(failures.join(" | "));
      await refresh();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Panic close failed.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

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
      const placed = `Placed ${body.orders?.length ?? 0} order(s). Group ${String(body.groupId ?? "").slice(0, 8)}.`;
      setPlaceResult(
        body.abortedReason
          ? { text: `${placed} ${String(body.abortedReason)}`, ok: false }
          : { text: placed, ok: true }
      );
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
        <div className="flex items-center gap-2">
          {/* Always available, including when trading has been switched off:
              being unable to close is never the safe failure. */}
          {summary?.account ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void panic()}
              className="rounded border border-red-600 px-2 py-0.5 text-xs font-semibold text-red-700 disabled:opacity-50"
            >
              Panic close
            </button>
          ) : null}
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            summary?.enabled && account?.tradingEnabled
              ? "bg-red-100 text-red-800"
              : "bg-slate-200 text-slate-700"
          }`}
        >
          {summary?.enabled && account?.tradingEnabled ? "LIVE — real money" : "DISABLED"}
        </span>
        </div>
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
          ["closed", `Closed today${summary?.closedToday?.length ? ` (${summary.closedToday.length})` : ""}`],
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
      {placeResult ? (
        <p
          className={
            placeResult.ok
              ? "rounded bg-emerald-50 p-2 text-sm text-emerald-900"
              : "rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900"
          }
        >
          {placeResult.text}
        </p>
      ) : null}

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
          {preview.margin.basketPriced === false ? (
            <p className="text-xs font-medium text-amber-900">
              Dhan&apos;s basket pricing returned nothing usable, so this figure is the sum of each leg priced
              alone. For a hedged position that OVERSTATES the requirement - the real block will be lower.
            </p>
          ) : null}
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

      {/* Exit flags sit ABOVE the tabs. A fired stop rule is the single most
          time-critical thing this panel can say, and it must not depend on
          which tab happens to be open. */}
      {summary?.exitAlerts?.length ? (
        <div className="space-y-1 rounded border-2 border-red-400 bg-red-50 p-2">
          <h3 className="text-sm font-semibold text-red-900">Exit rules fired</h3>
          <p className="text-xs text-red-800">
            {account?.autoExitEnabled
              ? "Auto-close is ON: the engine places closing orders itself when a rule fires."
              : "Auto-close is OFF - these are reported only. Close them yourself."}
          </p>
          {summary.exitAlerts.map((alert) => (
            <p key={`${alert.groupId}-${alert.rule}`} className="text-xs text-red-900">
              <strong>{alert.rule}</strong> · {alert.detail}
              {alert.action === "FLAGGED" ? (
                <span className="text-red-700"> — flagged only; close it yourself.</span>
              ) : alert.action === "FAILED" ? (
                <span className="font-semibold text-red-800"> — AUTO-CLOSE FAILED, check the position.</span>
              ) : (
                <span className="text-emerald-800"> — auto-closed.</span>
              )}
            </p>
          ))}
        </div>
      ) : null}

      {tab === "positions" ? (
        <OpenPositions
          positions={summary?.positions ?? []}
          closedToday={summary?.closedToday ?? []}
          onChanged={refresh}
          canClose={!gateMessage}
        />
      ) : null}

      {tab === "closed" ? <ClosedToday positions={summary?.closedToday ?? []} /> : null}

      {tab === "orders" ? <RecentOrders orders={summary?.orders ?? []} onChanged={refresh} /> : null}

      {tab === "place" ? (
        gateMessage ? (
          <p className="text-sm text-slate-600">Order entry opens once the account is ready — see Broker token.</p>
        ) : underlyingSymbol && expiryLabel ? (
          <TicketBuilder
            underlyingSymbol={underlyingSymbol}
            expiryLabel={expiryLabel}
            busy={busy}
            allowUndefinedRisk={Boolean(account?.allowUndefinedRisk)}
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
  allowUndefinedRisk,
  onPreview
}: {
  underlyingSymbol: string;
  expiryLabel: string;
  busy: boolean;
  allowUndefinedRisk: boolean;
  onPreview: (ticket: unknown) => Promise<void>;
}) {
  const [structure, setStructure] = useState<string>("BEAR_CALL_SPREAD");
  const [lots, setLots] = useState(1);
  // LIMIT by default. A market order on an option book is how you find out what
  // the spread was, and the liquidity gate only refuses the worst strikes - it
  // does not promise a tight one on the rest.
  const [orderType, setOrderType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [strikes, setStrikes] = useState<Record<number, number | "">>({});
  // The LIMIT price per leg, seeded from the chain when a strike is picked and
  // editable from then on. Seeding rather than defaulting matters: the trader
  // sees the market before choosing a level, instead of typing into an empty
  // box or discovering afterwards that the last print was used.
  const [prices, setPrices] = useState<Record<number, number | "">>({});
  const [chain, setChain] = useState<ChainStrike[]>([]);
  const [chainError, setChainError] = useState<string | null>(null);

  // The offered set depends on the account: naked structures appear only where
  // the server would accept them, rather than being listed and then rejected.
  const available: Record<string, LegTemplate[]> = allowUndefinedRisk
    ? { ...STRUCTURES, ...UNDEFINED_RISK_STRUCTURES }
    : STRUCTURES;
  const template = available[structure] ?? [];
  const isNaked = structure in UNDEFINED_RISK_STRUCTURES;

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
  useEffect(() => {
    setStrikes({});
    setPrices({});
  }, [structure]);

  const optionsFor = (optionType: "CE" | "PE") =>
    chain.filter((row) => row.optionType === optionType).sort((a, b) => a.strikePrice - b.strikePrice);

  const complete =
    template.length > 0 &&
    template.every(
      (_, index) =>
        Number(strikes[index]) > 0 && (orderType === "MARKET" || Number(prices[index]) > 0)
    );

  const submit = () => {
    const legs = template.map((leg, index) => ({
      side: leg.side,
      optionType: leg.optionType,
      strikePrice: Number(strikes[index]),
      // Sent only for a LIMIT. A market order has no price to honour, and
      // sending one would put a number in the margin preview that no fill will
      // ever match. securityId stays absent - the server resolves the contract
      // from the strike. See legSchema in apps/api/src/live-routes.ts.
      ...(orderType === "LIMIT" && Number(prices[index]) > 0
        ? { price: Number(prices[index]) }
        : {})
    }));
    void onPreview({ underlyingSymbol, expiryLabel, structure, lots, legs, orderType });
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
            {Object.keys(available).map((key) => (
              <option key={key} value={key}>
                {key.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="text-slate-500">Order type</span>
          <select
            value={orderType}
            onChange={(event) => setOrderType(event.target.value as "LIMIT" | "MARKET")}
            className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="LIMIT">Limit</option>
            <option value="MARKET">Market</option>
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
              onChange={(event) => {
                const strike = event.target.value ? Number(event.target.value) : "";
                setStrikes((prev) => ({ ...prev, [index]: strike }));
                // Seed this leg's limit from the chain. Re-seeded on every
                // strike change rather than only the first: a price left over
                // from the previous strike is worse than no price, because it
                // looks deliberate.
                const row = strike === "" ? undefined : optionsFor(leg.optionType).find((r) => r.strikePrice === strike);
                setPrices((prev) => ({ ...prev, [index]: row?.lastPrice ?? "" }));
              }}
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
            {orderType === "LIMIT" ? (
              <span className="mt-1 flex items-center gap-1">
                <span className="text-slate-500">₹</span>
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  inputMode="decimal"
                  value={prices[index] ?? ""}
                  disabled={!(Number(strikes[index]) > 0)}
                  onChange={(event) =>
                    setPrices((prev) => ({
                      ...prev,
                      [index]: event.target.value === "" ? "" : Number(event.target.value)
                    }))
                  }
                  placeholder="limit"
                  className="block w-24 rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100"
                />
                {(() => {
                  // Show the market alongside, so a hand-typed limit can be
                  // judged against it without leaving the ticket.
                  const strike = Number(strikes[index]);
                  const row = strike > 0 ? optionsFor(leg.optionType).find((r) => r.strikePrice === strike) : undefined;
                  if (!row) return null;
                  const typed = Number(prices[index]);
                  const away = typed > 0 && row.lastPrice > 0
                    ? ((typed - row.lastPrice) / row.lastPrice) * 100
                    : null;
                  return (
                    <span className="text-slate-500">
                      LTP ₹{row.lastPrice}
                      {away !== null && Math.abs(away) >= 0.5
                        ? ` · ${away > 0 ? "+" : ""}${away.toFixed(1)}%`
                        : ""}
                    </span>
                  );
                })()}
              </span>
            ) : null}
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
      {isNaked ? (
        <p className="rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-900">
          <strong>Unbounded risk.</strong> A sold option with no wing has no maximum loss, and margin is
          revalued by the exchange six times a day - a position that fits at entry can be short of margin by
          the afternoon without the market moving against you. The exit rules do apply: profit target at 50%
          of credit, hard stop at 3x, and the short-leg blowout rule.
        </p>
      ) : null}

      <p className="text-xs text-slate-500">
        Preview prices the basket and runs every cap. Nothing reaches the broker until you confirm, and the
        confirmation expires after 10 seconds.
        {orderType === "MARKET"
          ? " A market order fills at whatever the book offers - the margin below is priced off the last traded price, not your fill."
          : " Each leg is placed at the limit you set - seeded from the last traded price, and yours to change. It may not fill."}
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

function OpenPositions({
  positions,
  closedToday,
  onChanged,
  canClose
}: {
  positions: Array<Record<string, unknown>>;
  closedToday: Array<Record<string, unknown>>;
  onChanged: () => Promise<void> | void;
  canClose: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  // limitPrice undefined = market. Both are offered rather than one being a
  // hidden mode: a market exit is certain but pays the spread, a limit exit
  // controls the price but may not fill, and which one is right depends on why
  // the trader is closing.
  const setStop = async (
    id: string,
    label: string,
    current: number | null,
    isShort: boolean,
    ltp: number | null
  ) => {
    const side = isShort ? "SHORT - stop must be ABOVE" : "LONG - stop must be BELOW";
    const raw = window.prompt(
      `Stop for ${label}\n${side} the current premium${ltp === null ? "" : ` of ${ltp.toFixed(2)}`}.\nBlank to clear.`,
      current === null ? "" : String(current)
    );
    if (raw === null) return;
    const trimmed = raw.trim();
    const stopPrice = trimmed === "" ? null : Number(trimmed);
    if (stopPrice !== null && (!Number.isFinite(stopPrice) || stopPrice <= 0)) {
      setCloseError("That is not a valid stop level.");
      return;
    }
    setBusyId(id);
    setCloseError(null);
    try {
      const response = await fetch(`${API_URL}/api/live/positions/${id}/stop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stopPrice })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      await onChanged();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Could not set the stop.");
    } finally {
      setBusyId(null);
    }
  };

  const squareOff = async (id: string, label: string, limitPrice?: number) => {
    const how = limitPrice ? `with a limit of ${limitPrice}` : "at market";
    if (!window.confirm(`Square off ${label} ${how}? This places a real order.`)) return;
    setBusyId(id);
    setCloseError(null);
    try {
      const response = await fetch(`${API_URL}/api/live/positions/${id}/exit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(limitPrice ? { limitPrice } : {})
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
      await onChanged();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Square-off failed.");
    } finally {
      setBusyId(null);
    }
  };

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
  // Today's realised is included, so this is the day's P&L rather than only the
  // open book's. Closing a losing leg otherwise made the number jump upwards,
  // which is exactly backwards from what happened.
  // A position's P&L is the CONTRACT'S TOTAL for the day - realised plus
  // unrealised - because that is the number Dhan shows and therefore the one a
  // trader reconciles against.
  //
  // It matters only when a strike is traded more than once, and then it matters
  // a lot. Dhan realises against the day's BLENDED average rather than against
  // the actual fills. NIFTY 24100 CE on 2026-09-02: sold at 51.80, bought back
  // at 52.15, sold again at 58.00. Dhan's costPrice becomes 54.90 - the average
  // of the two sells - so it reports unrealised 383.50 and realised 178.75
  // against a fill that was actually 58.00. Neither figure alone is
  // recognisable to the trader; their sum, 562.25, is exactly what the Dhan app
  // shows. Accounting from the actual fills agrees on that total: -22.75 on the
  // closed round trip plus (58.00 - 49.00) * 65 on the open lot.
  //
  // Showing unrealised alone reported 383.50 for a position the broker valued
  // at 562.25.
  const positionPnl = (p: Record<string, unknown>) =>
    Number(p.realizedPnl ?? 0) + Number(p.unrealizedPnl ?? 0);
  const openPnl = positions.reduce((sum, p) => sum + positionPnl(p), 0);
  // A contract that is open AGAIN already carries its realised P&L inside the
  // open row above, since Dhan reports realised per contract per day. Counting
  // its closed row here as well is the double-count: the 24100's -22.75 closed
  // row is the same money as part of the 178.75 on its open row.
  const openSecurityIds = new Set(positions.map((p) => String(p.securityId)));
  const realisedToday = closedToday
    .filter((p) => !openSecurityIds.has(String(p.securityId)))
    .reduce((sum, p) => sum + Number(p.realizedPnl ?? 0), 0);
  // Neither engine coverage nor a stop. Surfaced as a banner as well as a column
  // because the failure it prevents - believing a naked short is watched when it
  // is not - is one you only notice when it is too late to matter.
  const unprotected = positions.filter((p) => !p.engineCovered && !p.stopPrice);
  const net = openPnl + realisedToday;

  return (
    <div className="space-y-2">
      {closeError ? <p className="rounded bg-red-50 p-2 text-xs text-red-800">{closeError}</p> : null}
      {unprotected.length ? (
        <p className="rounded border border-red-400 bg-red-50 p-2 text-xs text-red-900">
          <strong>
            {unprotected.length} position{unprotected.length > 1 ? "s have" : " has"} no automatic exit.
          </strong>{" "}
          {unprotected.map((p) => String(p.tradingSymbol ?? p.securityId)).join(", ")} — the exit rules only
          act on complete structures opened through this app, so anything opened in Dhan, or a structure with
          a leg already closed, needs a stop.
        </p>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-3 rounded border border-slate-200 p-2">
        <span className="text-xs uppercase text-slate-500">
          Net P&amp;L today
          <span className="ml-2 normal-case text-slate-400">
            open {rupees(openPnl)} + realised {rupees(realisedToday)}
          </span>
        </span>
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
              <th className="pr-2" title="Whether anything will close this position automatically">
                Cover
              </th>
              <th>Contract</th>
              <th>Expiry</th>
              <th>Entered</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Avg cost</th>
              <th className="text-right">LTP</th>
              <th className="text-right">Delta</th>
              <th
                className="text-right"
                title="This contract's total P&L for the day - unrealised plus anything already realised on it - which is the figure the Dhan app shows."
              >
                Current P/L
              </th>
              {/* Stop sits AFTER the P&L to match the cell order below. These
                  were transposed from the day the Stop column was added: the
                  P&L value rendered under the "Stop" heading and the stop cell
                  under the P&L heading, which reads as a missing P&L because a
                  position with no stop renders an empty cell. Counting columns
                  does not catch this - both sides balanced at 12 - only
                  comparing the ORDER does. */}
              <th className="text-right">Stop</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              // netQty carries the direction: negative is short. Deriving the
              // marker from the sign rather than from a stored side means it
              // cannot disagree with the quantity beside it.
              const qty = Number(position.netQty ?? 0);
              const isShort = qty < 0;

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
              // Days to expiry, highlighted at <= 1. An option expiring today
              // or tomorrow behaves nothing like the same contract a month out,
              // and the date alone does not make that obvious at a glance.
              const dte = position.expiryLabel
                ? Math.ceil(
                    (new Date(`${String(position.expiryLabel)}T00:00:00Z`).getTime() - Date.now()) / 86_400_000
                  )
                : null;
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
                  <td className="pr-2">
                    {/* Three states, not two. "Engine" and "Stop" are both real
                        protection; the gap is a position with neither, which is
                        invisible unless you know the group rules and check them
                        by hand. */}
                    {position.engineCovered ? (
                      <span className="text-emerald-700" title="Exit rules will act on this position">
                        engine
                      </span>
                    ) : position.stopPrice ? (
                      <span className="text-emerald-700" title="A per-position stop will close this">
                        stop
                      </span>
                    ) : (
                      <span
                        className="font-bold text-red-700"
                        title="NOTHING will close this automatically. Either it was opened outside this app, or its structure is no longer complete, or auto-exit is off. Set a stop."
                      >
                        NONE
                      </span>
                    )}
                  </td>
                  <td>{String(position.tradingSymbol ?? position.securityId)}</td>
                  <td className={dte !== null && dte <= 1 ? "font-semibold text-red-700" : "text-slate-600"}>
                    {position.expiryLabel ? String(position.expiryLabel) : "--"}
                    {dte === null ? "" : dte <= 0 ? " (today)" : ` (${dte}d)`}
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-500">{istStamp(position.openedAt)}</td>
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
                          : "Last known price - the feed has nothing fresh for this contract, which is normal outside market hours"
                    }
                  >
                    {ltp === null ? "--" : ltp.toFixed(2)}
                    {dir === "up" ? " \u25b2" : dir === "down" ? " \u25bc" : ""}
                    {ltp !== null && !live ? <span className="text-slate-400"> *</span> : null}
                  </td>
                  <td
                    className="text-right tabular-nums text-slate-700"
                    title={
                      position.delta === undefined
                        ? "No usable delta. Dhan zeroes it on most option ticks, and a zero is missing data rather than a flat position."
                        : "From the 30s option-chain capture, not the live feed - the feed carries no Greeks."
                    }
                  >
                    {position.delta === undefined ? (
                      <span className="text-slate-400">--</span>
                    ) : (
                      // Signed by direction: a short call is negative delta to
                      // the account even though the contract's own delta is
                      // positive. Showing the contract's delta on a short
                      // position would point the wrong way.
                      (Number(position.delta) * (qty < 0 ? -1 : 1)).toFixed(3)
                    )}
                  </td>
                  <td
                    className={`text-right font-medium ${
                      positionPnl(position) < 0 ? "text-red-700" : "text-emerald-700"
                    }`}
                    title={
                      Number(position.realizedPnl ?? 0)
                        ? `Unrealised ${rupees(position.unrealizedPnl as number)} + realised ${rupees(
                            position.realizedPnl as number
                          )} on this contract today. Dhan splits these against the day's blended average price, so neither half matches your fill on its own - the total does.`
                        : "Live profit or loss at the current mark."
                    }
                  >
                    {rupees(positionPnl(position))}
                  </td>
                  <td className="text-right">
                    {position.stopPrice ? (
                      <button
                        type="button"
                        onClick={() => void setStop(id, String(position.tradingSymbol), Number(position.stopPrice), isShort, ltp)}
                        className="font-medium text-amber-700 underline"
                        title="Fires a MARKET close when breached. Click to change or clear."
                      >
                        {Number(position.stopPrice).toFixed(2)}
                      </button>
                    ) : canClose ? (
                      <button
                        type="button"
                        onClick={() => void setStop(id, String(position.tradingSymbol), null, isShort, ltp)}
                        className="text-slate-500 underline"
                      >
                        set
                      </button>
                    ) : (
                      <span className="text-slate-400">--</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap pl-2">
                    {canClose ? (
                      <>
                        <button
                          type="button"
                          disabled={busyId === id}
                          onClick={() =>
                            void squareOff(id, String(position.tradingSymbol ?? position.securityId))
                          }
                          className="mr-2 text-red-700 underline disabled:opacity-50"
                        >
                          {busyId === id ? "Closing…" : "Mkt"}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === id}
                          onClick={() => {
                            // Seeded with the current LTP: the trader is almost
                            // always adjusting from there, not typing blind.
                            const raw = window.prompt("Limit price to close at", ltp === null ? "" : ltp.toFixed(2));
                            if (raw === null) return;
                            const price = Number(raw);
                            if (!Number.isFinite(price) || price <= 0) {
                              setCloseError("That is not a valid limit price.");
                              return;
                            }
                            void squareOff(id, String(position.tradingSymbol ?? position.securityId), price);
                          }}
                          className="text-slate-700 underline disabled:opacity-50"
                        >
                          Lmt
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        LTP updates every second from the Dhan feed; an asterisk means the price is the last known one rather
        than a live tick, which is what you see outside market hours and on quiet strikes. Delta comes from the 30s option-chain capture
        instead - the feed carries no Greeks - and is signed for the position rather than the contract, so a
        short call reads negative. A stop fires a MARKET close when the premium crosses it - above for a
        short, below for a long - and works on any position including ones opened in Dhan, independently of
        the structure auto-exit switch. Positions come from Dhan and refresh every 20s.
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
            <th>Expiry</th>
            <th>Placed</th>
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
                {/* A zero strike means the contract was never recorded - show
                    the underlying alone rather than "NIFTY 0 CE", which reads
                    like a real contract that does not exist. */}
                {Number(order.strikePrice) > 0
                  ? `${String(order.underlyingSymbol)} ${String(order.strikePrice)} ${String(order.optionType)}`
                  : `${String(order.underlyingSymbol)} (contract not recorded)`}
              </td>
              <td className="text-slate-600">{order.expiryLabel ? String(order.expiryLabel) : "--"}</td>
              <td className="whitespace-nowrap text-xs text-slate-500">{istStamp(order.placedAt)}</td>
              <td>{String(order.transactionType)}</td>
              <td>{String(order.lots)}</td>
              <td>
                {/* A market order has no price, and rendering that as "--"
                    reads as missing data rather than as "at market". */}
                {String(order.orderType) === "MARKET" ? (
                  <span className="text-slate-500">MKT</span>
                ) : (
                  rupees(order.price as number)
                )}
              </td>
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

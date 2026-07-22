import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDatePicker } from "./calendar-date-picker";
import type { MarketOverview } from "./live-dashboard";

// Paper Trading Pro: seller strategy simulator panel.
//
// Deliberately self-contained (own fetch cycle against /api/sim/*, own
// state) so it adds zero props/state to live-dashboard beyond the shared
// MarketOverview - the original Paper Trading tab is untouched.
//
// Layout follows the single-page guideline: account + portfolio Greeks
// left, open/closed positions center, strategy order ticket right,
// seller analytics strip along the bottom.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type SimStrategyType = "SHORT_STRADDLE" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "IRON_CONDOR" | "NAKED_CALL" | "NAKED_PUT";
type SimHorizon = "INTRADAY" | "WEEKLY" | "MONTHLY";

// --- Signal handoff from the Strike Matrix tab ("Paper Trade This") ---
// The Strike Matrix panel stores a draft here and navigates to this tab;
// the ticket pre-fills from it on mount. sessionStorage (not state) so the
// handoff survives the tab switch without threading props through
// live-dashboard.
const SIM_TICKET_DRAFT_KEY = "option-decode:sim-ticket-draft";

export interface SimTicketDraft {
  underlyingSymbol: string;
  expiry: string;
  strategyType: SimStrategyType;
  horizon: SimHorizon;
  shortPutStrike?: number;
  shortCallStrike?: number;
  wci: number | null;
  drcr: number | null;
  signalRef: string;
  note?: string;
}

export function storeSimTicketDraft(draft: SimTicketDraft): void {
  try {
    sessionStorage.setItem(SIM_TICKET_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Session storage unavailable (private mode edge cases) - the user can
    // still build the ticket manually.
  }
}

function takeSimTicketDraft(): SimTicketDraft | null {
  try {
    const raw = sessionStorage.getItem(SIM_TICKET_DRAFT_KEY);
    if (!raw) {
      return null;
    }
    sessionStorage.removeItem(SIM_TICKET_DRAFT_KEY);
    return JSON.parse(raw) as SimTicketDraft;
  } catch {
    return null;
  }
}

interface SignalContext {
  wci: number | null;
  drcr: number | null;
  signalRef: string;
  note?: string;
}

interface SimQuotedLeg {
  side: "SELL" | "BUY";
  optionType: "CE" | "PE";
  strikePrice: number;
  bid: number;
  ask: number;
  mid: number;
  fillPrice: number;
  delta: number | null;
  tranches: Array<{ lots: number; price: number }> | null;
  rejectReason: string | null;
}

interface SimStressResult {
  nlv: number;
  currentMargin: number;
  cells: Array<{
    spotShiftPct: number;
    ivShiftPct: number;
    pnlDelta: number;
    projectedMargin: number;
    marginCall: boolean;
  }>;
}

interface SimQuote {
  ok: boolean;
  legs: SimQuotedLeg[];
  lotSize: number;
  slippageChi: number;
  netCreditPerUnit: number;
  netCreditTotal: number;
  maxLossTotal: number | null;
  bpe: number;
  popEstimate: number | null;
  ivAtEntry: number | null;
  hv20: number | null;
  ivHvRatio: number | null;
  lowEdgeFlag: boolean;
  rejectReason: string | null;
}

interface SimTradeDto {
  id: string;
  strategyType: SimStrategyType;
  underlyingSymbol: string;
  expiryLabel: string;
  horizon: SimHorizon;
  lots: number;
  status: string;
  netCredit: number;
  maxLoss: number | null;
  bpe: number;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  pnlPctOfMaxProfit: number | null;
  dte: number;
  lowEdgeFlag: boolean;
  signalRef: string | null;
  exitReason: string | null;
  legs: Array<{ id: string; side: "SELL" | "BUY"; optionType: "CE" | "PE"; strikePrice: number; fillPrice: number }>;
  exitFlags: Array<{ rule: string; detail: string | null }>;
}

interface SimSummary {
  account: {
    startingCapital: number;
    cash: number;
    nlv: number;
    marginUsed: number;
    marginCall: boolean;
    buyingPower: number;
    buyingPowerUsedPct: number;
    maxTradeBpPct: number;
  };
  openTrades: SimTradeDto[];
  closedTrades: SimTradeDto[];
  portfolioGreeks: {
    netDelta: number | null;
    netGamma: number | null;
    netTheta: number | null;
    netVega: number | null;
  };
  analytics: {
    totalTrades: number;
    wins: number;
    losses: number;
    expectancy: number | null;
    tailRiskRatio: number | null;
    thetaEfficiency: number | null;
    avgIvHvRatio: number | null;
    totalRealizedPnl: number;
    signalScorecard: Array<{
      regime: "Bullish" | "Neutral" | "Bearish" | "Transitional";
      horizon: SimHorizon;
      trades: number;
      wins: number;
      totalPnl: number;
    }>;
  };
}

const STRATEGY_LABELS: Record<SimStrategyType, string> = {
  SHORT_STRADDLE: "Short Straddle",
  BULL_PUT_SPREAD: "Bull Put Spread",
  BEAR_CALL_SPREAD: "Bear Call Spread",
  IRON_CONDOR: "Iron Condor",
  NAKED_CALL: "Naked Call",
  NAKED_PUT: "Naked Put"
};

const EXIT_FLAG_LABELS: Record<string, string> = {
  PROFIT_TARGET: "Profit target hit",
  HARD_STOP_3X: "3x hard stop",
  DTE_GAMMA: "Gamma window (DTE<=7)",
  EXPIRY_ITM: "Expired ITM",
  DELTA_2X_INTRADAY: "2x delta stop",
  MARGIN_CALL: "Margin call",
  DELIVERY_RISK: "Delivery risk (ITM stock)"
};

function formatInr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

function pnlClass(value: number | null | undefined): string {
  if (value == null) {
    return "text-terminal-muted";
  }
  return value >= 0 ? "text-terminal-emerald" : "text-terminal-red";
}

function buildLegsForStrategy(strategy: SimStrategyType, mainStrike: number, wingWidth: number, condorOffset: number): Array<{ side: "SELL" | "BUY"; optionType: "CE" | "PE"; strikePrice: number }> {
  switch (strategy) {
    case "SHORT_STRADDLE":
      return [
        { side: "SELL", optionType: "CE", strikePrice: mainStrike },
        { side: "SELL", optionType: "PE", strikePrice: mainStrike }
      ];
    case "BULL_PUT_SPREAD":
      return [
        { side: "SELL", optionType: "PE", strikePrice: mainStrike },
        { side: "BUY", optionType: "PE", strikePrice: mainStrike - wingWidth }
      ];
    case "BEAR_CALL_SPREAD":
      return [
        { side: "SELL", optionType: "CE", strikePrice: mainStrike },
        { side: "BUY", optionType: "CE", strikePrice: mainStrike + wingWidth }
      ];
    case "IRON_CONDOR":
      return [
        { side: "SELL", optionType: "PE", strikePrice: mainStrike - condorOffset },
        { side: "BUY", optionType: "PE", strikePrice: mainStrike - condorOffset - wingWidth },
        { side: "SELL", optionType: "CE", strikePrice: mainStrike + condorOffset },
        { side: "BUY", optionType: "CE", strikePrice: mainStrike + condorOffset + wingWidth }
      ];
    case "NAKED_CALL":
      return [{ side: "SELL", optionType: "CE", strikePrice: mainStrike }];
    case "NAKED_PUT":
      return [{ side: "SELL", optionType: "PE", strikePrice: mainStrike }];
  }
}

interface PaperTradingProPanelProps {
  overview: MarketOverview;
}

export function PaperTradingProPanel({ overview }: PaperTradingProPanelProps) {
  const [summary, setSummary] = useState<SimSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [quote, setQuote] = useState<SimQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isPlacing, setIsPlacing] = useState(false);
  const [closingTradeId, setClosingTradeId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [strategy, setStrategy] = useState<SimStrategyType>("IRON_CONDOR");
  const [horizon, setHorizon] = useState<SimHorizon>("WEEKLY");
  const [expiry, setExpiry] = useState(overview.selectedExpiry);
  const [lots, setLots] = useState(1);
  const [mainStrike, setMainStrike] = useState(overview.snapshot.atmStrike);
  const [wingWidth, setWingWidth] = useState(0);
  const [condorOffset, setCondorOffset] = useState(0);
  // Set when the ticket was pre-filled from a Strike Matrix recommendation.
  // Any manual edit to the structure clears it - the trade is then the
  // trader's, not the signal's.
  const [signalContext, setSignalContext] = useState<SignalContext | null>(null);
  const [stress, setStress] = useState<SimStressResult | null>(null);
  const [isStressing, setIsStressing] = useState(false);
  // Explicit legs from a signal draft (e.g. an asymmetric condor around the
  // recommended walls) - takes precedence over the computed legs until the
  // user edits the ticket.
  const [legsOverride, setLegsOverride] = useState<Array<{ side: "SELL" | "BUY"; optionType: "CE" | "PE"; strikePrice: number }> | null>(null);

  const clearSignal = useCallback(() => {
    setSignalContext(null);
    setLegsOverride(null);
  }, []);

  const strikeChoices = useMemo(() => {
    const strikes = [...new Set(overview.snapshot.ticks.map((tick) => tick.strikePrice))];
    strikes.sort((a, b) => a - b);
    return strikes;
  }, [overview.snapshot.ticks]);

  const strikeStep = useMemo(() => {
    if (strikeChoices.length < 2) {
      return 50;
    }
    let step = Number.POSITIVE_INFINITY;
    for (let i = 1; i < strikeChoices.length; i += 1) {
      step = Math.min(step, strikeChoices[i] - strikeChoices[i - 1]);
    }
    return Number.isFinite(step) && step > 0 ? step : 50;
  }, [strikeChoices]);

  useEffect(() => {
    setMainStrike(overview.snapshot.atmStrike);
  }, [overview.snapshot.atmStrike, overview.selectedUnderlying]);

  useEffect(() => {
    setExpiry(overview.selectedExpiry);
  }, [overview.selectedExpiry, overview.selectedUnderlying]);

  useEffect(() => {
    if (wingWidth === 0 && strikeStep > 0) {
      setWingWidth(strikeStep * 2);
    }
    if (condorOffset === 0 && strikeStep > 0) {
      setCondorOffset(strikeStep * 4);
    }
  }, [strikeStep, wingWidth, condorOffset]);

  const legs = useMemo(
    () => legsOverride ?? buildLegsForStrategy(strategy, mainStrike, wingWidth || strikeStep * 2, condorOffset || strikeStep * 4),
    [legsOverride, strategy, mainStrike, wingWidth, condorOffset, strikeStep]
  );

  // Apply a pending "Paper Trade This" draft exactly once on mount.
  useEffect(() => {
    const draft = takeSimTicketDraft();
    if (!draft || draft.underlyingSymbol !== overview.selectedUnderlying) {
      return;
    }
    const wing = Math.max(strikeStep, 50) * 2;
    setStrategy(draft.strategyType);
    setHorizon(draft.horizon);
    if (draft.expiry) {
      setExpiry(draft.expiry);
    }
    if (draft.strategyType === "IRON_CONDOR" && draft.shortPutStrike !== undefined && draft.shortCallStrike !== undefined) {
      // Honor the exact recommended walls even when they're asymmetric
      // around ATM - explicit legs instead of center/offset math.
      setLegsOverride([
        { side: "SELL", optionType: "PE", strikePrice: draft.shortPutStrike },
        { side: "BUY", optionType: "PE", strikePrice: draft.shortPutStrike - wing },
        { side: "SELL", optionType: "CE", strikePrice: draft.shortCallStrike },
        { side: "BUY", optionType: "CE", strikePrice: draft.shortCallStrike + wing }
      ]);
    } else if (draft.shortPutStrike !== undefined) {
      setMainStrike(draft.shortPutStrike);
    } else if (draft.shortCallStrike !== undefined) {
      setMainStrike(draft.shortCallStrike);
    }
    // A draft without a signalRef is a low-conviction "practice trade":
    // the structure pre-fills but the trade stays unattributed (no WCI
    // gate, excluded from the signal scorecard).
    setSignalContext(draft.signalRef ? { wci: draft.wci, drcr: draft.drcr, signalRef: draft.signalRef, note: draft.note } : null);
    setQuote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time mount handoff
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/sim/summary`, { cache: "no-store", credentials: "include" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setSummary((await response.json()) as SimSummary);
      setSummaryError(null);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : "Unable to load simulator account.");
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
    const interval = setInterval(() => void refreshSummary(), 30_000);
    return () => clearInterval(interval);
  }, [refreshSummary]);

  const requestBody = useMemo(
    () => ({
      underlyingSymbol: overview.selectedUnderlying,
      expiry,
      strategyType: strategy,
      horizon,
      lots,
      legs,
      ...(signalContext ? { entryWci: signalContext.wci ?? undefined, entryDrcr: signalContext.drcr ?? undefined, signalRef: signalContext.signalRef } : {})
    }),
    [overview.selectedUnderlying, expiry, strategy, horizon, lots, legs, signalContext]
  );

  const handleQuote = useCallback(async () => {
    setIsQuoting(true);
    setQuoteError(null);
    setActionMessage(null);
    try {
      const response = await fetch(`${API_URL}/api/sim/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(requestBody)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
      setQuote(payload as SimQuote);
    } catch (error) {
      setQuote(null);
      setQuoteError(error instanceof Error ? error.message : "Quote failed.");
    } finally {
      setIsQuoting(false);
    }
  }, [requestBody]);

  const handlePlace = useCallback(async () => {
    setIsPlacing(true);
    setQuoteError(null);
    try {
      const response = await fetch(`${API_URL}/api/sim/trades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(requestBody)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
      setSummary(payload.summary as SimSummary);
      setQuote(null);
      setActionMessage("Trade placed with slippage-adjusted fills.");
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : "Order rejected.");
    } finally {
      setIsPlacing(false);
    }
  }, [requestBody]);

  const handleClose = useCallback(async (tradeId: string) => {
    setClosingTradeId(tradeId);
    setActionMessage(null);
    try {
      const response = await fetch(`${API_URL}/api/sim/trades/${tradeId}/close`, {
        method: "POST",
        credentials: "include"
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
      setSummary(payload as SimSummary);
      setActionMessage("Trade closed at slippage-adjusted market price.");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Close failed.");
    } finally {
      setClosingTradeId(null);
    }
  }, []);

  const handleStress = useCallback(async () => {
    setIsStressing(true);
    try {
      const response = await fetch(`${API_URL}/api/sim/stress`, { cache: "no-store", credentials: "include" });
      if (response.ok) {
        setStress((await response.json()) as SimStressResult);
      }
    } finally {
      setIsStressing(false);
    }
  }, []);

  const handleReset = useCallback(async () => {
    if (!window.confirm("Reset the simulator account? Open and closed sim trades stay archived under the old account.")) {
      return;
    }
    const response = await fetch(`${API_URL}/api/sim/account/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({})
    });
    if (response.ok) {
      setSummary((await response.json()) as SimSummary);
      setActionMessage("Simulator account reset.");
    }
  }, []);

  const account = summary?.account;
  const greeks = summary?.portfolioGreeks;
  const analytics = summary?.analytics;
  const needsMainStrike = true;
  const showWingWidth = strategy === "BULL_PUT_SPREAD" || strategy === "BEAR_CALL_SPREAD" || strategy === "IRON_CONDOR";
  const showCondorOffset = strategy === "IRON_CONDOR";

  return (
    <section aria-label="Paper Trading Pro">
      <div className="grid gap-3 xl:grid-cols-[16rem_minmax(0,1fr)_19rem]">
        {/* LEFT: account + portfolio greeks */}
        <div className="space-y-3">
          <div className="rounded border border-terminal-line bg-terminal-panel p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">Sim Account</h2>
              <button className="rounded border border-terminal-line px-2 py-0.5 text-[0.65rem] uppercase text-terminal-muted transition hover:border-terminal-red hover:text-terminal-red" type="button" onClick={handleReset}>
                Reset
              </button>
            </div>
            {summaryError ? <p className="mt-2 text-xs text-terminal-red">{summaryError}</p> : null}
            {account?.marginCall ? (
              <p className="mt-2 rounded border border-terminal-red bg-terminal-red/15 p-2 text-xs font-semibold text-terminal-red">
                MARGIN CALL - maintenance margin {formatInr(account.marginUsed)} exceeds NLV {formatInr(account.nlv)}. The risk engine will force-liquidate the largest position on its next cycle.
              </p>
            ) : null}
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-terminal-muted">Net Liq. Value</dt><dd className="font-semibold text-terminal-text">{formatInr(account?.nlv)}</dd></div>
              <div className="flex justify-between"><dt className="text-terminal-muted">Cash</dt><dd>{formatInr(account?.cash)}</dd></div>
              <div className="flex justify-between"><dt className="text-terminal-muted">Margin Used</dt><dd>{formatInr(account?.marginUsed)}</dd></div>
              <div className="flex justify-between"><dt className="text-terminal-muted">Buying Power</dt><dd>{formatInr(account?.buyingPower)}</dd></div>
            </dl>
            <div className="mt-2">
              <div className="flex justify-between text-[0.65rem] uppercase text-terminal-muted">
                <span>BP used</span>
                <span>{account ? `${account.buyingPowerUsedPct.toFixed(0)}%` : "--"}</span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-terminal-input">
                <div className="h-full rounded bg-terminal-blue" style={{ width: `${Math.min(account?.buyingPowerUsedPct ?? 0, 100)}%` }} />
              </div>
            </div>
          </div>

          <div className="rounded border border-terminal-line bg-terminal-panel p-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">Portfolio Greeks</h2>
            <div className="mt-2 grid grid-cols-2 gap-2 text-center">
              <div className="rounded bg-terminal-input p-2"><div className={`text-sm font-semibold ${pnlClass(greeks?.netDelta)}`}>{greeks?.netDelta ?? "--"}</div><div className="text-[0.65rem] uppercase text-terminal-muted">Net Delta</div></div>
              <div className="rounded bg-terminal-input p-2"><div className="text-sm font-semibold text-terminal-text">{greeks?.netGamma ?? "--"}</div><div className="text-[0.65rem] uppercase text-terminal-muted">Net Gamma</div></div>
              <div className="rounded bg-terminal-input p-2"><div className={`text-sm font-semibold ${pnlClass(greeks?.netTheta)}`}>{greeks?.netTheta != null ? formatInr(greeks.netTheta) : "--"}</div><div className="text-[0.65rem] uppercase text-terminal-muted">Theta / day</div></div>
              <div className="rounded bg-terminal-input p-2"><div className="text-sm font-semibold text-terminal-text">{greeks?.netVega ?? "--"}</div><div className="text-[0.65rem] uppercase text-terminal-muted">Net Vega</div></div>
            </div>
            {greeks?.netDelta != null && greeks?.netTheta != null ? (
              <p className="mt-2 rounded border border-terminal-amber/40 bg-terminal-amber/10 p-2 text-[0.7rem] text-terminal-amber">
                {greeks.netDelta < 0 ? "Short" : "Long"} {Math.abs(greeks.netDelta).toFixed(0)} net delta, {greeks.netTheta >= 0 ? "collecting" : "paying"} {formatInr(Math.abs(greeks.netTheta))}/day in theta.
              </p>
            ) : null}
          </div>

          {/* Phase 3: stress grid */}
          <div className="rounded border border-terminal-line bg-terminal-panel p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">Stress Test</h2>
              <button className="rounded border border-terminal-line px-2 py-0.5 text-[0.65rem] uppercase text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-blue disabled:opacity-60" disabled={isStressing} type="button" onClick={() => void handleStress()}>
                {isStressing ? "Running..." : "Run"}
              </button>
            </div>
            {stress ? (
              <div className="mt-2">
                <table className="w-full text-center text-[0.7rem]">
                  <thead>
                    <tr className="text-[0.6rem] uppercase text-terminal-muted">
                      <th className="py-1 text-left">IV \ Spot</th>
                      <th>-2%</th>
                      <th>0%</th>
                      <th>+2%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[-20, 0, 20].map((ivShift) => (
                      <tr key={ivShift}>
                        <td className="py-1 text-left text-terminal-muted">{ivShift > 0 ? `+${ivShift}` : ivShift}%</td>
                        {[-2, 0, 2].map((spotShift) => {
                          const cell = stress.cells.find((candidate) => candidate.spotShiftPct === spotShift && candidate.ivShiftPct === ivShift);
                          return (
                            <td key={spotShift} className={`py-1 ${cell?.marginCall ? "bg-terminal-red/20" : ""}`} title={cell ? `Projected margin ${formatInr(cell.projectedMargin)}${cell.marginCall ? " - MARGIN CALL" : ""}` : undefined}>
                              <span className={pnlClass(cell?.pnlDelta)}>{cell ? formatInr(cell.pnlDelta) : "--"}</span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-[0.6rem] text-terminal-muted">P&L impact; red cells project a margin call. Hover for projected margin.</p>
              </div>
            ) : (
              <p className="mt-2 text-[0.7rem] text-terminal-muted">Project P&L and margin across spot ±2% / IV ±20% scenarios.</p>
            )}
          </div>
        </div>

        {/* CENTER: positions */}
        <div className="space-y-3">
          <div className="rounded border border-terminal-line bg-terminal-panel p-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">Open Strategies</h2>
            {actionMessage ? <p className="mt-1 text-xs text-terminal-blue">{actionMessage}</p> : null}
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-terminal-line text-[0.65rem] uppercase text-terminal-muted">
                    <th className="py-1.5 pr-2">Strategy</th>
                    <th className="py-1.5 pr-2">Legs</th>
                    <th className="py-1.5 pr-2">Credit</th>
                    <th className="py-1.5 pr-2">P&L</th>
                    <th className="py-1.5 pr-2">DTE</th>
                    <th className="py-1.5 pr-2">Exit Rules</th>
                    <th className="py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {(summary?.openTrades ?? []).map((trade) => (
                    <tr key={trade.id} className="border-b border-terminal-line/50 align-top">
                      <td className="py-2 pr-2">
                        <div className="font-semibold text-terminal-text">{STRATEGY_LABELS[trade.strategyType]}</div>
                        <div className="text-terminal-muted">{trade.underlyingSymbol} {trade.expiryLabel} x{trade.lots}</div>
                        {trade.signalRef ? <div className="text-[0.65rem] uppercase text-terminal-blue">Signal trade</div> : null}
                        {trade.lowEdgeFlag ? <div className="text-[0.65rem] uppercase text-terminal-amber">Low-edge IV/HV</div> : null}
                      </td>
                      <td className="py-2 pr-2 text-terminal-muted">
                        {trade.legs.map((leg) => (
                          <div key={leg.id}>{leg.side === "SELL" ? "-" : "+"}{leg.strikePrice}{leg.optionType} @ {leg.fillPrice.toFixed(2)}</div>
                        ))}
                      </td>
                      <td className="py-2 pr-2">{formatInr(trade.netCredit)}</td>
                      <td className={`py-2 pr-2 font-semibold ${pnlClass(trade.unrealizedPnl)}`}>
                        {formatInr(trade.unrealizedPnl)}
                        {trade.pnlPctOfMaxProfit != null ? <div className="text-[0.65rem] font-normal text-terminal-muted">{trade.pnlPctOfMaxProfit.toFixed(0)}% of max</div> : null}
                      </td>
                      <td className="py-2 pr-2">{trade.dte}</td>
                      <td className="py-2 pr-2">
                        {trade.exitFlags.length === 0 ? <span className="rounded bg-terminal-emerald/15 px-1.5 py-0.5 text-[0.65rem] uppercase text-terminal-emerald">Holding</span> : trade.exitFlags.map((flag) => (
                          <span key={flag.rule} className="mb-1 mr-1 inline-block rounded bg-terminal-amber/15 px-1.5 py-0.5 text-[0.65rem] uppercase text-terminal-amber" title={flag.detail ?? undefined}>
                            {EXIT_FLAG_LABELS[flag.rule] ?? flag.rule}
                          </span>
                        ))}
                      </td>
                      <td className="py-2 text-right">
                        <button className="rounded border border-terminal-line px-2 py-1 text-[0.65rem] uppercase text-terminal-text transition hover:border-terminal-red hover:text-terminal-red disabled:opacity-60" disabled={closingTradeId === trade.id} type="button" onClick={() => void handleClose(trade.id)}>
                          {closingTradeId === trade.id ? "Closing..." : "Close"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {summary && summary.openTrades.length === 0 ? (
                    <tr><td className="py-3 text-terminal-muted" colSpan={7}>No open strategies. Build one in the ticket on the right.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded border border-terminal-line bg-terminal-panel p-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">Closed Strategies</h2>
            <div className="mt-2 max-h-48 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <tbody>
                  {(summary?.closedTrades ?? []).slice(0, 12).map((trade) => (
                    <tr key={trade.id} className="border-b border-terminal-line/40">
                      <td className="py-1.5 pr-2 text-terminal-text">{STRATEGY_LABELS[trade.strategyType]}</td>
                      <td className="py-1.5 pr-2 text-terminal-muted">{trade.underlyingSymbol} {trade.expiryLabel}</td>
                      <td className="py-1.5 pr-2 text-terminal-muted">{trade.exitReason ?? trade.status}</td>
                      <td className={`py-1.5 text-right font-semibold ${pnlClass(trade.realizedPnl)}`}>{formatInr(trade.realizedPnl)}</td>
                    </tr>
                  ))}
                  {summary && summary.closedTrades.length === 0 ? (
                    <tr><td className="py-2 text-terminal-muted">No closed trades yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* RIGHT: strategy order ticket */}
        <div className="rounded border border-terminal-line bg-terminal-panel p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">Strategy Ticket - {overview.selectedUnderlying}</h2>

          {signalContext ? (
            <div className="mt-2 rounded border border-terminal-blue/50 bg-terminal-blue/10 p-2 text-[0.7rem] text-terminal-blue">
              <div className="font-semibold uppercase">From Strike Matrix signal</div>
              <div className="mt-0.5 text-terminal-muted">
                WCI {signalContext.wci != null ? signalContext.wci.toFixed(2) : "--"} · DRCR {signalContext.drcr != null ? signalContext.drcr.toFixed(2) : "--"}
                {signalContext.note ? ` · ${signalContext.note}` : ""}
              </div>
              <div className="mt-0.5 text-terminal-muted">Editing the structure detaches the trade from the signal.</div>
            </div>
          ) : null}

          <label className="mt-2 block text-[0.65rem] uppercase text-terminal-muted">Strategy</label>
          <select className="mt-1 w-full rounded border border-terminal-line bg-terminal-input p-2 text-sm text-terminal-text" value={strategy} onChange={(event) => { setStrategy(event.target.value as SimStrategyType); setQuote(null); clearSignal(); }}>
            {Object.entries(STRATEGY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[0.65rem] uppercase text-terminal-muted">Expiry</label>
              <div className="mt-1">
                <CalendarDatePicker availableDates={overview.tradableExpiries} value={expiry} onChange={(date) => { setExpiry(date); setQuote(null); clearSignal(); }} placeholder="Select expiry" emptyLabel="No tradable expiries." />
              </div>
            </div>
            <div>
              <label className="block text-[0.65rem] uppercase text-terminal-muted">Horizon</label>
              <select className="mt-1 w-full rounded border border-terminal-line bg-terminal-input p-2 text-sm text-terminal-text" value={horizon} onChange={(event) => setHorizon(event.target.value as SimHorizon)}>
                <option value="INTRADAY">Intraday</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            {needsMainStrike ? (
              <div>
                <label className="block text-[0.65rem] uppercase text-terminal-muted">{strategy === "IRON_CONDOR" ? "Center Strike" : "Strike"}</label>
                <select className="mt-1 w-full rounded border border-terminal-line bg-terminal-input p-2 text-sm text-terminal-text" value={mainStrike} onChange={(event) => { setMainStrike(Number(event.target.value)); setQuote(null); clearSignal(); }}>
                  {strikeChoices.map((strike) => (
                    <option key={strike} value={strike}>{strike === overview.snapshot.atmStrike ? `${strike} (ATM)` : strike}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <div>
              <label className="block text-[0.65rem] uppercase text-terminal-muted">Lots</label>
              <input className="mt-1 w-full rounded border border-terminal-line bg-terminal-input p-2 text-sm text-terminal-text" min={1} max={100} type="number" value={lots} onChange={(event) => { setLots(Math.max(1, Number(event.target.value) || 1)); setQuote(null); }} />
            </div>
          </div>

          {showWingWidth ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[0.65rem] uppercase text-terminal-muted">Wing Width</label>
                <input className="mt-1 w-full rounded border border-terminal-line bg-terminal-input p-2 text-sm text-terminal-text" min={strikeStep} step={strikeStep} type="number" value={wingWidth} onChange={(event) => { setWingWidth(Number(event.target.value) || strikeStep); setQuote(null); clearSignal(); }} />
              </div>
              {showCondorOffset ? (
                <div>
                  <label className="block text-[0.65rem] uppercase text-terminal-muted">Short Offset</label>
                  <input className="mt-1 w-full rounded border border-terminal-line bg-terminal-input p-2 text-sm text-terminal-text" min={strikeStep} step={strikeStep} type="number" value={condorOffset} onChange={(event) => { setCondorOffset(Number(event.target.value) || strikeStep); setQuote(null); clearSignal(); }} />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 rounded bg-terminal-input p-2 text-[0.7rem] text-terminal-muted">
            {legs.map((leg, index) => (
              <div key={index}>{leg.side === "SELL" ? "Sell" : "Buy"} {leg.strikePrice} {leg.optionType}</div>
            ))}
          </div>

          <button className="mt-2 w-full rounded border border-terminal-blue bg-terminal-blue/10 py-2 text-sm font-semibold text-terminal-blue transition hover:bg-terminal-blue hover:text-white disabled:opacity-60" disabled={isQuoting} type="button" onClick={() => void handleQuote()}>
            {isQuoting ? "Pricing..." : "Get Realistic Quote"}
          </button>

          {quoteError ? <p className="mt-2 text-xs text-terminal-red">{quoteError}</p> : null}

          {quote ? (
            <div className="mt-2 rounded border border-terminal-line bg-terminal-input p-2 text-xs">
              <div className="flex justify-between"><span className="text-terminal-muted">Net credit (slippage chi={quote.slippageChi})</span><span className="font-semibold text-terminal-text">{formatInr(quote.netCreditTotal)}</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">Max loss</span><span className={quote.maxLossTotal !== null ? "text-terminal-text" : "text-terminal-red"}>{quote.maxLossTotal !== null ? formatInr(quote.maxLossTotal) : "Undefined"}</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">Buying power effect</span><span>{formatInr(quote.bpe)}</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">POP (delta-based)</span><span className="text-terminal-emerald">{quote.popEstimate != null ? `~${quote.popEstimate.toFixed(0)}%` : "--"}</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">IV / HV(20)</span><span className={quote.lowEdgeFlag ? "text-terminal-amber" : "text-terminal-text"}>{quote.ivHvRatio != null ? quote.ivHvRatio.toFixed(2) : "--"}{quote.lowEdgeFlag ? " (low edge)" : ""}</span></div>
              {quote.legs.map((leg, index) => (
                <div key={index} className="mt-1 text-[0.65rem] text-terminal-muted">
                  <div className="flex justify-between">
                    <span>{leg.side === "SELL" ? "-" : "+"}{leg.strikePrice}{leg.optionType} (bid {leg.bid.toFixed(2)} / ask {leg.ask.toFixed(2)})</span>
                    <span className={leg.rejectReason ? "text-terminal-red" : "text-terminal-text"}>{leg.rejectReason ? "REJECTED" : `fill ${leg.fillPrice.toFixed(2)}`}</span>
                  </div>
                  {leg.tranches ? (
                    <div className="mt-0.5 pl-2 text-terminal-amber">
                      Partial fill (thin volume): {leg.tranches.map((tranche) => `${tranche.lots} lots @ ${tranche.price.toFixed(2)}`).join(", ")}
                    </div>
                  ) : null}
                </div>
              ))}
              {quote.rejectReason ? <p className="mt-1 text-terminal-red">{quote.rejectReason}</p> : null}
              <button className="mt-2 w-full rounded bg-terminal-blue py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60" disabled={!quote.ok || isPlacing} type="button" onClick={() => void handlePlace()}>
                {isPlacing ? "Placing..." : quote.ok ? "Place Sim Trade" : "Order Not Placeable"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* BOTTOM: seller analytics strip */}
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded border border-terminal-line bg-terminal-panel p-2 text-center">
          <div className={`text-base font-semibold ${pnlClass(analytics?.totalRealizedPnl)}`}>{formatInr(analytics?.totalRealizedPnl)}</div>
          <div className="text-[0.65rem] uppercase text-terminal-muted">Realized P&L</div>
        </div>
        <div className="rounded border border-terminal-line bg-terminal-panel p-2 text-center">
          <div className={`text-base font-semibold ${pnlClass(analytics?.expectancy)}`}>{analytics?.expectancy != null ? formatInr(analytics.expectancy) : "--"}</div>
          <div className="text-[0.65rem] uppercase text-terminal-muted">Expectancy / trade</div>
        </div>
        <div className="rounded border border-terminal-line bg-terminal-panel p-2 text-center">
          <div className={`text-base font-semibold ${analytics?.tailRiskRatio != null && analytics.tailRiskRatio > 5 ? "text-terminal-red" : "text-terminal-text"}`}>{analytics?.tailRiskRatio != null ? `${analytics.tailRiskRatio.toFixed(1)} : 1` : "--"}</div>
          <div className="text-[0.65rem] uppercase text-terminal-muted">Tail-risk ratio</div>
        </div>
        <div className="rounded border border-terminal-line bg-terminal-panel p-2 text-center">
          <div className="text-base font-semibold text-terminal-text">{analytics?.thetaEfficiency != null ? `${analytics.thetaEfficiency.toFixed(0)}%` : "--"}</div>
          <div className="text-[0.65rem] uppercase text-terminal-muted">Theta efficiency</div>
        </div>
        <div className="rounded border border-terminal-line bg-terminal-panel p-2 text-center">
          <div className="text-base font-semibold text-terminal-text">{analytics?.avgIvHvRatio != null ? analytics.avgIvHvRatio.toFixed(2) : "--"}</div>
          <div className="text-[0.65rem] uppercase text-terminal-muted">Avg IV/HV entry</div>
        </div>
        <div className="rounded border border-terminal-line bg-terminal-panel p-2 text-center">
          <div className="text-base font-semibold text-terminal-text">{analytics ? `${analytics.wins} / ${analytics.totalTrades}` : "--"}</div>
          <div className="text-[0.65rem] uppercase text-terminal-muted">Wins / trades</div>
        </div>
      </div>

      {/* Signal scorecard: which Decision Matrix regimes actually pay */}
      {analytics && analytics.signalScorecard.length > 0 ? (
        <div className="mt-3 rounded border border-terminal-line bg-terminal-panel p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">Signal Scorecard - P&L by DRCR regime at entry</h2>
          <table className="mt-2 w-full text-left text-xs">
            <thead>
              <tr className="border-b border-terminal-line text-[0.65rem] uppercase text-terminal-muted">
                <th className="py-1.5 pr-2">Regime</th>
                <th className="py-1.5 pr-2">Horizon</th>
                <th className="py-1.5 pr-2">Trades</th>
                <th className="py-1.5 pr-2">Win rate</th>
                <th className="py-1.5 text-right">Total P&L</th>
              </tr>
            </thead>
            <tbody>
              {analytics.signalScorecard.map((row) => (
                <tr key={`${row.regime}-${row.horizon}`} className="border-b border-terminal-line/40">
                  <td className={`py-1.5 pr-2 font-semibold ${row.regime === "Bullish" ? "text-terminal-emerald" : row.regime === "Bearish" ? "text-terminal-red" : "text-terminal-text"}`}>{row.regime}</td>
                  <td className="py-1.5 pr-2 text-terminal-muted">{row.horizon}</td>
                  <td className="py-1.5 pr-2">{row.trades}</td>
                  <td className="py-1.5 pr-2">{row.trades > 0 ? `${Math.round((row.wins / row.trades) * 100)}%` : "--"}</td>
                  <td className={`py-1.5 text-right font-semibold ${pnlClass(row.totalPnl)}`}>{formatInr(row.totalPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

"use client";

// Strike Matrix tab ("New Dashboard ver 1.0"): reads the WCI / DRC / DRCR
// analysis computed server-side by @option-decode/analytics#calculateStrikeMatrix
// via /api/market/strike-matrix. Symbol + expiry come from the shared Market
// Controls above this panel (same as every other tab); this panel owns only
// the horizon selection and the historical trading-date calendar.
//
// Layout goal from the requirements doc: everything visible on one page —
// no vertical or horizontal scrolling — so the universe table is capped to
// the strikes inside the horizon's delta band (a naturally small set) and
// the cards stay in a fixed grid.

import { Crosshair, FlaskConical, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DRCR_BANDS } from "@option-decode/types";
import type { StrikeMatrixAnalysis, StrikeMatrixRow, TradingHorizon } from "@option-decode/types";
import { CalendarDatePicker } from "./calendar-date-picker";
import { formatPrice } from "./dashboard-formatters";
import { fetchReplayTradingDates, fetchStrikeMatrix } from "./dashboard-client";
import type { StrikeMatrixResponse } from "./dashboard-client";
import { buildSimDraft, storeSimTicketDraft } from "./sim-ticket-draft";
import type { SimTicketDraft } from "./sim-ticket-draft";

const HORIZON_LABELS: Array<[TradingHorizon, string]> = [
  ["intraday", "Intraday"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"]
];

// Doc cadence: 1-min refresh for intraday, slower horizons don't need
// aggressive polling (weekly/monthly reads change on the day scale).
const REFRESH_MS: Record<TradingHorizon, number> = {
  intraday: 60_000,
  weekly: 5 * 60_000,
  monthly: 15 * 60_000
};


interface StrikeMatrixPanelProps {
  underlying: string;
  expiry: string;
  formatStrike: (value: number) => string;
  formatTime: (value: string) => string;
  // Phase 2 handoff: store the recommendation as a sim-ticket draft and
  // navigate to the Paper Trading Pro tab. Optional so this panel stays
  // usable anywhere the pro module isn't wired up.
  onPaperTradePro?: () => void;
}

export function StrikeMatrixPanel({ underlying, expiry, formatStrike, formatTime, onPaperTradePro }: StrikeMatrixPanelProps) {
  const [horizon, setHorizon] = useState<TradingHorizon>("intraday");
  const [tradingDate, setTradingDate] = useState("");
  const [tradingDates, setTradingDates] = useState<string[]>([]);
  const [data, setData] = useState<StrikeMatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadMatrix = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetchStrikeMatrix(underlying, expiry, horizon, tradingDate || undefined);
      setData(response);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Strike matrix could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, [underlying, expiry, horizon, tradingDate]);

  useEffect(() => {
    void loadMatrix();
    // Poll only in live mode - a historical date's last snapshot never changes.
    if (tradingDate) {
      return;
    }
    const timer = window.setInterval(() => void loadMatrix(), REFRESH_MS[horizon]);
    return () => window.clearInterval(timer);
  }, [loadMatrix, horizon, tradingDate]);

  useEffect(() => {
    let cancelled = false;
    fetchReplayTradingDates(underlying, expiry)
      .then((dates) => {
        if (!cancelled) {
          setTradingDates(dates);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTradingDates([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [underlying, expiry]);

  const analysis = data?.analysis;
  const universeRows = useMemo(() => buildUniverseRows(analysis), [analysis]);

  return (
    <section className="grid gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3 rounded border border-terminal-line bg-terminal-panel/80 p-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Crosshair size={17} className="text-terminal-blue" />
            Strike Matrix
          </h2>
          <p className="mt-1 text-sm text-terminal-muted">
            WCI / DRC / DRCR market bias and decision-matrix trade candidates
            {data ? ` — snapshot ${formatTime(data.snapshotTime)} IST${tradingDate ? " (historical)" : ""}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1 text-xs uppercase text-terminal-muted">
            Horizon
            <div className="flex rounded border border-terminal-line bg-terminal-input p-0.5">
              {HORIZON_LABELS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded px-3 py-1.5 text-sm font-semibold transition ${horizon === value ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`}
                  onClick={() => setHorizon(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-1 text-xs uppercase text-terminal-muted">
            Trading date
            <div className="flex gap-2">
              <CalendarDatePicker availableDates={tradingDates} value={tradingDate} onChange={setTradingDate} placeholder="Live (latest)" emptyLabel="No stored trading dates yet." />
              {tradingDate ? (
                <button type="button" className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" onClick={() => setTradingDate("")}>
                  Live
                </button>
              ) : null}
            </div>
          </div>
          <button type="button" className="grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" onClick={() => void loadMatrix()} aria-label="Refresh strike matrix">
            <RefreshCw size={17} className={isLoading ? "animate-spin" : ""} />
          </button>
        </div>
        {error ? <p className="basis-full text-sm text-terminal-red">{error}</p> : null}
      </header>

      {analysis ? (
        <>
          {/* The horizon toggle picks the analysis framework; the expiry
              dropdown picks the contract. They can disagree - say so
              rather than silently applying one horizon's delta band and
              risk rule to a contract of a completely different tenor. */}
          {analysis.horizonTenorMismatch ? (
            <p className="rounded border border-terminal-amber/50 bg-terminal-amber/10 px-3 py-2 text-xs text-terminal-amber">{analysis.horizonTenorMismatch}</p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {/* A missing DRCR is usually a real market state, not missing
                data, and "--" cannot tell the two apart. It rendered "--"
                whenever one side had no qualifying strike - which is exactly
                when the signal is strongest. Live example, NIFTY 2026-08-20
                intraday: both calls in the 0.15-0.25 band were being unwound
                (OI change -2,027,805 and -461,890) while both puts were being
                written (+605,800, +1,806,220). Negative OI change gives a
                negative WCI, which cannot clear a positive conviction
                threshold, so callDrcTotal was 0 and the ratio had no finite
                value. BANKNIFTY and SENSEX priced a DRCR normally on the same
                request, so nothing was broken - the panel just looked it.
                The engine already distinguishes these cases (see
                readWriterFlow in analytics/strike-matrix.ts); this only
                surfaces the distinction it was already making. */}
            <MetricCard label="DRCR (Put ΣDRC / Call ΣDRC)" value={drcrDisplay(analysis)} sub={`Put ${formatCompact(analysis.putDrcTotal)} / Call ${formatCompact(analysis.callDrcTotal)}`} tone={biasTone(analysis.bias)} />
            {/* Deliberately NOT called "Market bias" any more. The Dashboard's
                own "Chain Bias" chip is a different signal over a different
                universe (whole chain, both OI directions) and users read the
                shared word as a promise the two agree - they routinely don't,
                by design. This one is writer flow in the far-OTM band only. */}
            <MetricCard
              label="Writer flow bias (DRCR)"
              value={hasWriterFlow(analysis) ? analysis.bias : "No data"}
              sub={biasBandText(analysis)}
              tone={hasWriterFlow(analysis) ? biasTone(analysis.bias) : undefined}
            />
            <MetricCard label="Active universe" value={`${analysis.universe.length} strikes`} sub={`|Δ| ${analysis.deltaMin.toFixed(2)}–${analysis.deltaMax.toFixed(2)} · target Δ ±${analysis.targetDelta.toFixed(2)}`} />
            <MetricCard label="WCI threshold" value={`> ${analysis.wciThreshold.toFixed(2)}`} sub={horizon === "intraday" ? "Intraday bar" : "Overnight/weekend bar"} />
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="grid gap-3 content-start">
              <div className="grid gap-2 sm:grid-cols-2">
                <WallCard title="Call wall (resistance)" wall={analysis.callWall} formatStrike={formatStrike} threshold={analysis.wciThreshold} />
                <WallCard title="Put wall (support)" wall={analysis.putWall} formatStrike={formatStrike} threshold={analysis.wciThreshold} />
              </div>

              <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
                <h3 className="text-sm font-semibold uppercase text-terminal-muted">Decision matrix recommendation</h3>
                {analysis.recommendation ? (
                  <div className="mt-2 grid gap-2">
                    <p className="text-base font-semibold text-terminal-text">{analysis.recommendation.structure}</p>
                    <div className="flex flex-wrap gap-2 text-sm">
                      {analysis.recommendation.putStrike !== undefined ? (
                        <span className="rounded border border-terminal-emerald/50 bg-terminal-emerald/10 px-2 py-1 text-terminal-emerald">
                          Sell PE {formatStrike(analysis.recommendation.putStrike)} (Δ {analysis.recommendation.putStrikeDelta?.toFixed(2) ?? "--"})
                        </span>
                      ) : null}
                      {analysis.recommendation.callStrike !== undefined ? (
                        <span className="rounded border border-terminal-red/50 bg-terminal-red/10 px-2 py-1 text-terminal-red">
                          Sell CE {formatStrike(analysis.recommendation.callStrike)} (Δ {analysis.recommendation.callStrikeDelta?.toFixed(2) ?? "--"})
                        </span>
                      ) : null}
                      <span className="rounded border border-terminal-line bg-terminal-input px-2 py-1 text-terminal-muted">Target Δ ±{analysis.recommendation.targetDelta.toFixed(2)}</span>
                      <span className="rounded border border-terminal-line bg-terminal-input px-2 py-1 text-terminal-muted">~{analysis.recommendation.theoreticalPop}% POP</span>
                    </div>
                    <p className="text-sm text-terminal-muted">{analysis.recommendation.note}</p>
                    {/* The structure above comes purely from the DRCR bias
                        cell; it doesn't require an institutional wall to
                        exist. Say so plainly when one doesn't, instead of
                        rendering an unbacked structure identically to a
                        fully-backed one. */}
                    {!analysis.recommendation.wallBacked ? (
                      <p className="text-xs text-terminal-amber">
                        No qualifying {analysis.recommendation.unbackedSides.join(" or ")} wall behind this structure (WCI never cleared {analysis.wciThreshold.toFixed(2)} on{" "}
                        {analysis.recommendation.unbackedSides.length > 1 ? "either side" : "that side"}) — the bias is from DRCR alone, without institutional backing at the strike.
                      </p>
                    ) : null}
                    {onPaperTradePro && data ? (() => {
                      const draft = buildSimDraft(underlying, expiry, horizon, data);
                      if (!draft) {
                        return null;
                      }
                      // The conviction gate the sim server enforces: below the
                      // horizon's WCI threshold the wall lacks institutional
                      // backing, so the trade can only be placed as a manual
                      // practice trade (no signal attribution, no scorecard).
                      // draft.wci is now only ever populated from a wall that
                      // already cleared the signed threshold (see
                      // buildSimDraft above), so this is a defensive re-check,
                      // not the primary gate - and must stay signed to match.
                      const hasConviction = draft.wci !== null && draft.wci > analysis.wciThreshold;
                      const buttonDraft = hasConviction ? draft : { ...draft, signalRef: "", wci: null, drcr: null, note: `${draft.note} (low conviction - WCI ${draft.wci?.toFixed(2) ?? "--"} below ${analysis.wciThreshold})` };
                      return (
                        <div className="mt-1 grid gap-1">
                          <button
                            className={`inline-flex w-fit items-center gap-2 rounded border px-3 py-1.5 text-sm font-semibold transition ${hasConviction ? "border-terminal-blue bg-terminal-blue/10 text-terminal-blue hover:bg-terminal-blue hover:text-white" : "border-terminal-amber bg-terminal-amber/10 text-terminal-amber hover:bg-terminal-amber hover:text-black"}`}
                            type="button"
                            onClick={() => {
                              storeSimTicketDraft(buttonDraft);
                              onPaperTradePro();
                            }}
                          >
                            <FlaskConical size={15} />
                            {hasConviction ? "Paper Trade This" : "Practice Trade (low conviction)"}
                          </button>
                          {!hasConviction ? (
                            <p className="text-xs text-terminal-amber">
                              Wall WCI {draft.wci?.toFixed(2) ?? "--"} is below the {analysis.wciThreshold} conviction threshold - this places as a manual practice trade, not a signal trade.
                            </p>
                          ) : null}
                        </div>
                      );
                    })() : null}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-terminal-muted">
                    {analysis.bias === "Transitional"
                      ? "DRCR is in a transitional band — writer flow has no tradable skew. Stand aside until it resolves into a defined bias."
                      : "No execution strike inside the delta band on the required side(s) — widen data coverage or wait for the chain to fill."}
                  </p>
                )}
                <div className="mt-3 border-t border-terminal-line/70 pt-2 text-xs">
                  <p className="text-terminal-amber">Risk rule — {analysis.riskRule}</p>
                  <p
                    className={`mt-1 ${
                      analysis.riskRuleStatus.satisfied === true
                        ? "text-terminal-emerald"
                        : analysis.riskRuleStatus.satisfied === false
                          ? "text-terminal-red"
                          : "text-terminal-muted"
                    }`}
                  >
                    {analysis.riskRuleStatus.satisfied === true ? "Cleared — " : analysis.riskRuleStatus.satisfied === false ? "Not cleared — " : "Unevaluated — "}
                    {analysis.riskRuleStatus.detail}
                  </p>
                </div>
                {analysis.institutionalUnwinding ? (
                  <p className="mt-2 border-t border-terminal-line/70 pt-2 text-xs text-terminal-red">
                    Institutional Unwinding — CE {formatStrike(analysis.institutionalUnwinding.strikePrice)} is covering (OI {analysis.institutionalUnwinding.oiChange.toFixed(0)}, Δ{" "}
                    {analysis.institutionalUnwinding.delta.toFixed(2)}). If you&apos;re short this or a nearby call, treat this as an exit/roll signal.
                  </p>
                ) : null}
              </article>
            </div>

            <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
              <h3 className="text-sm font-semibold uppercase text-terminal-muted">Active universe (|Δ| {analysis.deltaMin.toFixed(2)}–{analysis.deltaMax.toFixed(2)})</h3>
              {universeRows.length ? (
                <table className="mt-2 w-full border-collapse text-right text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-terminal-line text-xs uppercase text-terminal-muted">
                      <th className="py-1.5 pr-2 text-left">Type</th>
                      <th className="py-1.5 pr-2">Strike</th>
                      <th className="py-1.5 pr-2">LTP</th>
                      <th className="py-1.5 pr-2">Delta</th>
                      <th className="py-1.5 pr-2">OI Chg</th>
                      <th className="py-1.5 pr-2">Volume</th>
                      <th className="py-1.5 pr-2">WCI</th>
                      <th className="py-1.5">DRC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {universeRows.map((row) => (
                      <tr key={`${row.optionType}-${row.strikePrice}`} className={`border-b border-terminal-line/40 ${isHighlighted(row, analysis) ? "bg-terminal-blue/10" : ""}`}>
                        <td className={`py-1 pr-2 text-left font-semibold ${row.optionType === "CE" ? "text-terminal-red" : "text-terminal-emerald"}`}>
                          {row.optionType}
                          {isWall(row, analysis) ? <span className="ml-1 rounded bg-terminal-amber/20 px-1 text-[0.65rem] text-terminal-amber">WALL</span> : null}
                        </td>
                        <td className="py-1 pr-2">{formatStrike(row.strikePrice)}</td>
                        <td className="py-1 pr-2">{formatPrice(row.lastPrice)}</td>
                        <td className="py-1 pr-2">{row.delta.toFixed(2)}</td>
                        <td className="py-1 pr-2">{formatCompact(row.oiChange)}</td>
                        <td className="py-1 pr-2">{formatCompact(row.volume)}</td>
                        <td className={`py-1 pr-2 font-semibold ${wciToneClass(row.wci, analysis.wciThreshold)}`}>{row.wci === undefined ? "--" : row.wci.toFixed(2)}</td>
                        <td className="py-1">{formatCompact(row.drc)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-2 text-sm text-terminal-muted">No strikes carry a delta inside this horizon&apos;s band in the current snapshot.</p>
              )}
            </article>
          </div>
        </>
      ) : (
        <p className="rounded border border-terminal-line bg-terminal-panel/80 p-3 text-sm text-terminal-muted">{isLoading ? "Loading strike matrix..." : "Strike matrix data is not available yet."}</p>
      )}
    </section>
  );
}

function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "emerald" | "red" | "amber" }) {
  const valueClass = tone === "emerald" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : tone === "amber" ? "text-terminal-amber" : "text-terminal-text";
  return (
    <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
      <p className="text-xs font-semibold uppercase text-terminal-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${valueClass}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-terminal-muted">{sub}</p> : null}
    </article>
  );
}

function WallCard({ title, wall, formatStrike, threshold }: { title: string; wall?: StrikeMatrixAnalysis["callWall"]; formatStrike: (value: number) => string; threshold: number }) {
  return (
    <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
      <p className="text-xs font-semibold uppercase text-terminal-muted">{title}</p>
      {wall ? (
        <>
          <p className="mt-1 text-xl font-semibold text-terminal-text">{formatStrike(wall.strikePrice)}</p>
          <p className="mt-0.5 text-xs text-terminal-muted">
            WCI <span className={wall.meetsThreshold ? "font-semibold text-terminal-emerald" : "font-semibold text-terminal-amber"}>{wall.wci.toFixed(2)}</span>
            {wall.meetsThreshold ? " · institutional" : ` · below ${threshold.toFixed(2)} bar`} · Δ {wall.delta.toFixed(2)}
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-terminal-muted">No qualifying strike in band.</p>
      )}
    </article>
  );
}

// Puts descending strike above calls ascending keeps the table reading like
// a chain: resistance side (CE) then support side (PE), each nearest-ATM
// first, without needing a scrollbar for the doc's single-page rule.
function buildUniverseRows(analysis?: StrikeMatrixAnalysis): StrikeMatrixRow[] {
  if (!analysis) {
    return [];
  }
  const calls = analysis.universe.filter((row) => row.optionType === "CE").sort((a, b) => a.strikePrice - b.strikePrice);
  const puts = analysis.universe.filter((row) => row.optionType === "PE").sort((a, b) => b.strikePrice - a.strikePrice);
  return [...calls, ...puts];
}

function isWall(row: StrikeMatrixRow, analysis: StrikeMatrixAnalysis): boolean {
  const wall = row.optionType === "CE" ? analysis.callWall : analysis.putWall;
  return wall !== undefined && wall.strikePrice === row.strikePrice;
}

function isHighlighted(row: StrikeMatrixRow, analysis: StrikeMatrixAnalysis): boolean {
  const recommendation = analysis.recommendation;
  if (!recommendation) {
    return false;
  }
  return (row.optionType === "CE" && recommendation.callStrike === row.strikePrice) || (row.optionType === "PE" && recommendation.putStrike === row.strikePrice);
}

function wciToneClass(wci: number | undefined, threshold: number): string {
  if (wci === undefined) {
    return "text-terminal-muted";
  }
  if (wci > threshold) {
    return "text-terminal-emerald";
  }
  if (wci < 0) {
    return "text-terminal-red";
  }
  return "text-terminal-text";
}

function biasTone(bias: StrikeMatrixAnalysis["bias"]): "emerald" | "red" | "amber" | undefined {
  if (bias === "Bullish") {
    return "emerald";
  }
  if (bias === "Bearish") {
    return "red";
  }
  if (bias === "Transitional") {
    return "amber";
  }
  return undefined;
}

// "Transitional" covers two states that mean opposite things to a trader:
// an ambiguous-but-real reading (DRCR landed in a gap band), and no reading
// at all (nothing in the delta band opened OI, so there was nothing to
// measure). Showing one word for both let an empty chain look like a market
// call - confirmed live on NIFTY 2026-08-11, where the weekly band had ZERO
// qualifying strikes and still rendered as a bias.
function hasWriterFlow(analysis: StrikeMatrixAnalysis): boolean {
  return analysis.putDrcCount > 0 || analysis.callDrcCount > 0;
}

// DRCR is put churn over call churn, so one side having no qualifying strike
// leaves no finite ratio. That is not an error and not missing data - it is
// the most one-sided reading the metric can produce, and naming it says so.
// Deliberately NOT rendered as a number: a fabricated value from a zero
// denominator would classify into a DRCR band and be read as comparable to a
// real ratio.
function drcrDisplay(analysis: StrikeMatrixAnalysis): string {
  if (analysis.drcr !== undefined) {
    return analysis.drcr.toFixed(2);
  }
  const puts = analysis.putDrcCount > 0;
  const calls = analysis.callDrcCount > 0;
  if (puts && !calls) {
    return "Puts only";
  }
  if (calls && !puts) {
    return "Calls only";
  }
  return "No flow";
}

// Band numbers come from DRCR_BANDS in @option-decode/types, the same
// constant classifyDrcr itself reads, so this caption can never quote a
// boundary the engine no longer uses. The sample size is appended because
// this band is narrow enough that a "bias" is frequently a one-strike-per-
// side ratio, which deserves to be visible rather than implied.
function biasBandText(analysis: StrikeMatrixAnalysis): string {
  const { bias, putDrcCount, callDrcCount } = analysis;
  if (!hasWriterFlow(analysis)) {
    return "No strikes in the delta band opened OI — nothing to measure";
  }
  const sample = `from ${putDrcCount} put / ${callDrcCount} call ${putDrcCount + callDrcCount === 1 ? "strike" : "strikes"}`;
  if (bias === "Bullish") {
    return `DRCR > ${DRCR_BANDS.bullishAbove} — put-side writer flow dominates · ${sample}`;
  }
  if (bias === "Bearish") {
    return `DRCR < ${DRCR_BANDS.bearishBelow} — call-side writer flow dominates · ${sample}`;
  }
  if (bias === "Neutral") {
    return `DRCR ${DRCR_BANDS.neutralFrom}–${DRCR_BANDS.neutralTo} — balanced writer flow · ${sample}`;
  }
  return `DRCR between defined bands — no tradable skew · ${sample}`;
}

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 10_000_000) {
    return `${sign}${(abs / 10_000_000).toFixed(2)}Cr`;
  }
  if (abs >= 100_000) {
    return `${sign}${(abs / 100_000).toFixed(2)}L`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}K`;
  }
  return `${sign}${abs.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

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

import { Crosshair, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StrikeMatrixAnalysis, StrikeMatrixRow, TradingHorizon } from "@option-decode/types";
import { CalendarDatePicker } from "./calendar-date-picker";
import { formatPrice } from "./dashboard-formatters";
import { fetchReplayTradingDates, fetchStrikeMatrix } from "./dashboard-client";
import type { StrikeMatrixResponse } from "./dashboard-client";

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
}

export function StrikeMatrixPanel({ underlying, expiry, formatStrike, formatTime }: StrikeMatrixPanelProps) {
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
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="DRCR (Put ΣDRC / Call ΣDRC)" value={analysis.drcr === undefined ? "--" : analysis.drcr.toFixed(2)} sub={`Put ${formatCompact(analysis.putDrcTotal)} / Call ${formatCompact(analysis.callDrcTotal)}`} tone={biasTone(analysis.bias)} />
            <MetricCard label="Market bias" value={analysis.bias} sub={biasBandText(analysis.bias)} tone={biasTone(analysis.bias)} />
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
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-terminal-muted">
                    {analysis.bias === "Transitional"
                      ? "DRCR is in a transitional band — writer flow has no tradable skew. Stand aside until it resolves into a defined bias."
                      : "No execution strike inside the delta band on the required side(s) — widen data coverage or wait for the chain to fill."}
                  </p>
                )}
                <p className="mt-3 border-t border-terminal-line/70 pt-2 text-xs text-terminal-amber">Risk rule — {analysis.riskRule}</p>
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

function biasBandText(bias: StrikeMatrixAnalysis["bias"]): string {
  if (bias === "Bullish") {
    return "DRCR > 1.5 — put-side writer flow dominates";
  }
  if (bias === "Bearish") {
    return "DRCR < 0.6 — call-side writer flow dominates";
  }
  if (bias === "Neutral") {
    return "DRCR 0.8–1.2 — balanced writer flow";
  }
  return "DRCR between defined bands — no tradable skew";
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

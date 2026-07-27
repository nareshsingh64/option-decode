"use client";

// Elliott Wave tab: reads the wave count computed server-side by
// @option-decode/analytics#calculateElliottWave via /api/market/elliott-wave.
// Standalone tab (kept separate from the Strike Matrix tab per the product
// decision) - it answers a different question (structural wave stage, off a
// spot-price series) using a different source (ZigZag over price history vs.
// live option-chain OI/volume).
//
// Layout goal, matching the Strike Matrix tab: everything visible on one
// page, no scrolling - the pivot table is capped to one wave cycle
// (start + up to 8 legs) so it never grows unbounded.

import { Bell, RefreshCw, Waves } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TradingHorizon, WaveRuleCheck } from "@option-decode/types";
import { fetchElliottWave, fetchWaveScreenerAlerts } from "./dashboard-client";
import type { ElliottWaveResponse, WaveScreenerAlertItem } from "./dashboard-client";

// Matches the API's own cache TTL for the alerts endpoint - see
// WAVE_ALERTS_CACHE_MS in apps/api/src/server.ts.
const ALERTS_REFRESH_MS = 60_000;

const HORIZON_LABELS: Array<[TradingHorizon, string]> = [
  ["intraday", "Intraday"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"]
];

// Matches the API's own per-horizon cache TTL - polling faster than that
// would just re-serve the same cached response.
const REFRESH_MS: Record<TradingHorizon, number> = {
  intraday: 60_000,
  weekly: 5 * 60_000,
  monthly: 15 * 60_000
};

interface ElliottWavePanelProps {
  underlying: string;
  formatStrike: (value: number) => string;
  formatTime: (value: string) => string;
}

export function ElliottWavePanel({ underlying, formatStrike, formatTime }: ElliottWavePanelProps) {
  const [horizon, setHorizon] = useState<TradingHorizon>("intraday");
  const [data, setData] = useState<ElliottWaveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadWave = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetchElliottWave(underlying, horizon);
      setData(response);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Elliott Wave analysis could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, [underlying, horizon]);

  useEffect(() => {
    void loadWave();
    const timer = window.setInterval(() => void loadWave(), REFRESH_MS[horizon]);
    return () => window.clearInterval(timer);
  }, [loadWave, horizon]);

  const analysis = data?.analysis;

  return (
    <section className="grid gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3 rounded border border-terminal-line bg-terminal-panel/80 p-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Waves size={17} className="text-terminal-blue" />
            Elliott Wave
          </h2>
          <p className="mt-1 text-sm text-terminal-muted">
            Wave-stage read from ZigZag pivots on the spot-price series, mapped to the strategy matrix
            {data ? ` — updated ${formatTime(analysis?.lastUpdated ?? data.analysis.lastUpdated)} IST` : ""}
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
          <button type="button" className="grid h-10 w-10 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" onClick={() => void loadWave()} aria-label="Refresh Elliott Wave analysis">
            <RefreshCw size={17} className={isLoading ? "animate-spin" : ""} />
          </button>
        </div>
        {error ? <p className="basis-full text-sm text-terminal-red">{error}</p> : null}
      </header>

      {analysis ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Current stage" value={analysis.currentStage} sub={analysis.invalidated ? "Count invalidated" : `${analysis.direction} sequence`} tone={analysis.invalidated ? "red" : stageTone(analysis.direction)} />
            <MetricCard label="Direction" value={analysis.direction} tone={analysis.direction === "Bullish" ? "emerald" : analysis.direction === "Bearish" ? "red" : undefined} />
            <MetricCard label="ZigZag threshold" value={`${data?.zigZagPercent.toFixed(2)}%`} sub={`${data?.pointCount ?? 0} spot samples in window`} />
            <MetricCard label="Last price" value={formatStrike(analysis.lastPrice)} sub={`as of ${formatTime(analysis.lastUpdated)}`} />
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="grid gap-3 content-start">
              <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
                <h3 className="text-sm font-semibold uppercase text-terminal-muted">Cardinal rule checks</h3>
                {analysis.ruleChecks.length ? (
                  <ul className="mt-2 grid gap-2">
                    {analysis.ruleChecks.map((check) => (
                      <RuleRow key={check.rule} check={check} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-terminal-muted">Not enough confirmed legs yet to evaluate the cardinal rules.</p>
                )}
                {analysis.invalidated ? <p className="mt-3 border-t border-terminal-line/70 pt-2 text-xs text-terminal-red">{analysis.invalidationReason}</p> : null}
              </article>

              <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
                <h3 className="text-sm font-semibold uppercase text-terminal-muted">Strategy mapping</h3>
                {analysis.recommendation ? (
                  <div className="mt-2 grid gap-2">
                    <p className="text-base font-semibold text-terminal-text">{analysis.recommendation.strategy}</p>
                    <div className="flex flex-wrap gap-2 text-sm">
                      <span className="rounded border border-terminal-line bg-terminal-input px-2 py-1 text-terminal-muted">{analysis.recommendation.context}</span>
                      <span className="rounded border border-terminal-line bg-terminal-input px-2 py-1 text-terminal-muted">{analysis.recommendation.riskProfile}</span>
                    </div>
                    <p className="text-sm text-terminal-muted">{analysis.recommendation.primaryGreek}</p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-terminal-muted">
                    {analysis.invalidated
                      ? "No recommendation while the count is invalidated - wait for a clean reversal to re-establish structure."
                      : analysis.currentStage === "Undetermined" || analysis.currentStage === "Corrective Phase"
                        ? "No strategy mapping for this stage - the matrix covers Waves 2 through 5 of an impulse."
                        : "Not enough confirmed swing structure yet."}
                  </p>
                )}
              </article>
            </div>

            <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
              <h3 className="text-sm font-semibold uppercase text-terminal-muted">Wave sequence &amp; Fibonacci</h3>
              {analysis.pivots.length ? (
                <table className="mt-2 w-full border-collapse text-right text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-terminal-line text-xs uppercase text-terminal-muted">
                      <th className="py-1.5 pr-2 text-left">Wave</th>
                      <th className="py-1.5 pr-2 text-left">Type</th>
                      <th className="py-1.5 pr-2">Price</th>
                      <th className="py-1.5">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.pivots.map((pivot, index) => (
                      <tr key={`${pivot.time}-${index}`} className="border-b border-terminal-line/40">
                        <td className="py-1 pr-2 text-left font-semibold text-terminal-text">{pivot.label ?? "Start"}</td>
                        <td className={`py-1 pr-2 text-left ${pivot.kind === "high" ? "text-terminal-red" : "text-terminal-emerald"}`}>{pivot.kind}</td>
                        <td className="py-1 pr-2">{formatStrike(pivot.price)}</td>
                        <td className="py-1">{formatTime(pivot.time)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-2 text-sm text-terminal-muted">Not enough ZigZag pivots confirmed yet in this window.</p>
              )}

              {analysis.fibonacciLevels.length ? (
                <div className="mt-3 grid gap-1.5 border-t border-terminal-line/70 pt-2">
                  {analysis.fibonacciLevels.map((level) => (
                    <div key={level.label} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span className="font-semibold text-terminal-text">{level.label}</span>
                      <span className={level.withinTarget ? "text-terminal-emerald" : "text-terminal-amber"}>
                        {level.actualPercent === undefined ? "--" : `${level.actualPercent.toFixed(1)}%`} (target {level.targetLow}%–{level.targetHigh}%)
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          </div>
        </>
      ) : (
        <p className="rounded border border-terminal-line bg-terminal-panel/80 p-3 text-sm text-terminal-muted">{isLoading ? "Loading Elliott Wave analysis..." : "Elliott Wave data is not available yet."}</p>
      )}

      <WaveScreenerAlertsFeed formatTime={formatTime} />
    </section>
  );
}

// Background screener feed: Wave 2 Reversal / Wave 3 Impulse alerts across
// the whole scanned universe (indices + F&O stocks), not scoped to the
// symbol picked in Market Controls above - the point of the screener is to
// surface setups on symbols the user isn't currently looking at. See
// apps/worker/src/wave-screener.ts for how these get created.
function WaveScreenerAlertsFeed({ formatTime }: { formatTime: (value: string) => string }) {
  const [alerts, setAlerts] = useState<WaveScreenerAlertItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAlerts = useCallback(async () => {
    try {
      const response = await fetchWaveScreenerAlerts(50);
      setAlerts(response);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Screener alerts could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void loadAlerts();
    const timer = window.setInterval(() => void loadAlerts(), ALERTS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadAlerts]);

  return (
    <article className="rounded border border-terminal-line bg-terminal-panel/80 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase text-terminal-muted">
        <Bell size={15} className="text-terminal-blue" />
        Screener alerts — Wave 2 Reversal &amp; Wave 3 Impulse
      </h3>
      <p className="mt-1 text-xs text-terminal-muted">Scans the full universe (indices + F&amp;O stocks) on a background schedule, independent of the symbol selected above.</p>
      {error ? <p className="mt-2 text-sm text-terminal-red">{error}</p> : null}
      {alerts.length ? (
        <ul className="mt-2 grid max-h-56 gap-1.5 overflow-y-auto pr-1">
          {alerts.map((alert) => (
            <li key={alert.id} className={`rounded border px-2 py-1.5 text-sm ${alert.alertType === "WAVE3_IMPULSE" ? "border-terminal-emerald/40 bg-terminal-emerald/10" : "border-terminal-blue/40 bg-terminal-blue/10"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-terminal-text">
                  {alert.underlyingSymbol} · {alert.alertType === "WAVE3_IMPULSE" ? "Wave 3 Impulse" : "Wave 2 Reversal"}
                </span>
                <span className="text-xs text-terminal-muted">{formatTime(alert.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-xs text-terminal-muted">{alert.message}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-terminal-muted">No screener alerts yet - the background scan runs every few minutes during market hours.</p>
      )}
    </article>
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

function RuleRow({ check }: { check: WaveRuleCheck }) {
  return (
    <li className={`rounded border px-2 py-1.5 text-sm ${check.passed ? "border-terminal-emerald/40 bg-terminal-emerald/10" : "border-terminal-red/40 bg-terminal-red/10"}`}>
      <p className={`font-semibold ${check.passed ? "text-terminal-emerald" : "text-terminal-red"}`}>{check.rule} — {check.passed ? "Holding" : "Broken"}</p>
      <p className="text-xs text-terminal-muted">{check.description}</p>
    </li>
  );
}

function stageTone(direction: "Bullish" | "Bearish" | "Undetermined"): "emerald" | "red" | "amber" | undefined {
  if (direction === "Bullish") return "emerald";
  if (direction === "Bearish") return "red";
  return "amber";
}

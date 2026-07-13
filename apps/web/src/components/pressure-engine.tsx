import type { ReactNode } from "react";

interface PressureEngineProps {
  overview: any;
  pressureSummary: any;
  chainStats: any;
  zoneRows: any[];
  secondsToRefresh: number;
  refreshSeconds: number;
  lastRefresh: string;
  isMarketStreamConnected: boolean;
  refreshError: string | null;
  formatTime: (value: string) => string;
  formatStrike: (value: number) => string;
  scoreToPercent: (value: number) => number;
  buildPressureSignals: (overview: any, chainStats: any) => Array<{ label: string; value: string; detail: string; tone: "blue" | "green" | "red" }>;
}

export function PressureEngine({
  overview,
  pressureSummary,
  chainStats,
  zoneRows,
  secondsToRefresh,
  refreshSeconds,
  lastRefresh,
  isMarketStreamConnected,
  refreshError,
  formatTime,
  formatStrike,
  scoreToPercent,
  buildPressureSignals
}: PressureEngineProps) {
  return (
    <>
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.6fr)]">
        <Panel title="Live Market Pressure">
          <div className="grid gap-4 md:grid-cols-2">
            <PressureGauge label="Bullish Pressure" value={overview.pressure.bullishPressure} tone="emerald" detail="PE support dominance" />
            <PressureGauge label="Bearish Pressure" value={overview.pressure.bearishPressure} tone="red" detail="CE resistance dominance" />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <SignalCell label="Bias" value={pressureSummary.bias} detail={pressureSummary.biasDetail} tone="blue" />
            <SignalCell label="Readiness" value={pressureSummary.readiness} detail={pressureSummary.readinessDetail} tone="green" />
            <SignalCell label="PCR Context" value={overview.pressure.pcr?.toFixed(2) ?? "--"} detail={chainStats.breadth} tone="blue" />
            {overview.atmStraddle ? (
              // The playbook's ATM Straddle Rule: ATM CE + ATM PE premium is
              // the market's own priced-in expected move for this expiry.
              // Kept separate from the VIX-derived range shown on the option
              // chain panel - two independent methods, not one replacing
              // the other.
              <SignalCell
                label="Weekly Expected Move (ATM Straddle)"
                value={`± ${formatStrike(overview.atmStraddle.atmStraddlePrice)}`}
                detail={`Range ${formatStrike(overview.atmStraddle.expectedLowerBoundary)} – ${formatStrike(overview.atmStraddle.expectedUpperBoundary)} · sell OTM strikes outside this band`}
                tone="blue"
              />
            ) : null}
          </div>
        </Panel>
        <Panel title="Refresh Status">
          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-terminal-muted">Next refresh</span>
              <span className="font-semibold text-terminal-blue">{secondsToRefresh}s</span>
            </div>
            <div className="h-2 rounded bg-white/10">
              <div className="h-2 rounded bg-terminal-blue transition-all" style={{ width: `${Math.max(0, Math.min(100, ((refreshSeconds - secondsToRefresh) / refreshSeconds) * 100))}%` }} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-terminal-muted">Last local update</span>
              <span className="text-right">
                <span className="block font-semibold">{formatTime(lastRefresh)}</span>
                <span className={`text-xs font-semibold ${isMarketStreamConnected ? "text-terminal-emerald" : "text-terminal-amber"}`}>{isMarketStreamConnected ? "Live stream" : "Polling fallback"}</span>
              </span>
            </div>
            <SummaryLine label="Data coverage" value={`${overview.snapshot.ticks.length} contracts`} />
            <SummaryLine label="Strongest level" value={pressureSummary.strongestLevelText} />
            {refreshError ? <p className="text-terminal-red">{refreshError}</p> : null}
          </div>
        </Panel>
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="Support & Resistance Pressure">
          <div className="space-y-4">
            {overview.pressure.supportZones.slice(0, 2).map((zone: any) => (
              <div key={`support-${zone.strikePrice}`}>
                <PressureBar label={`Support ${formatStrike(zone.strikePrice)} PE`} value={scoreToPercent(zone.score)} tone="emerald" />
                {zone.trueZone !== undefined ? (
                  <p className="mt-1 text-[0.65rem] text-terminal-muted">True support (strike − premium collected): {formatStrike(zone.trueZone)}</p>
                ) : null}
              </div>
            ))}
            {overview.pressure.resistanceZones.slice(0, 2).map((zone: any) => (
              <div key={`resistance-${zone.strikePrice}`}>
                <PressureBar label={`Resistance ${formatStrike(zone.strikePrice)} CE`} value={scoreToPercent(zone.score)} tone="blue" />
                {zone.trueZone !== undefined ? (
                  <p className="mt-1 text-[0.65rem] text-terminal-muted">True resistance (strike + premium collected): {formatStrike(zone.trueZone)}</p>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
        <SupportResistanceZonesPanel zoneRows={zoneRows} formatStrike={formatStrike} />
        <Panel title="Pressure Signal Board">
          <div className="grid gap-3">
            {buildPressureSignals(overview, chainStats).map((signal) => (
              <SignalCell key={signal.label} label={signal.label} value={signal.value} detail={signal.detail} tone={signal.tone} />
            ))}
          </div>
        </Panel>
      </section>
    </>
  );
}

// Support & Resistance Zones as an actual table, with a True Zone column
// (the playbook's breakeven-cushion math: strike offset by premium
// collected there) alongside the raw OI-wall strike. Exported so
// dashboard-main-panel.tsx can render the identical block next to Trade
// Recommendations on the main Dashboard tab, instead of a hand-copied
// duplicate that can silently drift from this one.
export function SupportResistanceZonesPanel({ zoneRows, formatStrike, title = "Support & Resistance Zones" }: { zoneRows: any[]; formatStrike: (value: number) => string; title?: string }) {
  return (
    <TerminalPanel title={title}>
      <div className="overflow-x-auto rounded border border-terminal-line">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-terminal-line text-left text-xs uppercase text-terminal-muted">
              <th className="px-2 py-2 font-medium">Level</th>
              <th className="px-2 py-2 font-medium">Strike</th>
              <th className="px-2 py-2 font-medium">True Zone</th>
              <th className="px-2 py-2 font-medium">Weighted True Zone</th>
              <th className="px-2 py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {zoneRows.map((row) => (
              <tr key={row.label} className={`border-b border-terminal-line/60 last:border-b-0 ${row.isCurrent ? "bg-terminal-blue/15" : ""}`}>
                <td className={`whitespace-nowrap px-2 py-2 font-semibold ${row.tone === "green" ? "text-terminal-emerald" : row.tone === "red" ? "text-terminal-red" : "text-terminal-blue"}`}>{row.label}</td>
                <td className={`whitespace-nowrap px-2 py-2 font-semibold ${row.isCurrent ? "text-terminal-blue" : "text-terminal-text"}`}>{formatStrike(row.value)}</td>
                <td className="whitespace-nowrap px-2 py-2 text-terminal-muted">{row.trueZone !== undefined ? formatStrike(row.trueZone) : "--"}</td>
                <td className="whitespace-nowrap px-2 py-2 text-terminal-muted">
                  {row.weightedTrueZone !== undefined ? (
                    <>
                      {formatStrike(row.weightedTrueZone)}
                      <span className="ml-1 text-[0.6rem] text-terminal-muted/70">(avg ₹{row.avgSellPrice?.toFixed(1)})</span>
                    </>
                  ) : (
                    "--"
                  )}
                </td>
                <td className={`whitespace-nowrap px-2 py-2 text-right ${row.isCurrent ? "text-terminal-blue" : "text-terminal-muted"}`}>{row.status}</td>
              </tr>
            ))}
            {!zoneRows.length ? (
              <tr>
                <td colSpan={5} className="px-2 py-4 text-center text-terminal-muted">No support/resistance zones available.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[0.65rem] text-terminal-muted">True Zone = strike offset by the current premium (live LTP) — the writer&apos;s cost to enter right now. Weighted True Zone = strike offset by the OI-buildup-weighted average sell price from historical ticks — an approximation of what the open interest actually got sold for. The two can diverge; neither adjusts for OI unwinds.</p>
    </TerminalPanel>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TerminalPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-terminal-blue/30 bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SignalCell({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "blue" | "green" | "red" }) {
  const toneClass = tone === "green" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <p className="text-xs uppercase text-terminal-muted">{label}</p>
      <p className={`mt-2 text-lg font-semibold ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs text-terminal-muted">{detail}</p>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-line/70 pb-2 last:border-b-0 last:pb-0">
      <span className="text-terminal-muted">{label}</span>
      <span className="text-right font-semibold text-terminal-text">{value}</span>
    </div>
  );
}

function PressureGauge({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: "emerald" | "red" }) {
  const colorClass = tone === "emerald" ? "text-terminal-emerald" : "text-terminal-red";
  const barClass = tone === "emerald" ? "bg-terminal-emerald" : "bg-terminal-red";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm text-terminal-muted">{label}</span>
        <span className={`text-lg font-semibold ${colorClass}`}>{value}%</span>
      </div>
      <div className="h-3 rounded bg-white/10">
        <div className={`h-3 rounded ${barClass} transition-all`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <p className="mt-2 text-xs text-terminal-muted">{detail}</p>
    </div>
  );
}

function PressureBar({ label, value, tone }: { label: string; value: number; tone: "blue" | "emerald" }) {
  const barClass = tone === "emerald" ? "bg-terminal-emerald" : "bg-terminal-blue";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-terminal-muted">{label}</span>
        <span className="font-semibold">{value}%</span>
      </div>
      <div className="h-2 rounded bg-white/10">
        <div className={`h-2 rounded ${barClass}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

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
              <PressureBar key={`support-${zone.strikePrice}`} label={`Support ${formatStrike(zone.strikePrice)} PE`} value={scoreToPercent(zone.score)} tone="emerald" />
            ))}
            {overview.pressure.resistanceZones.slice(0, 2).map((zone: any) => (
              <PressureBar key={`resistance-${zone.strikePrice}`} label={`Resistance ${formatStrike(zone.strikePrice)} CE`} value={scoreToPercent(zone.score)} tone="blue" />
            ))}
          </div>
        </Panel>
        <TerminalPanel title="Support & Resistance Zones">
          <div className="grid gap-1">
            {zoneRows.map((row) => (
              <div key={row.label} className={`grid grid-cols-[3rem_minmax(6rem,1fr)_minmax(5rem,0.7fr)] items-center rounded px-2 py-2 ${row.isCurrent ? "bg-terminal-blue/15" : ""}`}>
                <span className={`text-sm font-semibold ${row.tone === "green" ? "text-terminal-emerald" : row.tone === "red" ? "text-terminal-red" : "text-terminal-blue"}`}>{row.label}</span>
                <span className={`text-center text-sm font-semibold ${row.isCurrent ? "text-terminal-blue" : "text-terminal-text"}`}>{formatStrike(row.value)}</span>
                <span className={`text-right text-sm ${row.isCurrent ? "text-terminal-blue" : "text-terminal-muted"}`}>{row.status}</span>
              </div>
            ))}
          </div>
        </TerminalPanel>
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

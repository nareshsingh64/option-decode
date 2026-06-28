import type { ReactNode } from "react";
import { Clock3 } from "lucide-react";
import { OptionChainTable } from "./option-chain-table";

interface OptionChainPanelProps {
  overview: any;
  formatStrike: any;
  chainRange: any;
  visibleStrikeMode: any;
  setVisibleStrikeMode: any;
  chainTableMode: any;
  setChainTableMode: any;
  isMarketStreamConnected: any;
  chainStats: any;
  formatLarge: any;
  numberFormatMode: any;
  formatSignedLarge: any;
  oiBuildupChart: any;
  ivSkewChart: any;
  chainRows: any;
  formatOptionalNumber: any;
  renderIvDeltaCell: any;
  renderLtpStack: any;
  renderPressureCell: any;
  topStrikeRows: any;
  zoneRows: any;
}

export function OptionChainPanel(props: OptionChainPanelProps) {
  const {
    overview,
    formatStrike,
    chainRange,
    visibleStrikeMode,
    setVisibleStrikeMode,
    chainTableMode,
    setChainTableMode,
    isMarketStreamConnected,
    chainStats,
    formatLarge,
    numberFormatMode,
    formatSignedLarge,
    oiBuildupChart,
    ivSkewChart,
    chainRows,
    formatOptionalNumber,
    renderIvDeltaCell,
    renderLtpStack,
    renderPressureCell,
    topStrikeRows,
    zoneRows
  } = props;

  return (
    <section className="grid min-w-0 gap-3 2xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 rounded border border-terminal-line bg-terminal-panel/80">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-terminal-line p-4">
          <div>
            <h2 className="text-base font-semibold">Live Option Chain Intelligence</h2>
            <p className="mt-1 text-sm text-terminal-muted">
              {overview.snapshot.underlyingSymbol} expiry {overview.snapshot.expiry}, ATM {formatStrike(overview.snapshot.atmStrike)}
            </p>
            <p className="mt-1 text-xs text-terminal-muted">
              VIX range {formatStrike(chainRange.lower)}-{formatStrike(chainRange.upper)} using India VIX {chainRange.vix.toFixed(2)}%
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-terminal-muted">
            <label className="flex h-9 items-center gap-2 rounded border border-terminal-line bg-terminal-input px-3">
              <span>VIX</span>
              <input className="accent-terminal-blue" checked={visibleStrikeMode === "atm"} onChange={(event) => setVisibleStrikeMode(event.target.checked ? "atm" : "vix")} type="checkbox" />
              <span>ATM +/-</span>
            </label>
            <div className="flex h-9 overflow-hidden rounded border border-terminal-line bg-terminal-input">
              <button className={`px-3 text-xs font-semibold transition ${chainTableMode === "standard" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => setChainTableMode("standard")}>OI</button>
              <button className={`px-3 text-xs font-semibold transition ${chainTableMode === "greeks" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => setChainTableMode("greeks")}>Greeks</button>
            </div>
            <Clock3 size={15} />
            <span>{isMarketStreamConnected ? "SSE live" : "Auto-refresh 30s"}</span>
          </div>
        </div>
        <div className="grid gap-3 border-b border-terminal-line p-3 md:grid-cols-4">
          <SignalCell label="CE Open Interest" value={formatLarge(chainStats.totalCeOi, numberFormatMode)} detail={formatSignedLarge(chainStats.totalCeChange, numberFormatMode)} tone="red" />
          <SignalCell label="PE Open Interest" value={formatLarge(chainStats.totalPeOi, numberFormatMode)} detail={formatSignedLarge(chainStats.totalPeChange, numberFormatMode)} tone="green" />
          <SignalCell label="OI Breadth" value={chainStats.breadth} detail={`PCR ${overview.pressure.pcr?.toFixed(2) ?? "--"}`} tone="blue" />
          <SignalCell label="Max OI Strike" value={chainStats.maxOiStrikeText} detail={chainStats.maxOiSide} tone="blue" />
        </div>
        <div className="grid gap-3 border-b border-terminal-line p-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          {oiBuildupChart}
          {ivSkewChart}
        </div>
        <OptionChainTable
          atmStrike={overview.snapshot.atmStrike}
          chainRows={chainRows}
          chainTableMode={chainTableMode}
          formatOptionalNumber={formatOptionalNumber}
          renderIvDeltaCell={renderIvDeltaCell}
          renderLtpStack={renderLtpStack}
          renderPressureCell={renderPressureCell}
        />
      </div>

      <div className="grid gap-3">
        <TerminalPanel title={`${overview.snapshot.underlyingSymbol} Option Chain - Top Strikes`}>
          <div className="grid gap-1">
            {topStrikeRows.map((row: any) => (
              <div key={`${row.strike}-${row.optionType}`} className="grid grid-cols-[minmax(5rem,1fr)_minmax(6rem,1fr)_minmax(4rem,0.5fr)] items-center border-b border-terminal-line/80 py-2 last:border-b-0">
                <span className="text-sm font-medium text-terminal-muted">{formatLarge(row.openInterest, numberFormatMode)} OI</span>
                <span className="text-center text-sm font-semibold text-terminal-text">
                  {formatStrike(row.strike)} {row.optionType}
                </span>
                <span className={`text-right text-sm font-semibold ${row.changePercent >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>
                  {row.changePercent >= 0 ? "▲" : "▼"} {Math.abs(row.changePercent).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </TerminalPanel>
        <TerminalPanel title="Support & Resistance Zones">
          <div className="grid gap-1">
            {zoneRows.map((row: any) => (
              <div key={row.label} className={`grid grid-cols-[3rem_minmax(6rem,1fr)_minmax(5rem,0.7fr)] items-center rounded px-2 py-2 ${row.isCurrent ? "bg-terminal-blue/15" : ""}`}>
                <span className={`text-sm font-semibold ${row.tone === "green" ? "text-terminal-emerald" : row.tone === "red" ? "text-terminal-red" : "text-terminal-blue"}`}>{row.label}</span>
                <span className={`text-center text-sm font-semibold ${row.isCurrent ? "text-terminal-blue" : "text-terminal-text"}`}>{formatStrike(row.value)}</span>
                <span className={`text-right text-sm ${row.isCurrent ? "text-terminal-blue" : "text-terminal-muted"}`}>{row.status}</span>
              </div>
            ))}
          </div>
        </TerminalPanel>
      </div>
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

function TerminalPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-terminal-blue/30 bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

import type { ReactNode } from "react";
import { Clock3 } from "lucide-react";
import type { MarketOverview } from "./live-dashboard";
import { OptionChainTable } from "./option-chain-table";
import type { ChainRow, ChainStats, NumberFormatMode, OptionActivityKind, TopStrikeRow, VixStrikeRange } from "./option-chain-builders";
import type { ZoneRow } from "./strike-pressure-analytics";

type VisibleStrikeMode = "vix" | "atm";
type ChainTableMode = "standard" | "greeks";

interface OptionChainPanelProps {
  overview: MarketOverview;
  formatStrike: (value: number) => string;
  chainRange: VixStrikeRange;
  visibleStrikeMode: VisibleStrikeMode;
  setVisibleStrikeMode: (mode: VisibleStrikeMode) => void;
  chainTableMode: ChainTableMode;
  setChainTableMode: (mode: ChainTableMode) => void;
  isMarketStreamConnected: boolean;
  chainStats: ChainStats;
  formatLarge: (value?: number, mode?: NumberFormatMode) => string;
  numberFormatMode: NumberFormatMode;
  formatSignedLarge: (value?: number, mode?: NumberFormatMode) => string;
  oiBuildupChart: ReactNode;
  ivSkewChart: ReactNode;
  chainRows: ChainRow[];
  formatOptionalNumber: (value: number | undefined, decimals: number) => string;
  renderIvDeltaCell: (iv: number | undefined, delta: number | undefined, align: "left" | "right") => ReactNode;
  renderLtpStack: (value: number | undefined, change: number | undefined, changePercent: number | undefined, align: "left" | "right", activity?: OptionActivityKind) => ReactNode;
  renderPressureCell: (value: string, rank: 1 | 2 | undefined, percent: number, side: "CE" | "PE") => ReactNode;
  topStrikeRows: TopStrikeRow[];
  zoneRows: ZoneRow[];
  onQuickOrder: (strike: number, optionType: "CE" | "PE", action: "BUY" | "SELL") => void;
}

function describeChainRange(chainRange: VixStrikeRange, requestedMode: VisibleStrikeMode) {
  if (chainRange.rangeMode === "atm") {
    return "ATM +/-6 strikes";
  }

  const rangeText = `VIX range ${chainRange.lower.toLocaleString("en-IN", { maximumFractionDigits: 0 })}-${chainRange.upper.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const vixText = chainRange.vixAvailable ? `using India VIX ${chainRange.vix.toFixed(2)}%` : "India VIX unavailable, using 15% default";
  const fallbackNote = requestedMode === "atm" ? " (ATM strike not found in chain, showing VIX range instead)" : "";
  return `${rangeText} ${vixText}${fallbackNote}`;
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
    zoneRows,
    onQuickOrder
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
            <p className="mt-1 text-xs text-terminal-muted">{describeChainRange(chainRange, visibleStrikeMode)}</p>
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
          onQuickOrder={onQuickOrder}
        />
      </div>

      <div className="grid gap-3">
        <TerminalPanel title={`${overview.snapshot.underlyingSymbol} Option Chain - Top Strikes`}>
          <div className="grid gap-1">
            {topStrikeRows.map((row) => (
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
            {zoneRows.map((row) => (
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

import type { ReactNode } from "react";
import { Clock3 } from "lucide-react";
import type { MarketOverview } from "./live-dashboard";
import { OptionChainTable } from "./option-chain-table";
import type { ChainMode, ChainRow, LadderBand, LadderLeg, MarketReadCell, NumberFormatMode, OiMovementRow, OptionActivityKind, TopStrikeRow, VixStrikeRange } from "./option-chain-builders";

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
  formatLarge: (value?: number, mode?: NumberFormatMode) => string;
  numberFormatMode: NumberFormatMode;
  oiBuildupChart: ReactNode;
  chainMode: ChainMode;
  setChainMode: (mode: ChainMode) => void;
  marketRead: MarketReadCell[];
  premiumLadder: LadderBand[];
  oiMovement: { building: OiMovementRow[]; unwinding: OiMovementRow[] };
  chainRows: ChainRow[];
  formatOptionalNumber: (value: number | undefined, decimals: number) => string;
  renderIvDeltaCell: (iv: number | undefined, delta: number | undefined, align: "left" | "right") => ReactNode;
  renderLtpStack: (value: number | undefined, change: number | undefined, changePercent: number | undefined, align: "left" | "right", activity?: OptionActivityKind) => ReactNode;
  renderPressureCell: (value: string, rank: 1 | 2 | undefined, percent: number, side: "CE" | "PE") => ReactNode;
  topStrikeRows: TopStrikeRow[];
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
    formatLarge,
    numberFormatMode,
    oiBuildupChart,
    chainMode,
    setChainMode,
    marketRead,
    premiumLadder,
    oiMovement,
    chainRows,
    formatOptionalNumber,
    renderIvDeltaCell,
    renderLtpStack,
    renderPressureCell,
    topStrikeRows,
    onQuickOrder
  } = props;

  return (
    <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_21rem]">
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
            {/* Buy/Sell reframes the market-read verdicts and the premium
                ladder. Every metric serves both directions - only the reading
                flips - so this is one toggle rather than two layouts. */}
            <div className="flex h-9 overflow-hidden rounded border border-terminal-line bg-terminal-input">
              <button className={`px-3 text-xs font-semibold transition ${chainMode === "buy" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => setChainMode("buy")}>Buy</button>
              <button className={`px-3 text-xs font-semibold transition ${chainMode === "sell" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => setChainMode("sell")}>Sell</button>
            </div>
            <div className="flex h-9 overflow-hidden rounded border border-terminal-line bg-terminal-input">
              <button className={`px-3 text-xs font-semibold transition ${chainTableMode === "standard" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => setChainTableMode("standard")}>OI</button>
              <button className={`px-3 text-xs font-semibold transition ${chainTableMode === "greeks" ? "bg-terminal-blue text-white" : "text-terminal-muted hover:text-terminal-text"}`} type="button" onClick={() => setChainTableMode("greeks")}>Greeks</button>
            </div>
            <Clock3 size={15} />
            <span>{isMarketStreamConnected ? "SSE live" : "Auto-refresh 30s"}</span>
          </div>
        </div>
        <div className="grid gap-2 border-b border-terminal-line p-3 md:grid-cols-3 2xl:grid-cols-6">
          {marketRead.map((cell) => (
            <MarketReadCellView key={cell.label} cell={cell} />
          ))}
        </div>
        <div className="border-b border-terminal-line p-3">{oiBuildupChart}</div>
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

      <div className="grid content-start gap-3">
        <TerminalPanel title={chainMode === "sell" ? "Premium ladder - what you collect" : "Buy candidates - what you pay"}>
          <div className="grid gap-2">
            {premiumLadder.map((band) => (
              <LadderCard key={band.label} band={band} chainMode={chainMode} formatStrike={formatStrike} />
            ))}
          </div>
        </TerminalPanel>
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
        <TerminalPanel title="Where OI moved today">
          <div className="grid gap-1">
            <p className="text-[0.65rem] uppercase tracking-wide text-terminal-muted">Building</p>
            {oiMovement.building.length ? (
              oiMovement.building.map((row) => <OiMovementRowView key={`b-${row.optionType}-${row.strike}`} row={row} formatLarge={formatLarge} formatStrike={formatStrike} numberFormatMode={numberFormatMode} />)
            ) : (
              <p className="py-1 text-sm text-terminal-muted">No positions opening yet.</p>
            )}
            <p className="mt-2 text-[0.65rem] uppercase tracking-wide text-terminal-muted">Unwinding</p>
            {oiMovement.unwinding.length ? (
              oiMovement.unwinding.map((row) => <OiMovementRowView key={`u-${row.optionType}-${row.strike}`} row={row} formatLarge={formatLarge} formatStrike={formatStrike} numberFormatMode={numberFormatMode} />)
            ) : (
              <p className="py-1 text-sm text-terminal-muted">No positions closing yet.</p>
            )}
          </div>
        </TerminalPanel>
      </div>
    </section>
  );
}

function MarketReadCellView({ cell }: { cell: MarketReadCell }) {
  const toneClass =
    cell.tone === "good" ? "text-terminal-emerald" : cell.tone === "warn" ? "text-terminal-red" : cell.tone === "info" ? "text-terminal-blue" : "text-terminal-text";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <p className="text-[0.65rem] uppercase tracking-wide text-terminal-muted">{cell.label}</p>
      <p className={`mt-1.5 text-lg font-semibold tabular-nums ${toneClass}`}>{cell.value}</p>
      <p className="mt-0.5 text-xs text-terminal-muted">{cell.detail}</p>
      <p className={`mt-1.5 text-xs font-medium ${toneClass}`}>{cell.verdict}</p>
    </div>
  );
}

function LadderCard({ band, chainMode, formatStrike }: { band: LadderBand; chainMode: ChainMode; formatStrike: (value: number) => string }) {
  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-terminal-text">
          {band.label} <span className="text-xs font-normal text-terminal-muted">{band.detail}</span>
        </p>
        {band.credit === undefined ? null : <p className="text-sm font-semibold tabular-nums text-terminal-emerald">+{band.credit.toFixed(2)}</p>}
      </div>
      {band.legs.length ? (
        <div className="mt-1.5 grid gap-1.5">
          {band.legs.map((leg) => (
            <LadderLegView key={`${leg.optionType}-${leg.strike}`} chainMode={chainMode} formatStrike={formatStrike} leg={leg} />
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs leading-snug text-terminal-muted">{band.emptyNote}</p>
      )}
    </div>
  );
}

// Two lines per leg rather than three columns: the rail is ~21rem, and a
// buy leg carries strike, price, delta, breakeven and the move to reach it.
function LadderLegView({ leg, chainMode, formatStrike }: { leg: LadderLeg; chainMode: ChainMode; formatStrike: (value: number) => string }) {
  const footnote =
    chainMode === "sell"
      ? `Δ${leg.delta.toFixed(2)} · ${leg.pop === undefined ? "--" : `${leg.pop}% keep`}`
      : `Δ${leg.delta.toFixed(2)} · BE ${leg.breakeven === undefined ? "--" : formatStrike(Math.round(leg.breakeven))}${
          leg.movePercent === undefined ? "" : ` (${leg.movePercent >= 0 ? "+" : ""}${leg.movePercent.toFixed(2)}%)`
        }`;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-terminal-text">
          {formatStrike(leg.strike)} <span className={leg.optionType === "CE" ? "text-terminal-emerald" : "text-terminal-red"}>{leg.optionType}</span>
        </span>
        <span className="text-sm font-semibold tabular-nums text-terminal-text">{leg.price.toFixed(2)}</span>
      </div>
      <p className="text-xs tabular-nums text-terminal-muted">{footnote}</p>
    </div>
  );
}

function OiMovementRowView({
  row,
  formatLarge,
  formatStrike,
  numberFormatMode
}: {
  row: OiMovementRow;
  formatLarge: (value?: number, mode?: NumberFormatMode) => string;
  formatStrike: (value: number) => string;
  numberFormatMode: NumberFormatMode;
}) {
  return (
    <div className="grid grid-cols-[minmax(6rem,1fr)_minmax(5rem,0.8fr)_minmax(4rem,0.6fr)] items-center border-b border-terminal-line/80 py-1.5 last:border-b-0">
      <span className="text-sm font-semibold text-terminal-text">
        {formatStrike(row.strike)} <span className={row.optionType === "CE" ? "text-terminal-emerald" : "text-terminal-red"}>{row.optionType}</span>
      </span>
      <span className={`text-right text-sm font-semibold tabular-nums ${row.change >= 0 ? "text-terminal-emerald" : "text-terminal-red"}`}>
        {row.change >= 0 ? "+" : "-"}
        {formatLarge(Math.abs(row.change), numberFormatMode)}
      </span>
      <span className="text-right text-sm tabular-nums text-terminal-muted">{formatLarge(row.openInterest, numberFormatMode)}</span>
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

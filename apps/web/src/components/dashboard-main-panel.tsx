import type { ReactNode } from "react";
import type { MarketPulse } from "@option-decode/types";
import { TradeRecommendations } from "./trade-recommendations";

interface DashboardMainPanelProps {
  chainStats: any;
  formatLarge: (value?: number, mode?: any) => string;
  formatSignedLarge: (value?: number, mode?: any) => string;
  formatStrike: (value: number) => string;
  formatTime: (value: string) => string;
  getActivityLabel: (activity: any) => string;
  getActivityToneClass: (activity: any) => string;
  numberFormatMode: any;
  overview: any;
  pressureSummary: any;
  strikeMovementRows: any[];
  strikeMovementSummary: any;
  tradeInterpretation: any;
}

export function DashboardMainPanel({
  chainStats,
  formatLarge,
  formatSignedLarge,
  formatStrike,
  formatTime,
  getActivityLabel,
  getActivityToneClass,
  numberFormatMode,
  overview,
  pressureSummary,
  strikeMovementRows,
  strikeMovementSummary,
  tradeInterpretation
}: DashboardMainPanelProps) {
  return (
    <section className="grid gap-4">
      <Panel title="Market Detail">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <SignalCell label="Nearest Support" value={pressureSummary.nearestSupportText} detail={pressureSummary.supportDistanceText} tone="green" />
          <SignalCell label="Nearest Resistance" value={pressureSummary.nearestResistanceText} detail={pressureSummary.resistanceDistanceText} tone="red" />
          <SignalCell label="OI Breadth" value={chainStats.breadth} detail={`CE ${formatLarge(chainStats.totalCeOi, numberFormatMode)} · PE ${formatLarge(chainStats.totalPeOi, numberFormatMode)}`} tone="blue" />
          <SignalCell label="Buyer Momentum" value={tradeInterpretation.buyerText} detail={tradeInterpretation.buyerScore !== 0 ? `Score ${formatSignedLarge(tradeInterpretation.buyerScore, numberFormatMode)}` : "Neutral across ATM strikes"} tone={tradeInterpretation.buyerScore >= 8 ? "green" : tradeInterpretation.buyerScore <= -8 ? "red" : "blue"} />
          <SignalCell label="Seller Safety" value={tradeInterpretation.sellerText} detail={tradeInterpretation.sellerScore !== 0 ? `Score ${formatSignedLarge(tradeInterpretation.sellerScore, numberFormatMode)}` : "Neutral across ATM strikes"} tone={tradeInterpretation.sellerScore >= 8 ? "green" : tradeInterpretation.sellerScore <= -8 ? "red" : "blue"} />
          <MarketPulseCell pulse={overview.marketPulse} />
        </div>
        {pressureSummary.setupQualityText && !pressureSummary.setupQualityText.startsWith("Wait") && (
          <div className="mt-2 rounded border border-terminal-blue/40 bg-terminal-blue/10 px-3 py-1.5 text-xs text-terminal-blue">
            <span className="font-semibold">Setup: </span>{pressureSummary.setupQualityDetail}
          </div>
        )}
      </Panel>
      <Panel title="ATM +/-2 Strike Movement Score">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="overflow-x-auto rounded border border-terminal-line">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-terminal-line text-left text-xs uppercase text-terminal-muted">
                  <th className="px-2 py-2 font-medium">Strike</th>
                  <th className="px-2 py-2 font-medium">Net Score</th>
                  <th className="px-2 py-2 font-medium">Bias</th>
                  <th className="px-2 py-2 font-medium">Trend</th>
                  <th className="px-2 py-2 font-medium">Activity</th>
                  <th className="px-2 py-2 text-right font-medium">PE / CE</th>
                </tr>
              </thead>
              <tbody>
                {strikeMovementRows.map((row) => (
                  <tr key={row.strike} className={`border-b border-terminal-line/60 last:border-b-0 ${row.isAtm ? "bg-terminal-blue/10" : ""}`}>
                    <td className="whitespace-nowrap px-2 py-2">
                      <span className="text-xs uppercase text-terminal-muted">{row.distanceLabel}</span>{" "}
                      <span className="font-semibold text-terminal-text">{formatStrike(row.strike)}</span>
                    </td>
                    <td className={`whitespace-nowrap px-2 py-2 font-semibold ${row.toneClass}`}>
                      {formatSignedLarge(row.netScore, numberFormatMode)} <span className="text-terminal-muted">({row.netScorePercent}%)</span>
                    </td>
                    <td className={`whitespace-nowrap px-2 py-2 ${row.toneClass}`}>{row.bias}</td>
                    <td className={`whitespace-nowrap px-2 py-2 ${row.trendToneClass}`}>{row.trendIcon} {row.trend}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-terminal-muted">{getActivityLabel(row.ceActivity)} CE · {getActivityLabel(row.peActivity)} PE</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right text-terminal-muted">
                      {formatLarge(row.peScore, numberFormatMode)} / {formatLarge(row.ceScore, numberFormatMode)}
                    </td>
                  </tr>
                ))}
                {!strikeMovementRows.length ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-4 text-center text-terminal-muted">No ATM strike score available.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="grid gap-2 rounded border border-terminal-line bg-white/[0.03] p-3 text-sm">
            <SummaryLine label="Likely pull" value={strikeMovementSummary.bias} />
            <SummaryLine label="Strongest strike" value={strikeMovementSummary.strongestStrike} />
            <SummaryLine label="Building" value={strikeMovementSummary.trend} />
            <p className="text-xs leading-5 text-terminal-muted">Positive score means PE support is stronger than CE resistance at that strike. Negative score means CE resistance is stronger. Buyer/Seller scores are shown in Market Detail above.</p>
          </div>
        </div>
      </Panel>
      <TradeRecommendations recommendations={overview.recommendations} snapshotTime={overview.snapshot.snapshotTime} formatTime={formatTime} />
    </section>
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

// Renders the server-computed market-pulse rate-of-change (see
// @option-decode/analytics#calculateMarketPulse). Kept as its own cell
// rather than folded into SignalCell since it needs to gracefully show
// "not enough data yet" (e.g. right after market open, before the 5-minute
// lookback window has any history) instead of always having a value.
function MarketPulseCell({ pulse }: { pulse?: MarketPulse | null }) {
  if (!pulse || pulse.spotRatePerMin === undefined) {
    return (
      <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
        <p className="text-xs uppercase text-terminal-muted">Market Pulse</p>
        <p className="mt-2 text-lg font-semibold text-terminal-muted">--</p>
        <p className="mt-1 text-xs text-terminal-muted">Not enough recent history yet</p>
      </div>
    );
  }

  const icon = pulse.direction === "up" ? "▲" : pulse.direction === "down" ? "▼" : "•";
  const toneClass = pulse.direction === "up" ? "text-terminal-emerald" : pulse.direction === "down" ? "text-terminal-red" : "text-terminal-blue";
  const sign = pulse.spotRatePerMin > 0 ? "+" : "";
  const percentText = pulse.spotRatePercentPerMin !== undefined ? `${sign}${pulse.spotRatePercentPerMin.toFixed(2)}%/min` : "Rate of change";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <p className="text-xs uppercase text-terminal-muted">Market Pulse</p>
      <p className={`mt-2 text-lg font-semibold ${toneClass}`}>
        {icon} {sign}{pulse.spotRatePerMin.toFixed(1)} pts/min
      </p>
      <p className="mt-1 text-xs text-terminal-muted">
        {percentText} · {pulse.sampleCount} samples / {pulse.windowMinutes}m
      </p>
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



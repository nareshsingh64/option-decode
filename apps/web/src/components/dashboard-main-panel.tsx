import { BellRing, LineChart, ShieldCheck, WalletCards } from "lucide-react";
import type { ReactNode } from "react";

interface DashboardMainPanelProps {
  chainStats: any;
  formatCurrency: (value: number) => string;
  formatLarge: (value?: number, mode?: any) => string;
  formatSignedLarge: (value?: number, mode?: any) => string;
  formatStrike: (value: number) => string;
  getActivityLabel: (activity: any) => string;
  getActivityToneClass: (activity: any) => string;
  numberFormatMode: any;
  overview: any;
  paperSummary: any;
  pressureSummary: any;
  snapshotAge: string;
  strikeMovementRows: any[];
  strikeMovementSummary: any;
  tradeInterpretation: any;
}

export function DashboardMainPanel({
  chainStats,
  formatCurrency,
  formatLarge,
  formatSignedLarge,
  formatStrike,
  getActivityLabel,
  getActivityToneClass,
  numberFormatMode,
  overview,
  paperSummary,
  pressureSummary,
  snapshotAge,
  strikeMovementRows,
  strikeMovementSummary,
  tradeInterpretation
}: DashboardMainPanelProps) {
  return (
    <section className="grid gap-4">
      <Panel title="Trading Command Center">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <StatusTile icon={<ShieldCheck size={18} />} label="Market Bias" value={pressureSummary.bias} detail={pressureSummary.biasDetail} tone={pressureSummary.bias === "Bullish" ? "green" : pressureSummary.bias === "Bearish" ? "red" : "blue"} />
          <StatusTile icon={<LineChart size={18} />} label="PCR Live" value={pressureSummary.pcrText} detail={pressureSummary.pcrDetail} tone={pressureSummary.pcrTone} />
          <StatusTile icon={<LineChart size={18} />} label="Max Pain" value={pressureSummary.maxPainText} detail={pressureSummary.maxPainDistanceText} tone="blue" />
          <StatusTile icon={<ShieldCheck size={18} />} label="Conviction" value={pressureSummary.conviction} detail={`${pressureSummary.convictionScore}% ${pressureSummary.convictionDetail}`} tone={pressureSummary.convictionTone} />
          <StatusTile icon={<BellRing size={18} />} label="Setup Quality" value={pressureSummary.setupQualityText} detail={pressureSummary.setupQualityDetail} tone={pressureSummary.setupQualityTone} />
          <StatusTile icon={<WalletCards size={18} />} label="Paper P/L" value={formatCurrency((paperSummary?.stats.realizedPnl ?? 0) + (paperSummary?.stats.markToMarketPnl ?? 0))} />
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <SignalCell label="Nearest Support" value={pressureSummary.nearestSupportText} detail={pressureSummary.supportDistanceText} tone="green" />
          <SignalCell label="Nearest Resistance" value={pressureSummary.nearestResistanceText} detail={pressureSummary.resistanceDistanceText} tone="red" />
          <SignalCell label="Trade Readiness" value={pressureSummary.readiness} detail={pressureSummary.readinessDetail} tone="blue" />
        </div>
      </Panel>
      <Panel title="ATM +/-2 Strike Movement Score">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.35fr)]">
          <div className="grid gap-2">
            {strikeMovementRows.map((row) => (
              <div key={row.strike} className={`grid gap-2 rounded border px-3 py-2 sm:grid-cols-[4.5rem_minmax(6rem,0.8fr)_minmax(6rem,1fr)_minmax(6rem,1fr)_minmax(7rem,0.8fr)] sm:items-center ${row.isAtm ? "border-terminal-blue/60 bg-terminal-blue/10" : "border-terminal-line bg-white/[0.03]"}`}>
                <div>
                  <p className="text-xs uppercase text-terminal-muted">{row.distanceLabel}</p>
                  <p className="font-semibold text-terminal-text">{formatStrike(row.strike)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-terminal-muted">Net score</p>
                  <p className={`font-semibold ${row.toneClass}`}>{formatSignedLarge(row.netScore, numberFormatMode)} / {row.netScorePercent}%</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10">
                    <div className={`h-full rounded ${row.netScore > 0 ? "bg-terminal-emerald" : row.netScore < 0 ? "bg-terminal-red" : "bg-terminal-blue"}`} style={{ width: `${row.scoreBarPercent}%` }} />
                  </div>
                </div>
                <div>
                  <p className="text-xs uppercase text-terminal-muted">Move bias</p>
                  <p className={`font-semibold ${row.toneClass}`}>{row.bias}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-terminal-muted">Score trend</p>
                  <p className={`font-semibold ${row.trendToneClass}`}>{row.trendIcon} {row.trend}</p>
                </div>
                <div className="text-sm text-terminal-muted sm:text-right">
                  <p><span className={getActivityToneClass(row.peActivity)}>{getActivityLabel(row.peActivity)}</span> PE {formatLarge(row.peScore, numberFormatMode)}</p>
                  <p><span className={getActivityToneClass(row.ceActivity)}>{getActivityLabel(row.ceActivity)}</span> CE {formatLarge(row.ceScore, numberFormatMode)}</p>
                  <p className={row.buyerMomentumScore >= 0 ? "text-terminal-emerald" : "text-terminal-red"}>B {formatSignedLarge(row.buyerMomentumScore, numberFormatMode)}</p>
                  <p className={row.sellerSafetyScore >= 0 ? "text-terminal-emerald" : "text-terminal-red"}>S {formatSignedLarge(row.sellerSafetyScore, numberFormatMode)}</p>
                </div>
              </div>
            ))}
            {!strikeMovementRows.length ? <p className="rounded border border-terminal-line bg-white/[0.03] px-3 py-4 text-center text-sm text-terminal-muted">No ATM strike score available.</p> : null}
          </div>
          <div className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <SignalCell label="Buyer Momentum" value={tradeInterpretation.buyerText} detail={`Score ${formatSignedLarge(tradeInterpretation.buyerScore, numberFormatMode)}`} tone={tradeInterpretation.buyerScore > 8 ? "green" : tradeInterpretation.buyerScore < -8 ? "red" : "blue"} />
              <SignalCell label="Seller Safety" value={tradeInterpretation.sellerText} detail={`Score ${formatSignedLarge(tradeInterpretation.sellerScore, numberFormatMode)}`} tone={tradeInterpretation.sellerScore > 8 ? "green" : tradeInterpretation.sellerScore < -8 ? "red" : "blue"} />
            </div>
            <SummaryLine label="Likely pull" value={strikeMovementSummary.bias} />
            <SummaryLine label="Strongest strike" value={strikeMovementSummary.strongestStrike} />
            <SummaryLine label="Building score" value={strikeMovementSummary.trend} />
            <p className="text-xs leading-5 text-terminal-muted">Positive score means PE support is stronger than CE resistance at that strike. Negative score means CE resistance is stronger. The trend uses OI and LTP change to show whether that pressure is building or fading near ATM.</p>
          </div>
        </div>
      </Panel>
      <Panel title="Session Snapshot">
        <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-5">
          <CompactSummary label="Snapshot" value={`${snapshotAge} IST`} />
          <CompactSummary label="Expiry" value={overview.snapshot.expiry} />
          <CompactSummary label="CE OI" value={formatLarge(chainStats.totalCeOi, numberFormatMode)} />
          <CompactSummary label="PE OI" value={formatLarge(chainStats.totalPeOi, numberFormatMode)} />
          <CompactSummary label="Max OI" value={chainStats.maxOiStrikeText} />
        </div>
      </Panel>
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

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-terminal-line/70 pb-2 last:border-b-0 last:pb-0">
      <span className="text-terminal-muted">{label}</span>
      <span className="text-right font-semibold text-terminal-text">{value}</span>
    </div>
  );
}

function CompactSummary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] px-3 py-2">
      <p className="text-[0.65rem] uppercase text-terminal-muted">{label}</p>
      <p className="mt-1 truncate font-semibold text-terminal-text">{value}</p>
    </div>
  );
}

function StatusTile({ icon, label, value, detail, tone = "blue" }: { icon: ReactNode; label: string; value: string; detail?: string; tone?: "blue" | "green" | "red" }) {
  const toneClass = tone === "green" ? "text-terminal-emerald" : tone === "red" ? "text-terminal-red" : "text-terminal-blue";

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <div className={`flex items-center gap-2 ${toneClass}`}>{icon}</div>
      <p className="mt-3 text-xs uppercase text-terminal-muted">{label}</p>
      <p className={`mt-1 font-semibold ${toneClass}`}>{value}</p>
      {detail ? <p className="mt-1 text-xs text-terminal-muted">{detail}</p> : null}
    </div>
  );
}

import { ChevronDown } from "lucide-react";
import { useState } from "react";

// The recommendation engine itself (thresholds, confidence scoring, and
// the six rule categories below) lives server-side in
// @option-decode/trading#calculateTradeRecommendations, computed by the API
// and included in the market-overview/replay-snapshot responses. This
// component is a pure renderer — no business logic, so there's nothing
// here that can drift from what the API actually decided.
interface RecommendedTradeSetup {
  optionType: "CE" | "PE";
  strike: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  riskRewardRatio: number;
  breakevenAtExpiry: number;
  breakevenToday: number;
}

interface Recommendation {
  id: string;
  category: "direction" | "strategy" | "timing" | "avoid";
  priority: "high" | "medium" | "low";
  title: string;
  explanation: string;
  action: string;
  confidence: number;
  tradeSetup?: RecommendedTradeSetup;
}

// Recommendations are recomputed fresh every time the market-overview API
// responds, but they're derived entirely from ONE option-chain snapshot -
// there's no independent "generated at" moment worth stamping per card.
// What actually matters (and what prompted this) is: which snapshot are
// these based on? Outside market hours, or if the worker's capture has
// lagged, that can be a much older snapshot than "just now" - so the panel
// shows the snapshot's own timestamp and flags it if it's stale enough that
// acting on it without checking would be a mistake.
const STALE_AFTER_MS = 5 * 60 * 1000;

interface TradeRecommendationsProps {
  recommendations: Recommendation[];
  snapshotTime: string;
  formatTime: (value: string) => string;
}

export function TradeRecommendations({ recommendations, snapshotTime, formatTime }: TradeRecommendationsProps) {
  const recs = recommendations.slice(0, 5);
  if (!recs.length) return null;

  const snapshotMs = Date.parse(snapshotTime);
  const ageMs = Number.isFinite(snapshotMs) ? Date.now() - snapshotMs : undefined;
  const isStale = ageMs !== undefined && ageMs > STALE_AFTER_MS;

  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Trade Recommendations</h2>
        <span className="rounded bg-white/[0.05] px-2 py-0.5 text-[0.65rem] text-terminal-muted">
          OI · PCR · Max Pain · Strike scores
        </span>
      </div>
      <div className={`mt-2 inline-flex items-center gap-1.5 rounded px-2 py-1 text-[0.7rem] ${isStale ? "bg-amber-500/10 text-amber-400" : "text-terminal-muted"}`}>
        <span>Based on data as of {formatTime(snapshotTime)} IST</span>
        {isStale ? <span className="font-semibold uppercase">· Not live, check before acting</span> : null}
      </div>
      <div className="mt-3 grid gap-1.5">
        {recs.map((rec) => <RecommendationCard key={rec.id} rec={rec} />)}
      </div>
      <p className="mt-2 text-[0.65rem] text-terminal-muted">Generated from option chain signals — not financial advice.</p>
    </section>
  );
}

// Collapsed by default: one line with category, title, and confidence.
// Click to expand the full rationale + action text.
function RecommendationCard({ rec }: { rec: Recommendation }) {
  const [expanded, setExpanded] = useState(false);
  const cat = {
    direction: { label: "Direction", bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400" },
    strategy: { label: "Strategy", bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400" },
    timing: { label: "Timing", bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400" },
    avoid: { label: "Avoid", bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400" }
  }[rec.category];

  const dot = { high: "bg-red-400", medium: "bg-amber-400", low: "bg-slate-400" }[rec.priority];

  return (
    <div className={`rounded border ${cat.border} ${cat.bg}`}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={expanded}
      >
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className={`shrink-0 text-[0.65rem] font-medium uppercase ${cat.text}`}>{cat.label}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-terminal-text">{rec.title}</span>
        <span className="shrink-0 text-[0.65rem] text-terminal-muted">{rec.confidence}%</span>
        <ChevronDown size={14} className={`shrink-0 text-terminal-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {rec.tradeSetup ? <TradeSetupRow setup={rec.tradeSetup} /> : null}
      {expanded && (
        <div className="px-2.5 pb-2.5">
          <p className="text-xs leading-5 text-terminal-muted">{rec.explanation}</p>
          <div className="mt-1.5 rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
            <p className="text-xs font-medium text-terminal-text">What to do:</p>
            <p className="mt-0.5 text-xs leading-5 text-terminal-muted">{rec.action}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// Shown regardless of expand/collapse state - unlike the rationale text,
// this is the actionable part the user asked to see up front: exactly
// which instrument, at what premium, with the stop-loss/target already
// worked out. See @option-decode/trading#buildTradeSetup for how these
// numbers are derived (delta-based stop distance, 2:1 reward:risk) - it's
// a heuristic starting point, not a guarantee, hence the note.
function TradeSetupRow({ setup }: { setup: RecommendedTradeSetup }) {
  return (
    <div className="mx-2.5 mb-2 rounded border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-terminal-text">
          {setup.strike.toLocaleString("en-IN")} {setup.optionType}
        </span>
        <span className="text-terminal-muted">
          Entry <span className="font-medium text-terminal-text">₹{setup.entryPrice.toFixed(2)}</span>
        </span>
        <span className="text-terminal-red">
          SL <span className="font-medium">₹{setup.stopLoss.toFixed(2)}</span>
        </span>
        <span className="text-terminal-emerald">
          Target <span className="font-medium">₹{setup.target.toFixed(2)}</span>
        </span>
        <span className="text-terminal-muted">1:{setup.riskRewardRatio}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-terminal-muted">
        <span>
          Breakeven today <span className="font-medium text-terminal-text">₹{setup.breakevenToday.toFixed(2)}</span>
        </span>
        <span>
          At expiry <span className="font-medium text-terminal-text">₹{setup.breakevenAtExpiry.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}

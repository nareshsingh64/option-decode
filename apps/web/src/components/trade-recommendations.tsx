import { ChevronDown } from "lucide-react";
import { useState } from "react";

// The recommendation engine itself (thresholds, confidence scoring, and
// the six rule categories below) lives server-side in
// @option-decode/trading#calculateTradeRecommendations, computed by the API
// and included in the market-overview/replay-snapshot responses. This
// component is a pure renderer — no business logic, so there's nothing
// here that can drift from what the API actually decided.
interface Recommendation {
  id: string;
  category: "direction" | "strategy" | "timing" | "avoid";
  priority: "high" | "medium" | "low";
  title: string;
  explanation: string;
  action: string;
  confidence: number;
}

interface TradeRecommendationsProps {
  recommendations: Recommendation[];
}

export function TradeRecommendations({ recommendations }: TradeRecommendationsProps) {
  const recs = recommendations.slice(0, 5);
  if (!recs.length) return null;

  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Trade Recommendations</h2>
        <span className="rounded bg-white/[0.05] px-2 py-0.5 text-[0.65rem] text-terminal-muted">
          OI · PCR · Max Pain · Strike scores
        </span>
      </div>
      <div className="mt-4 grid gap-1.5">
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

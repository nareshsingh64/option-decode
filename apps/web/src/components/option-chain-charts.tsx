interface OiBuildupChartRow {
  strike: number;
  isAtm: boolean;
  ceLabel: string;
  cePercent: number;
  ceBuilding: boolean;
  peLabel: string;
  pePercent: number;
  peBuilding: boolean;
}

export function OiBuildupChart({ rows }: { rows: OiBuildupChartRow[] }) {
  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-terminal-muted">OI Buildup</p>
          <p className="mt-1 text-sm font-semibold text-terminal-text">CE resistance vs PE support</p>
        </div>
        <div className="flex items-center gap-3 text-[0.65rem] uppercase text-terminal-muted">
          <span className="text-terminal-red">CE</span>
          <span className="text-terminal-emerald">PE</span>
        </div>
      </div>
      <div className="grid gap-1">
        {rows.map((row) => (
          <div key={row.strike} className={`grid grid-cols-[minmax(0,1fr)_4.75rem_minmax(0,1fr)] items-center gap-2 rounded px-2 py-1.5 ${row.isAtm ? "bg-terminal-blue/15 ring-1 ring-terminal-blue/50" : ""}`}>
            <div className="flex items-center justify-end gap-2">
              <span className="w-12 text-right text-[0.65rem] text-terminal-muted">{row.ceLabel}</span>
              <div className="h-3 flex-1 rounded bg-white/5">
                <div className={`ml-auto h-3 rounded ${row.ceBuilding ? "bg-terminal-red" : "bg-terminal-red/35"}`} style={{ width: `${row.cePercent}%` }} />
              </div>
            </div>
            <div className={`text-center text-xs font-semibold ${row.isAtm ? "text-terminal-blue" : "text-terminal-text"}`}>{formatStrike(row.strike)}</div>
            <div className="flex items-center gap-2">
              <div className="h-3 flex-1 rounded bg-white/5">
                <div className={`h-3 rounded ${row.peBuilding ? "bg-terminal-emerald" : "bg-terminal-emerald/35"}`} style={{ width: `${row.pePercent}%` }} />
              </div>
              <span className="w-12 text-[0.65rem] text-terminal-muted">{row.peLabel}</span>
            </div>
          </div>
        ))}
        {!rows.length ? <p className="px-2 py-6 text-center text-sm text-terminal-muted">No OI buildup data in visible range.</p> : null}
      </div>
    </div>
  );
}

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

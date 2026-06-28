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

interface IvSkewChartRow {
  strike: number;
  x: number;
  ceY?: number;
  peY?: number;
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

export function IvSkewChart({ rows, atmStrike }: { rows: IvSkewChartRow[]; atmStrike: number }) {
  const width = 520;
  const height = 180;
  const padding = 22;
  const cePath = buildLinePath(rows, "ceY");
  const pePath = buildLinePath(rows, "peY");
  const atmRow = rows.find((row) => row.strike === atmStrike);

  return (
    <div className="rounded border border-terminal-line bg-white/[0.03] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-terminal-muted">IV Skew</p>
          <p className="mt-1 text-sm font-semibold text-terminal-text">Volatility by strike</p>
        </div>
        <div className="flex items-center gap-3 text-[0.65rem] uppercase text-terminal-muted">
          <span className="text-terminal-red">CE IV</span>
          <span className="text-terminal-emerald">PE IV</span>
        </div>
      </div>
      <div className="overflow-hidden rounded bg-black/10">
        <svg className="h-48 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="IV skew chart">
          <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} stroke="rgba(148,163,184,0.25)" />
          <line x1={padding} x2={padding} y1={padding} y2={height - padding} stroke="rgba(148,163,184,0.25)" />
          {atmRow ? <line x1={atmRow.x} x2={atmRow.x} y1={padding} y2={height - padding} stroke="rgba(59,130,246,0.65)" strokeDasharray="4 4" /> : null}
          {cePath ? <path d={cePath} fill="none" stroke="rgb(239,68,68)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /> : null}
          {pePath ? <path d={pePath} fill="none" stroke="rgb(34,197,94)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /> : null}
          {rows.map((row) => (
            <g key={row.strike}>
              {row.ceY !== undefined ? <circle cx={row.x} cy={row.ceY} r="2.75" fill="rgb(239,68,68)" /> : null}
              {row.peY !== undefined ? <circle cx={row.x} cy={row.peY} r="2.75" fill="rgb(34,197,94)" /> : null}
            </g>
          ))}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between text-[0.65rem] text-terminal-muted">
        <span>{rows[0] ? formatStrike(rows[0].strike) : "--"}</span>
        <span>ATM {formatStrike(atmStrike)}</span>
        <span>{rows[rows.length - 1] ? formatStrike(rows[rows.length - 1].strike) : "--"}</span>
      </div>
    </div>
  );
}

function buildLinePath(rows: IvSkewChartRow[], field: "ceY" | "peY") {
  return rows
    .filter((row) => row[field] !== undefined)
    .map((row, index) => `${index === 0 ? "M" : "L"} ${row.x.toFixed(2)} ${(row[field] ?? 0).toFixed(2)}`)
    .join(" ");
}

function formatStrike(value: number) {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

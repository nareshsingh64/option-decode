import type { ReactNode } from "react";

interface OptionChainTableProps {
  atmStrike: number;
  chainRows: any[];
  chainTableMode: "standard" | "greeks";
  renderIvDeltaCell: (iv: number | undefined, delta: number | undefined, align: "left" | "right") => ReactNode;
  renderPressureCell: (value: string, rank: 1 | 2 | undefined, percent: number, side: "CE" | "PE") => ReactNode;
  renderLtpStack: (ltp: number | undefined, change: number | undefined, changePercent: number | undefined, align: "left" | "right", activity: any) => ReactNode;
  formatOptionalNumber: (value: number | undefined, decimals: number) => string;
}

export function OptionChainTable({
  atmStrike,
  chainRows,
  chainTableMode,
  renderIvDeltaCell,
  renderPressureCell,
  renderLtpStack,
  formatOptionalNumber
}: OptionChainTableProps) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className={`w-full border-collapse text-xs xl:text-sm ${chainTableMode === "greeks" ? "min-w-[1160px]" : "min-w-[980px]"}`}>
        <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
          {chainTableMode === "standard" ? (
            <tr>
              <th className="px-2 py-3 text-left">CE IV/Δ</th>
              <th className="px-2 py-3 text-left">CE OI</th>
              <th className="px-2 py-3 text-left">CE Chg</th>
              <th className="px-2 py-3 text-left">CE Vol</th>
              <th className="px-2 py-3 text-left">CE LTP</th>
              <th className="px-2 py-3 text-center">Strike</th>
              <th className="px-2 py-3 text-right">PE LTP</th>
              <th className="px-2 py-3 text-right">PE Vol</th>
              <th className="px-2 py-3 text-right">PE Chg</th>
              <th className="px-2 py-3 text-right">PE OI</th>
              <th className="px-2 py-3 text-right">PE IV/Δ</th>
            </tr>
          ) : (
            <tr>
              <th className="px-2 py-3 text-left">CE IV</th>
              <th className="px-2 py-3 text-left">CE Δ</th>
              <th className="px-2 py-3 text-left">CE Γ</th>
              <th className="px-2 py-3 text-left">CE Θ</th>
              <th className="px-2 py-3 text-left">CE Vega</th>
              <th className="px-2 py-3 text-left">CE LTP</th>
              <th className="px-2 py-3 text-center">Strike</th>
              <th className="px-2 py-3 text-right">PE LTP</th>
              <th className="px-2 py-3 text-right">PE Vega</th>
              <th className="px-2 py-3 text-right">PE Θ</th>
              <th className="px-2 py-3 text-right">PE Γ</th>
              <th className="px-2 py-3 text-right">PE Δ</th>
              <th className="px-2 py-3 text-right">PE IV</th>
            </tr>
          )}
        </thead>
        <tbody>
          {chainRows.map((row) => (
            <tr key={row.strike} className={row.strike === atmStrike ? "border-y border-terminal-blue/70 bg-terminal-blue/10" : "border-t border-terminal-line/80"}>
              {chainTableMode === "standard" ? (
                <>
                  <td className="px-2 py-3">{renderIvDeltaCell(row.ceIv, row.ceDelta, "left")}</td>
                  <td className="px-2 py-3">{renderPressureCell(row.ceOi, row.ceOiRank, row.ceOiPercent, "CE")}</td>
                  <td className="px-2 py-3">{renderPressureCell(row.ceChg, row.ceChgRank, row.ceChgPercent, "CE")}</td>
                  <td className="px-2 py-3">{renderPressureCell(row.ceVol, row.ceVolRank, row.ceVolPercent, "CE")}</td>
                  <td className="px-2 py-3">{renderLtpStack(row.ceLtp, row.ceLtpChange, row.ceLtpChangePercent, "left", row.ceActivity)}</td>
                  <td className="px-2 py-3 text-center font-semibold text-terminal-text">{row.strike}</td>
                  <td className="px-2 py-3 text-right">{renderLtpStack(row.peLtp, row.peLtpChange, row.peLtpChangePercent, "right", row.peActivity)}</td>
                  <td className="px-2 py-3">{renderPressureCell(row.peVol, row.peVolRank, row.peVolPercent, "PE")}</td>
                  <td className="px-2 py-3">{renderPressureCell(row.peChg, row.peChgRank, row.peChgPercent, "PE")}</td>
                  <td className="px-2 py-3">{renderPressureCell(row.peOi, row.peOiRank, row.peOiPercent, "PE")}</td>
                  <td className="px-2 py-3">{renderIvDeltaCell(row.peIv, row.peDelta, "right")}</td>
                </>
              ) : (
                <>
                  <td className="px-2 py-3 text-left font-semibold text-terminal-text">{formatOptionalNumber(row.ceIv, 1)}</td>
                  <td className="px-2 py-3 text-left">{formatOptionalNumber(row.ceDelta, 2)}</td>
                  <td className="px-2 py-3 text-left">{formatOptionalNumber(row.ceGamma, 4)}</td>
                  <td className="px-2 py-3 text-left text-terminal-red">{formatOptionalNumber(row.ceTheta, 2)}</td>
                  <td className="px-2 py-3 text-left">{formatOptionalNumber(row.ceVega, 2)}</td>
                  <td className="px-2 py-3">{renderLtpStack(row.ceLtp, row.ceLtpChange, row.ceLtpChangePercent, "left", row.ceActivity)}</td>
                  <td className="px-2 py-3 text-center font-semibold text-terminal-text">{row.strike}</td>
                  <td className="px-2 py-3 text-right">{renderLtpStack(row.peLtp, row.peLtpChange, row.peLtpChangePercent, "right", row.peActivity)}</td>
                  <td className="px-2 py-3 text-right">{formatOptionalNumber(row.peVega, 2)}</td>
                  <td className="px-2 py-3 text-right text-terminal-red">{formatOptionalNumber(row.peTheta, 2)}</td>
                  <td className="px-2 py-3 text-right">{formatOptionalNumber(row.peGamma, 4)}</td>
                  <td className="px-2 py-3 text-right">{formatOptionalNumber(row.peDelta, 2)}</td>
                  <td className="px-2 py-3 text-right font-semibold text-terminal-text">{formatOptionalNumber(row.peIv, 1)}</td>
                </>
              )}
            </tr>
          ))}
          {!chainRows.length ? (
            <tr>
              <td colSpan={chainTableMode === "standard" ? 11 : 13} className="px-2 py-8 text-center text-terminal-muted">
                No strikes available inside the current VIX range.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

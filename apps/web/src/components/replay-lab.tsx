import type { ReactNode } from "react";
import { Clock3, Pause, Play, ShieldCheck, SkipBack, SkipForward } from "lucide-react";
import { ExpiryDatePicker } from "./expiry-date-picker";

interface ReplayLabProps {
  replayExpiry: any;
  setReplayExpiry: any;
  setReplayStartSnapshotId: any;
  setReplayOverview: any;
  setReplaySnapshots: any;
  replaySnapshotsRef: any;
  setReplayIndex: any;
  replayIndexRef: any;
  setIsReplayPlaying: any;
  overview: any;
  replayStartSnapshotId: any;
  replaySnapshots: any;
  loadReplaySnapshotAtIndex: any;
  formatIstTime: any;
  formatPrice: any;
  refreshReplayTimeline: any;
  isReplayPlaying: any;
  replayOverview: any;
  formatCurrency: any;
  replayStats: any;
  buildPressureSummary: any;
  replayIndex: any;
  replaySpeedMs: any;
  setReplaySpeedMs: any;
  handleReplaySnapshot: any;
  replayError: any;
  replayChainRange: any;
  formatStrike: any;
  replayChainRows: any;
  renderIvDeltaCell: any;
  renderPressureCell: any;
  renderLtpStack: any;
}

export function ReplayLab(props: ReplayLabProps) {
  const {
    replayExpiry,
    setReplayExpiry,
    setReplayStartSnapshotId,
    setReplayOverview,
    setReplaySnapshots,
    replaySnapshotsRef,
    setReplayIndex,
    replayIndexRef,
    setIsReplayPlaying,
    overview,
    replayStartSnapshotId,
    replaySnapshots,
    loadReplaySnapshotAtIndex,
    formatIstTime,
    formatPrice,
    refreshReplayTimeline,
    isReplayPlaying,
    replayOverview,
    formatCurrency,
    replayStats,
    buildPressureSummary,
    replayIndex,
    replaySpeedMs,
    setReplaySpeedMs,
    handleReplaySnapshot,
    replayError,
    replayChainRange,
    formatStrike,
    replayChainRows,
    renderIvDeltaCell,
    renderPressureCell,
    renderLtpStack
  } = props;

  return (
    <section className="rounded border border-terminal-line bg-terminal-panel/80 p-4">
      <h2 className="text-base font-semibold">Replay Lab</h2>
      <div className="mt-4">
      <div className="grid gap-4 text-sm">
        <div className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-3 md:grid-cols-[minmax(10rem,0.5fr)_minmax(12rem,0.7fr)_auto] md:items-end">
          <label className="grid gap-1 text-xs uppercase text-terminal-muted">
            Replay Expiry
            <ExpiryDatePicker
              expiries={overview.expiries}
              value={replayExpiry}
              onChange={(nextExpiry) => {
                setReplayExpiry(nextExpiry);
                setReplayStartSnapshotId("");
                setReplayOverview(null);
                setReplaySnapshots([]);
                replaySnapshotsRef.current = [];
                setReplayIndex(0);
                replayIndexRef.current = 0;
                setIsReplayPlaying(false);
              }}
            />
          </label>
          <label className="grid gap-1 text-xs uppercase text-terminal-muted">
            Start Time
            <select value={replayStartSnapshotId} onChange={(event) => {
              setReplayStartSnapshotId(event.target.value);
              const nextIndex = replaySnapshots.findIndex((snapshot: any) => snapshot.id === event.target.value);
              if (nextIndex >= 0) {
                void loadReplaySnapshotAtIndex(nextIndex);
              }
            }} className="h-10 rounded border border-terminal-line bg-terminal-input px-3 text-sm normal-case text-terminal-text outline-none focus:border-terminal-blue">
              {replaySnapshots.length ? replaySnapshots.map((snapshot: any) => (
                <option key={snapshot.id} value={snapshot.id}>{formatIstTime(snapshot.snapshotTime)} IST - {formatPrice(snapshot.spotPrice)}</option>
              )) : <option value="">Load snapshots first</option>}
            </select>
          </label>
          <button className="h-10 rounded border border-terminal-blue bg-terminal-blue px-4 text-sm font-semibold text-white transition hover:opacity-90" type="button" onClick={refreshReplayTimeline}>
            Load Replay
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <StatusTile icon={<Play size={18} />} label="Replay" value={isReplayPlaying ? "Playing" : replayOverview ? "Paused" : "Ready"} />
          <StatusTile icon={<Clock3 size={18} />} label="Snapshots" value={String(replaySnapshots.length)} />
          <StatusTile icon={<ShieldCheck size={18} />} label="Data Source" value="Stored ticks" />
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <SignalCell label="Replay Spot" value={formatPrice((replayOverview ?? overview).snapshot.spotPrice)} detail={`${formatIstTime((replayOverview ?? overview).snapshot.snapshotTime)} IST`} tone="blue" />
          <SignalCell label="Move From Open" value={formatCurrency(replayStats.moveFromStart)} detail={replayStats.movePercentText} tone={replayStats.moveFromStart >= 0 ? "green" : "red"} />
          <SignalCell label="Replay Bias" value={buildPressureSummary(replayOverview ?? overview).bias} detail={`PCR ${(replayOverview ?? overview).pressure.pcr?.toFixed(2) ?? "--"}`} tone="blue" />
          <SignalCell label="Timeline Range" value={replayStats.rangeText} detail={replayStats.windowText} tone="blue" />
        </div>
        <div className="grid gap-3 rounded border border-terminal-line bg-white/[0.03] p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button className="grid h-9 w-9 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-50" disabled={!replaySnapshots.length || replayIndex <= 0} type="button" onClick={() => loadReplaySnapshotAtIndex(Math.max(0, replayIndex - 1))} aria-label="Previous replay snapshot">
                <SkipBack size={16} />
              </button>
              <button className="grid h-10 w-10 place-items-center rounded border border-terminal-blue bg-terminal-blue text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" disabled={!replaySnapshots.length} type="button" onClick={() => setIsReplayPlaying((value: boolean) => !value)} aria-label={isReplayPlaying ? "Pause replay" : "Play replay"}>
                {isReplayPlaying ? <Pause size={17} /> : <Play size={17} />}
              </button>
              <button className="grid h-9 w-9 place-items-center rounded border border-terminal-line bg-terminal-input text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text disabled:cursor-not-allowed disabled:opacity-50" disabled={!replaySnapshots.length || replayIndex >= replaySnapshots.length - 1} type="button" onClick={() => loadReplaySnapshotAtIndex(Math.min(replaySnapshots.length - 1, replayIndex + 1))} aria-label="Next replay snapshot">
                <SkipForward size={16} />
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs uppercase text-terminal-muted">
              Speed
              <select value={replaySpeedMs} onChange={(event) => setReplaySpeedMs(Number(event.target.value))} className="h-9 rounded border border-terminal-line bg-terminal-input px-2 text-sm normal-case text-terminal-text outline-none focus:border-terminal-blue">
                <option value={2500}>1x</option>
                <option value={1500}>2x</option>
                <option value={750}>5x</option>
              </select>
            </label>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between text-xs text-terminal-muted">
              <span>{replaySnapshots[replayIndex] ? formatIstTime(replaySnapshots[replayIndex].snapshotTime) : "--"} IST</span>
              <span>{replaySnapshots.length ? `${replayIndex + 1} / ${replaySnapshots.length}` : "0 / 0"}</span>
            </div>
            <div className="h-2 rounded bg-white/10">
              <div className="h-2 rounded bg-terminal-blue transition-all" style={{ width: `${replaySnapshots.length > 1 ? (replayIndex / (replaySnapshots.length - 1)) * 100 : 0}%` }} />
            </div>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold">Snapshot Timeline</span>
            <button className="min-h-9 rounded border border-terminal-line px-3 py-1.5 text-xs text-terminal-muted transition hover:border-terminal-blue hover:text-terminal-text" type="button" onClick={refreshReplayTimeline}>
              Reload
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {replaySnapshots.map((snapshot: any) => (
              <button key={snapshot.id} className={`shrink-0 rounded border px-3 py-2 text-left transition ${replayOverview?.snapshot.snapshotTime === snapshot.snapshotTime ? "border-terminal-blue bg-terminal-blue/15 text-terminal-blue" : "border-terminal-line bg-white/[0.03] text-terminal-muted hover:border-terminal-blue hover:text-terminal-text"}`} type="button" onClick={() => handleReplaySnapshot(snapshot.id)}>
                <span className="block text-xs">{formatIstTime(snapshot.snapshotTime)}</span>
                <span className="block text-[0.7rem]">{formatPrice(snapshot.spotPrice)}</span>
              </button>
            ))}
            {!replaySnapshots.length ? <p className="rounded border border-terminal-line bg-white/[0.03] px-3 py-4 text-terminal-muted">No stored snapshots found.</p> : null}
          </div>
          {replayError ? <p className="text-terminal-red">{replayError}</p> : null}
        </div>
        <div className="min-w-0 rounded border border-terminal-line bg-terminal-panel/80">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-terminal-line p-4">
            <div>
              <h2 className="text-base font-semibold">Replay Snapshot</h2>
              <p className="mt-1 text-sm text-terminal-muted">
                {(replayOverview ?? overview).snapshot.underlyingSymbol} {(replayOverview ?? overview).snapshot.expiry} at {formatIstTime((replayOverview ?? overview).snapshot.snapshotTime)} IST
              </p>
              <p className="mt-1 text-xs text-terminal-muted">
                VIX range {formatStrike(replayChainRange.lower)}-{formatStrike(replayChainRange.upper)} using India VIX {replayChainRange.vix.toFixed(2)}%
              </p>
            </div>
            <span className="text-sm font-semibold text-terminal-blue">Spot {formatPrice((replayOverview ?? overview).snapshot.spotPrice)}</span>
          </div>
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-sm">
              <thead className="bg-white/[0.03] text-xs uppercase text-terminal-muted">
                <tr>
                  <th className="px-4 py-3 text-left">CE IV/Δ</th>
                  <th className="px-4 py-3 text-left">CE OI</th>
                  <th className="px-4 py-3 text-left">CE Chg</th>
                  <th className="px-4 py-3 text-left">CE Vol</th>
                  <th className="px-4 py-3 text-left">CE LTP</th>
                  <th className="px-4 py-3 text-center">Strike</th>
                  <th className="px-4 py-3 text-right">PE LTP</th>
                  <th className="px-4 py-3 text-right">PE Vol</th>
                  <th className="px-4 py-3 text-right">PE Chg</th>
                  <th className="px-4 py-3 text-right">PE OI</th>
                  <th className="px-4 py-3 text-right">PE IV/Δ</th>
                </tr>
              </thead>
              <tbody>
                {replayChainRows.map((row: any) => (
                  <tr key={row.strike} className={row.strike === (replayOverview ?? overview).snapshot.atmStrike ? "border-y border-terminal-blue/70 bg-terminal-blue/10" : "border-t border-terminal-line/80"}>
                    <td className="px-4 py-3">{renderIvDeltaCell(row.ceIv, row.ceDelta, "left")}</td>
                    <td className="px-4 py-3">{renderPressureCell(row.ceOi, row.ceOiRank, row.ceOiPercent, "CE")}</td>
                    <td className="px-4 py-3">{renderPressureCell(row.ceChg, row.ceChgRank, row.ceChgPercent, "CE")}</td>
                    <td className="px-4 py-3">{renderPressureCell(row.ceVol, row.ceVolRank, row.ceVolPercent, "CE")}</td>
                    <td className="px-4 py-3">{renderLtpStack(row.ceLtp, row.ceLtpChange, row.ceLtpChangePercent, "left", row.ceActivity)}</td>
                    <td className="px-4 py-3 text-center font-semibold text-terminal-text">{row.strike}</td>
                    <td className="px-4 py-3 text-right">{renderLtpStack(row.peLtp, row.peLtpChange, row.peLtpChangePercent, "right", row.peActivity)}</td>
                    <td className="px-4 py-3">{renderPressureCell(row.peVol, row.peVolRank, row.peVolPercent, "PE")}</td>
                    <td className="px-4 py-3">{renderPressureCell(row.peChg, row.peChgRank, row.peChgPercent, "PE")}</td>
                    <td className="px-4 py-3">{renderPressureCell(row.peOi, row.peOiRank, row.peOiPercent, "PE")}</td>
                    <td className="px-4 py-3">{renderIvDeltaCell(row.peIv, row.peDelta, "right")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>
    </section>
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

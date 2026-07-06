/**
 * Backtest: does spot actually react at the "Nearest Support" / "Nearest
 * Resistance" levels the dashboard already computes (calculatePressureScore
 * .supportZones[0] / .resistanceZones[0]) - and if so, how often?
 *
 * Context: while investigating a third-party option-chain tool's ("AOC")
 * on-chart support/resistance levels, we couldn't get access to their
 * historical level values to check their accuracy (no export, no visible
 * formula, live-only WebSocket feed). This backtests OUR OWN existing
 * support/resistance methodology instead, against real historical intraday
 * data this app has actually captured - a number we can compute and defend,
 * rather than a guess about someone else's black box.
 *
 * Definition of "reacted" (confirmed with the user):
 *   Spot comes within TOUCH_TOLERANCE_POINTS of a level ("a touch"), then at
 *   some point in the following REACTION_WINDOW_MS moves back away from that
 *   level by at least REACTION_POINTS (support: bounces up; resistance:
 *   rejects down). Reported as reactions / touches, i.e. the level's hit
 *   rate - NOT a prediction win-rate like backtest-recommendations.ts.
 *
 * To avoid inflating the touch count from many consecutive ticks sitting
 * near the same level, each side (support/resistance) has a cooldown: once a
 * touch is registered, no new touch on that side is counted until the
 * current touch's evaluation window has fully elapsed.
 *
 * This is read-only and reuses the real calculatePressureScore engine, same
 * pattern as backtest-recommendations.ts, so results can't drift from what
 * the dashboard actually shows.
 *
 * Usage (run inside the api container, which already has DATABASE_URL and
 * tsx configured):
 *   pnpm --filter @option-decode/api exec tsx src/scripts/backtest-support-resistance.ts [UNDERLYING] [TOUCH_TOLERANCE_POINTS] [REACTION_WINDOW_MIN]
 *
 * Defaults to NIFTY, 15 points, 15 minutes, across EVERY trading date this
 * app has captured snapshots for (via listReplayTradingDates) - single-day
 * samples are too small to say anything reliable about a hit rate.
 */
import { calculatePressureScore } from "@option-decode/analytics";
import { getOptionChainSnapshotById, listReplaySnapshots, listReplayTradingDates } from "@option-decode/db";
import type { OptionChainSnapshot } from "@option-decode/types";

const UNDERLYING = process.argv[2] ?? "NIFTY";
const TOUCH_TOLERANCE_POINTS = process.argv[3] ? Number(process.argv[3]) : 15;
const REACTION_WINDOW_MIN = process.argv[4] ? Number(process.argv[4]) : 15;
const REACTION_POINTS = TOUCH_TOLERANCE_POINTS; // same threshold used for "how close counts as a touch" and "how far counts as a reaction" - see file header.
const REACTION_WINDOW_MS = REACTION_WINDOW_MIN * 60 * 1000;

type LevelType = "support" | "resistance";

interface SpotPoint {
  ms: number;
  spot: number;
}

interface TouchResult {
  tradingDate: string;
  levelType: LevelType;
  level: number;
  touchMs: number;
  reacted: boolean;
}

async function loadDaySnapshots(underlying: string, tradingDate: string): Promise<OptionChainSnapshot[]> {
  const summaries = (await listReplaySnapshots(underlying, undefined, tradingDate)).sort((a, b) => a.snapshotTime.localeCompare(b.snapshotTime));
  const snapshots: OptionChainSnapshot[] = [];
  for (const row of summaries) {
    const full = await getOptionChainSnapshotById(row.id);
    if (full) snapshots.push(full);
  }
  return snapshots;
}

function reactedWithinWindow(timeline: SpotPoint[], touchMs: number, level: number, levelType: LevelType): boolean {
  for (const point of timeline) {
    if (point.ms <= touchMs) continue;
    if (point.ms > touchMs + REACTION_WINDOW_MS) break;
    const moveAwayFromLevel = levelType === "support" ? point.spot - level : level - point.spot;
    if (moveAwayFromLevel >= REACTION_POINTS) return true;
  }
  return false;
}

/** Walks one day's snapshots, registering a "touch" whenever spot comes
 * within tolerance of that moment's support/resistance level, subject to a
 * per-side cooldown so one drawn-out touch doesn't get counted dozens of
 * times as price sits near the level tick after tick. */
function findTouchesForDay(tradingDate: string, snapshots: OptionChainSnapshot[]): TouchResult[] {
  const timeline: SpotPoint[] = snapshots.map((s) => ({ ms: Date.parse(s.snapshotTime), spot: s.spotPrice }));
  const touches: TouchResult[] = [];
  const cooldownUntilMs: Record<LevelType, number> = { support: -Infinity, resistance: -Infinity };

  snapshots.forEach((snapshot, index) => {
    const ms = timeline[index].ms;
    const pressure = calculatePressureScore(snapshot);

    (["support", "resistance"] as const).forEach((levelType) => {
      if (ms < cooldownUntilMs[levelType]) return;

      const zone = levelType === "support" ? pressure.supportZones[0] : pressure.resistanceZones[0];
      if (!zone) return;

      const distance = Math.abs(snapshot.spotPrice - zone.strikePrice);
      if (distance > TOUCH_TOLERANCE_POINTS) return;

      const reacted = reactedWithinWindow(timeline, ms, zone.strikePrice, levelType);
      touches.push({ tradingDate, levelType, level: zone.strikePrice, touchMs: ms, reacted });
      cooldownUntilMs[levelType] = ms + REACTION_WINDOW_MS;
    });
  });

  return touches;
}

async function main() {
  console.log(`Backtesting ${UNDERLYING} support/resistance reactions (touch tolerance: ${TOUCH_TOLERANCE_POINTS}pts, reaction window: ${REACTION_WINDOW_MIN}min, reaction size: ${REACTION_POINTS}pts)...\n`);

  const tradingDates = await listReplayTradingDates(UNDERLYING);
  if (!tradingDates.length) {
    console.log("No trading dates found for that underlying. Nothing to backtest.");
    return;
  }

  const allTouches: TouchResult[] = [];
  for (const tradingDate of tradingDates) {
    const snapshots = await loadDaySnapshots(UNDERLYING, tradingDate);
    if (!snapshots.length) continue;
    allTouches.push(...findTouchesForDay(tradingDate, snapshots));
  }

  if (!allTouches.length) {
    console.log("No touches of a computed support/resistance level found across the captured history. Nothing to score.");
    return;
  }

  console.log(`Trading days scanned: ${tradingDates.length}`);
  console.log(`Total level touches: ${allTouches.length}\n`);

  console.log("level".padEnd(12) + "touches".padEnd(10) + "reacted".padEnd(10) + "no-reaction".padEnd(13) + "hit-rate");
  console.log("-".repeat(55));

  (["support", "resistance"] as const).forEach((levelType) => {
    const touches = allTouches.filter((t) => t.levelType === levelType);
    const reacted = touches.filter((t) => t.reacted).length;
    const hitRate = touches.length ? `${((reacted / touches.length) * 100).toFixed(0)}%` : "n/a";
    console.log(levelType.padEnd(12) + String(touches.length).padEnd(10) + String(reacted).padEnd(10) + String(touches.length - reacted).padEnd(13) + hitRate);
  });

  const totalReacted = allTouches.filter((t) => t.reacted).length;
  console.log("-".repeat(55));
  console.log("overall".padEnd(12) + String(allTouches.length).padEnd(10) + String(totalReacted).padEnd(10) + String(allTouches.length - totalReacted).padEnd(13) + `${((totalReacted / allTouches.length) * 100).toFixed(0)}%`);

  console.log(`\nSample: ${tradingDates.length} trading day(s). More days captured = a more reliable number - treat this as directional until the app has accumulated weeks/months of history.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

/**
 * Quick backtest: replays a day's already-captured option-chain snapshots
 * through the exact production recommendation pipeline
 * (calculatePressureScore -> calculateStrikeMovement ->
 * calculateTradeInterpretation -> calculateMarketBias ->
 * calculateTradeRecommendations, the same composition used in
 * apps/api/src/server.ts's /api/market/overview handler) and checks each
 * fired recommendation against what price actually did afterward.
 *
 * This is intentionally a read-only, one-off analysis script - it does not
 * persist anything and re-uses the real engine code so results can't drift
 * from what the dashboard actually showed.
 *
 * Usage (run inside the api container, which already has DATABASE_URL and
 * tsx configured):
 *   pnpm --filter @option-decode/api exec tsx src/scripts/backtest-recommendations.ts [UNDERLYING] [YYYY-MM-DD] [MOVE_THRESHOLD_PCT]
 *
 * Defaults to NIFTY, today (server-local date), and a 0.3% move threshold.
 */
import { getOptionChainSnapshotById, listReplaySnapshots } from "@option-decode/db";
import { calculateMarketBias, calculatePressureScore, calculateStrikeMovement, calculateTradeInterpretation } from "@option-decode/analytics";
import { calculateTradeRecommendations } from "@option-decode/trading";
import type { OptionChainSnapshot } from "@option-decode/types";

const UNDERLYING = process.argv[2] ?? "NIFTY";
const TRADING_DATE = process.argv[3] ?? new Date().toISOString().slice(0, 10);

// Confirmed with the user: a directional call "succeeds" if price moves
// 0.3%+ in the predicted direction within 30 minutes of the snapshot it
// fired on. Overridable via CLI arg - the first run at 0.3% on a quiet
// session showed almost every directional call landing as "neutral"
// (no 30-min window moved that much at all), so this is here to let us
// check whether a smaller bar still produces a decisive read on the same
// day's data, versus the calls genuinely having no signal.
const MOVE_THRESHOLD_PCT = process.argv[4] ? Number(process.argv[4]) : 0.3;
const LOOKAHEAD_MS = 30 * 60 * 1000;
// How much slack we allow when looking for "the snapshot ~30 min later" -
// capture isn't on a perfectly even cadence, so we accept the nearest
// snapshot at or after the target time, as long as it's not more than this
// much further out (otherwise we'd be scoring against a much longer window
// than intended, e.g. near session close).
const LOOKAHEAD_SLACK_MS = 3 * 60 * 1000;

// --- Scoring rules per recommendation id -----------------------------------
// bullish-bias/bearish-bias are the two genuinely directional calls the
// engine makes, and the 0.3%/30min rule above was defined specifically for
// them. The rest of the recommendation categories imply a direction or an
// expectation too, so the same idea is extended to them here, with the
// mapping made explicit so it's easy to challenge/adjust:
//   - near-support implies a bounce (price up); near-resistance implies a
//     rejection (price down) - scored with the same directional rule.
//   - buyer-momentum doesn't carry its own direction; it inherits whichever
//     way calculateMarketBias leaned at that moment.
//   - balanced-market / seller-safety / avoid-atm-options all predict the
//     market stays range-bound - scored as a "success" if price stayed
//     within the 0.3% band instead of breaking out of it.
//   - at-max-pain / near-max-pain predict a pull toward the Max Pain strike
//     - scored by whether the distance to Max Pain shrank over the window,
//     since that's the actual claim being made (not a fixed % move).
//   - wait-for-setup / setup-ready are timing calls, not price predictions
//     on their own - they're reported (fired counts) but not scored
//     win/loss, since "wait" has no falsifiable target and "ready" doesn't
//     specify a direction by itself.
const DIRECTIONAL_UP = new Set(["bullish-bias", "near-support"]);
const DIRECTIONAL_DOWN = new Set(["bearish-bias", "near-resistance"]);
const STAY_FLAT = new Set(["balanced-market", "seller-safety", "avoid-atm-options"]);
const MAX_PAIN_PULL = new Set(["at-max-pain", "near-max-pain"]);
const UNSCORED = new Set(["wait-for-setup", "setup-ready"]);

type Outcome = "success" | "failure" | "neutral" | "unscored";

interface FiredRecommendation {
  id: string;
  title: string;
  category: string;
  confidence: number;
  snapshotTime: string;
  spotAtFire: number;
  maxPainAtFire?: number;
  biasAtFire: string;
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

function buildSpotTimeline(snapshots: OptionChainSnapshot[]) {
  return snapshots.map((s) => ({ ms: Date.parse(s.snapshotTime), spot: s.spotPrice }));
}

function spotAtOrAfter(timeline: { ms: number; spot: number }[], targetMs: number): number | undefined {
  let best: { ms: number; spot: number } | undefined;
  for (const point of timeline) {
    if (point.ms >= targetMs && (!best || point.ms < best.ms)) best = point;
  }
  if (best && best.ms - targetMs <= LOOKAHEAD_SLACK_MS) return best.spot;
  return undefined;
}

function classify(fire: FiredRecommendation, timeline: { ms: number; spot: number }[]): Outcome {
  if (UNSCORED.has(fire.id)) return "unscored";

  const fireMs = Date.parse(fire.snapshotTime);
  const futureSpot = spotAtOrAfter(timeline, fireMs + LOOKAHEAD_MS);
  if (futureSpot === undefined) return "unscored";

  if (MAX_PAIN_PULL.has(fire.id)) {
    if (fire.maxPainAtFire === undefined) return "unscored";
    const distNow = Math.abs(fire.spotAtFire - fire.maxPainAtFire);
    const distLater = Math.abs(futureSpot - fire.maxPainAtFire);
    if (distLater < distNow) return "success";
    if (distLater > distNow) return "failure";
    return "neutral";
  }

  const movePct = ((futureSpot - fire.spotAtFire) / fire.spotAtFire) * 100;

  if (STAY_FLAT.has(fire.id)) {
    return Math.abs(movePct) < MOVE_THRESHOLD_PCT ? "success" : "failure";
  }

  let expectUp: boolean | undefined;
  if (DIRECTIONAL_UP.has(fire.id)) expectUp = true;
  else if (DIRECTIONAL_DOWN.has(fire.id)) expectUp = false;
  else if (fire.id === "buyer-momentum") {
    if (fire.biasAtFire === "Bullish") expectUp = true;
    else if (fire.biasAtFire === "Bearish") expectUp = false;
    else return "unscored"; // no direction to check against
  }

  if (expectUp === undefined) return "unscored";
  if (expectUp) {
    if (movePct >= MOVE_THRESHOLD_PCT) return "success";
    if (movePct <= -MOVE_THRESHOLD_PCT) return "failure";
    return "neutral";
  } else {
    if (movePct <= -MOVE_THRESHOLD_PCT) return "success";
    if (movePct >= MOVE_THRESHOLD_PCT) return "failure";
    return "neutral";
  }
}

async function main() {
  console.log(`Backtesting ${UNDERLYING} recommendations for ${TRADING_DATE} (move threshold: ${MOVE_THRESHOLD_PCT}%, lookahead: ${LOOKAHEAD_MS / 60000}min)...`);

  const snapshots = await loadDaySnapshots(UNDERLYING, TRADING_DATE);
  if (!snapshots.length) {
    console.log("No snapshots found for that underlying/date. Nothing to backtest.");
    return;
  }
  console.log(`Loaded ${snapshots.length} snapshots (${snapshots[0].snapshotTime} -> ${snapshots[snapshots.length - 1].snapshotTime}).\n`);

  const timeline = buildSpotTimeline(snapshots);
  const fired: FiredRecommendation[] = [];

  for (const snapshot of snapshots) {
    const pressure = calculatePressureScore(snapshot);
    const strikeMovement = calculateStrikeMovement(snapshot);
    const tradeInterpretation = calculateTradeInterpretation(strikeMovement);
    const marketBias = calculateMarketBias(snapshot, pressure);
    const recommendations = calculateTradeRecommendations(snapshot, pressure, marketBias, strikeMovement, tradeInterpretation);

    for (const rec of recommendations) {
      fired.push({
        id: rec.id,
        title: rec.title,
        category: rec.category,
        confidence: rec.confidence,
        snapshotTime: snapshot.snapshotTime,
        spotAtFire: snapshot.spotPrice,
        maxPainAtFire: pressure.maxPain,
        biasAtFire: marketBias.bias
      });
    }
  }

  const byId = new Map<string, { title: string; category: string; outcomes: Record<Outcome, number>; confidenceSum: number }>();
  for (const fire of fired) {
    const outcome = classify(fire, timeline);
    if (!byId.has(fire.id)) {
      byId.set(fire.id, { title: fire.title, category: fire.category, outcomes: { success: 0, failure: 0, neutral: 0, unscored: 0 }, confidenceSum: 0 });
    }
    const entry = byId.get(fire.id)!;
    entry.outcomes[outcome] += 1;
    entry.confidenceSum += fire.confidence;
  }

  console.log(`Total recommendations fired across the session: ${fired.length}\n`);
  console.log(
    "id".padEnd(20) + "fired".padEnd(8) + "success".padEnd(9) + "failure".padEnd(9) + "neutral".padEnd(9) + "unscored".padEnd(10) + "win-rate*".padEnd(10) + "avg-conf"
  );
  console.log("-".repeat(90));

  for (const [id, entry] of [...byId.entries()].sort((a, b) => b[1].outcomes.success + b[1].outcomes.failure - (a[1].outcomes.success + a[1].outcomes.failure))) {
    const totalFired = entry.outcomes.success + entry.outcomes.failure + entry.outcomes.neutral + entry.outcomes.unscored;
    const decisive = entry.outcomes.success + entry.outcomes.failure;
    const winRate = decisive > 0 ? `${((entry.outcomes.success / decisive) * 100).toFixed(0)}%` : "n/a";
    const avgConf = `${(entry.confidenceSum / totalFired).toFixed(0)}%`;
    console.log(
      id.padEnd(20) +
        String(totalFired).padEnd(8) +
        String(entry.outcomes.success).padEnd(9) +
        String(entry.outcomes.failure).padEnd(9) +
        String(entry.outcomes.neutral).padEnd(9) +
        String(entry.outcomes.unscored).padEnd(10) +
        winRate.padEnd(10) +
        avgConf
    );
  }

  console.log(`\n* win-rate = success / (success + failure), excluding neutral (no ${MOVE_THRESHOLD_PCT}% move either way) and unscored (timing calls, or no data far enough ahead) results.`);
  console.log(`  Sample: 1 trading day (${TRADING_DATE}). Treat these numbers as directional, not statistically reliable, until more days are captured.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

# Divergence Trading — F&O Stocks, 1-Hour Timeframe

**Status: Planning only. Nothing described here is built.** No code in
`packages/analytics`, no worker job, no UI tab exists for this yet. This
document exists to pin the rules down precisely enough to build and backtest,
before any of that starts.

A first backtest ran against production data on 2026-08-07 — see
[`divergence-trading-backtest-report.md`](divergence-trading-backtest-report.md).
Short version: 9 trading days of history produced only 5 signals total, not
enough to conclude anything about the strategy. Worth reading before
resolving any of the open questions below, since it surfaces a couple of
things (the weighted universe currently means all 16 stocks with a seeded
index weight, not a curated subset; the full-universe run also hit an
unrelated memory issue on the production host worth fixing first).

## Decided so far

| Question | Decision |
|---|---|
| Instrument | Stock futures (F&O), traded directly — not options |
| Timeframe | 1-hour candles |
| Divergence type | **Regular** divergence only (reversal signal). Hidden divergence (continuation) is parked, see [Phase 2](#phase-2--parked-ideas) |
| Confirming signal | **RSI divergence only, for now.** Volume was going to be a second confirmation step, but is deliberately set aside — not dropped, just not part of this build. See [Phase 2](#phase-2--parked-ideas) |
| Price-vs-OI divergence | Parked as a Phase 2 idea — the app's own data advantage, but not part of the MVP rule set |

Everything below this line is a **proposal** — specific enough to build and
backtest, but every number is a starting point, not a conclusion. Divergence
trading fails in practice almost entirely from vague rules (which pivot
counts, how much disagreement is "enough"), so the goal here is to remove
every place a discretionary judgment call could creep in.

## 1. Universe

Not yet decided. Two options, both already representable in the schema:

- **Every active `FnoStock`** — broadest coverage, but a 1-hour-candle
  divergence scan across the full F&O list is a lot of surface area to watch
  and to backtest.
- **The same top-weighted subset `STOCK_OPTION_CHAIN_WEIGHT_THRESHOLD_PERCENT`
  already selects** (`packages/config`, cumulative index weight, currently
  70%) — reuses an existing, already-seeded universe definition instead of
  inventing a second one.

Leaning toward the second, since it's one fewer thing to seed and keep in
sync, but this needs a decision before building the scanner.

## 2. RSI divergence — exact rule

The whole signal, for now — nothing else gates it. Reuses the ZigZag pivot
detector already built and tested for Elliott Wave (`detectZigZagPivots` in
`packages/analytics/src/elliott-wave.ts`) rather than inventing a second
swing-detection method. That function already does exactly what divergence
detection needs: walk a price series, confirm a pivot once price reverses off
the running extreme by more than a threshold percentage.

**Bearish regular divergence** (signal to go short):
- Two confirmed swing-high pivots, H1 then H2, with H2 the more recent.
- Price condition: `price(H2) > price(H1)` — a higher high.
- RSI condition: `RSI(H2) < RSI(H1)` — momentum did not confirm the new high.

**Bullish regular divergence** (signal to go long):
- Two confirmed swing-low pivots, L1 then L2.
- Price condition: `price(L2) < price(L1)` — a lower low.
- RSI condition: `RSI(L2) > RSI(L1)` — momentum did not confirm the new low.

Proposed parameters, both need backtesting before being trusted:
- **RSI period: 14**, the standard default, computed on the 1-hour close series.
- **ZigZag reversal threshold:** starting guess **1.5%**, the same magnitude
  Elliott Wave's own `WAVE_ZIGZAG_PRESETS.weekly` uses — chosen because a 1-hour
  F&O stock swing is roughly comparable in scale to what that preset targets,
  not because it's been tested against this specific use. Elliott Wave's own
  comment on that constant says plainly it's "a starting heuristic, not
  backtested" — same caveat applies here, doubly so.

**Known, unavoidable limitation:** ZigZag pivots are only confirmed
retrospectively — `detectZigZagPivots`'s own doc comment says the final entry
is always provisional. That means a divergence can only be *confirmed* once
price has already reversed enough off H2/L2 to lock the pivot in. Some of the
move is necessarily missed by the time the signal fires. This is inherent to
any pivot-based divergence system, not a bug to fix later — the entry-timing
section below is about managing that lag, not eliminating it.

Worth being direct about the tradeoff of dropping volume from this pass:
without a second confirmation step, RSI-only divergence is expected to fire
more often and include more false signals than the staged version would have.
That's an accepted tradeoff for getting an MVP built and backtested faster,
not an oversight — see [Phase 2](#phase-2--parked-ideas) for what the
confirmation step looked like and why it's coming back later, once there's a
real backtest to compare RSI-only against.

## 3. Entry

Not yet decided between two standard approaches:
- **On confirmation** — enter as soon as the pivot that completes the
  divergence is confirmed (i.e. price has reversed past the ZigZag threshold
  off H2/L2). Fastest, but "confirmed" already means some of the reversal
  happened.
- **Next candle open** — wait one more hourly candle past confirmation.
  Slower, gives the market one more bar to either validate or invalidate the
  signal before committing capital.

## 4. Stop-loss

Proposed: **beyond the pivot that generated the signal** — above H2 for a
short, below L2 for a long, plus a small buffer (e.g. 0.2–0.3×ATR) to avoid
being stopped by noise exactly at the level. This is the natural invalidation
point: if price takes out the pivot the divergence was measured from, the
"weaker high/low" premise the trade was built on is simply wrong.

## 5. Target / exit

Three candidates, not yet chosen between:
- Fixed R-multiple (e.g. 1.5R or 2R) off the entry/stop distance.
- Trail to the next opposing ZigZag pivot as it forms.
- Exit when RSI recrosses the 50 line back through in the trade's favor,
  independent of price target — an indicator-driven exit rather than a
  price-driven one.

## 6. Risk / position sizing

Futures lot size already exists per-stock (`FnoStock.lotSize` /
`getStoredFnoLotSize` in `packages/db`), so sizing math has a real number to
work from. What's still undefined: risk-per-trade as a percentage of capital,
and a max-concurrent-positions cap across the universe. Paper Trade Pro
already had to solve exactly this class of problem for options (capital,
margin, position sizing) — worth reusing that reasoning rather than
re-deriving it from nothing.

## Data & infrastructure gap

This is the part most likely to change the timeline, so it's stated plainly
rather than glossed over: **there is currently no 1-hour OHLCV candle data
anywhere in this app, for anything.**

- `OptionChainSnapshot` captures spot price every ~30 seconds — a raw tick
  series, not candles.
- The Elliott Wave wave-screener captures F&O stock quotes **once a minute**
  (`QUOTE_CAPTURE_INTERVAL_MS` in `apps/worker/src/wave-screener.ts`), but
  only LTP + volume, not OHLC — and that's what feeds its own ZigZag detector
  directly off raw ticks, exactly sidestepping the need for candles.
- `packages/dhan`'s client has no historical or intraday candle API call at
  all today — only live quote endpoints (LTP, OHLC-of-the-day, full quote).

RSI needs a clean, non-overlapping series of hourly closes. Two paths to get
there, neither built yet:

1. **Add Dhan's historical/intraday candle endpoint** to `packages/dhan` and
   pull real 1-hour OHLCV directly. Cleanest data, new external dependency
   and a new rate-limit budget to manage (Dhan already rate-limits LTP/OHLC
   to 1 req/sec combined — worth checking their historical-data limits
   separately before assuming this is free).
2. **Resample from captured ticks.** Works today with zero new integration,
   but at 1-minute LTP-only capture, a synthesized "hourly candle" has a real
   open/close but an approximated high/low (whatever the minute-ticks
   happened to catch, not true intrabar extremes).

No recommendation yet between the two — it depends on how much the synthetic
candle's imprecision actually matters once backtested against the alternative.
Worth choosing with an eye on Phase 2, though: real exchange-reported volume
(not a sum of per-minute deltas) is exactly what the parked volume
confirmation step will need, so path 1 pays off twice if it's ever built.

## How this would plug into the existing code

Once the rules above are settled:

- Detection logic belongs in `packages/analytics`, alongside
  `elliott-wave.ts` and `strike-matrix.ts` — a pure function over a price
  series, same shape as the rest of that package, reusing
  `detectZigZagPivots` rather than a parallel implementation.
- A backtest would follow the existing convention in
  `apps/api/src/scripts/backtest-recommendations.ts`: a read-only script that
  replays already-captured data through the real detection function (so
  backtest results can't drift from what a live signal would have said) and
  scores each signal against what price did afterward over a defined
  lookahead window.
- If it graduates past backtesting, a worker job on the same pattern as
  `wave-screener.ts`'s scan cycle, not a new architecture.

## Phase 2 — parked ideas

**Volume confirmation.** The original plan had this as a second step, not a
joint condition computed alongside RSI: RSI divergence produces a
**candidate**; a separate volume pass either upgrades it to **confirmed** or
leaves it as-is. Parked rather than built now, but the design thinking is
worth keeping rather than re-deriving later:

- **Rule:** `volume(H2) < volume(H1)` for bearish, `volume(L2) < volume(L1)`
  for bullish — the new extreme made on weaker participation than the prior
  one, checked as its own pass over RSI candidates rather than folded into
  one combined condition.
- **Open question — timing.** Same bar as the RSI trigger, or a short window
  afterward (e.g. up to N bars past H2/L2)? A staged step implies
  confirmation is allowed to lag the trigger, which same-bar checking would
  quietly foreclose.
- **Open question — unconfirmed candidates.** Discarded, logged separately
  (so a later backtest can answer "does RSI-only ever outperform
  RSI+Volume"), or surfaced as a lower-conviction signal a trader could still
  act on manually?
- **Open question — volume window.** Single-candle volume at the pivot, or an
  averaged window (e.g. 3 bars) around it — single-bar volume on an hourly
  candle is noisier than daily.

Revisit once RSI-only has been backtested — that result is what should decide
whether this is worth adding, not just running it because it makes intuitive
sense as risk-reduction.

**Price-vs-OI divergence.** Genuinely compelling — this app has option-chain
and futures OI data that no generic charting/divergence tool has access to,
which is the app's real edge over RSI divergence that anyone can compute from
a candle chart. Deliberately not in the MVP: it needs its own precise
definition (OI *change* vs OI *level*? measured on the futures contract, or
aggregate CE+PE OI?) and depends on the same candle infrastructure question
above, so it would only add ambiguity to a first version. Worth returning to
once RSI-only is validated.

**Hidden divergence (continuation).** Structurally the mirror image of the
rules above — price makes a *shallower* high/low while the indicator makes a
*stronger* one — but it's a fundamentally different trade context
(continuation within a trend vs. reversal), so it deserves its own entry/stop
logic rather than being bolted onto the reversal rules as an afterthought.

## Honest limitations

- Confirmation lag (see [§2](#2-rsi-divergence--exact-rule)) is structural,
  not a parameter to tune away.
- The ZigZag threshold and RSI period above are unbacktested starting
  guesses, stated as such — see this project's own standing rule: verify
  against real data before trusting a number, and don't over-claim from a
  short sample.
- Dropping volume confirmation ([Phase 2](#phase-2--parked-ideas)) is a
  deliberate scope cut, not a finding that volume doesn't help — RSI-only is
  expected to be noisier. Don't read an early RSI-only backtest as a verdict
  on the full strategy design.
- Divergence trading in general has a wide range of published win rates
  depending on market regime; nothing here should be read as an edge until
  it's been backtested on real F&O stock data across more than a handful of
  sessions.

## Open questions before building

1. Universe: full F&O list or the index-weight-threshold subset ([§1](#1-universe))?
2. Entry timing: on confirmation, or one candle later ([§3](#3-entry))?
3. Exit rule: R-multiple, trailing pivot, or RSI-crossback ([§5](#5-target--exit))?
4. Risk-per-trade % and max concurrent positions ([§6](#6-risk--position-sizing))?
5. Candle data source: new Dhan integration or resampled ticks ([Data & infrastructure gap](#data--infrastructure-gap))?

## Next steps

Nothing is built yet. Once the open questions above are settled, the natural
order is: (1) resolve the candle-data question, since nothing else can be
backtested without it, (2) implement RSI-divergence detection in
`packages/analytics` alongside its own unit tests, (3) a backtest script
following the `backtest-recommendations.ts` pattern, (4) only then a worker
scan job and any UI. Volume confirmation ([Phase 2](#phase-2--parked-ideas))
comes after RSI-only has real backtest results to compare against.

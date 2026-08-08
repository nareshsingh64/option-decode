# Divergence Trading — First Backtest Report

**Read [`divergence-trading-strategy.md`](divergence-trading-strategy.md) first.**
That plan lists five open questions before this strategy can be built for
real. This backtest could not wait for all five to be resolved, so it made
one concrete, disclosed choice for each — those choices are backtest-only
defaults, not decisions the plan has actually made. Treat every number below
as "what this one set of assumptions produced on nine days of data," not as
a verdict on the strategy.

**Headline: the sample is too small to conclude anything.** 5 signals fired
in total across the data actually processed. That is not a typo — five. The
rest of this document explains why, and what came out of those five anyway,
but the short version: come back once weeks of real 1-hour candle data
exist, not days.

## What ran, and against what data

- **Script:** [`apps/api/src/scripts/backtest-divergence-1h.ts`](../apps/api/src/scripts/backtest-divergence-1h.ts),
  read-only, reuses the real production `detectZigZagPivots` and
  `calculateRsi` functions rather than reimplementing the rules.
- **Data:** `WavePricePoint` on production — 1-minute LTP ticks for F&O
  stocks, 2026-07-28 through 2026-08-07 (**9 trading days**, correctly
  excluding the Aug 1–2 weekend). There is no real OHLC candle data
  anywhere in this app yet (see the plan doc's "Data & infrastructure gap"),
  so this script resamples those ticks into synthetic hourly candles —
  open/close are the first/last tick in each session-anchored hour bucket
  (09:15–10:15, 10:15–11:15, … 15:15–15:30), high/low are the min/max tick
  seen in that bucket, **not** true intrabar extremes, since capture is only
  1 tick/minute.
- **Universe run 1 — the weighted subset:** the same stocks
  `getOptionChainTrackedStocks` would select at a 70% cumulative
  index-weight threshold. **This resolved to all 16 stocks that currently
  have `indexWeightPercent` seeded** — HDFCBANK down to TITAN — because only
  16 of 214 active `FnoStock` rows have a weight at all today. The plan
  doc's "leaning toward" this universe is worth revisiting with that in
  mind: it isn't a curated top-16, it's *every* stock with a number, and it
  happens to cross 70% right at the last one (70.12%).
- **Universe run 2 — the full universe: incomplete, see below.** 209
  symbols have `WavePricePoint` history. Running all 209 in one process hit
  a real, previously-unknown memory problem on the production host and had
  to be stopped — see "A genuine finding: this script leaks memory" below.
  **Only the first 30 symbols (alphabetically, ABB → BAJFINANCE) were
  actually scored.** Numbers for the other ~179 symbols do not exist yet.

## The five backtest-only assumptions

| Open question in the plan | This run's choice |
|---|---|
| Universe | Both of the above, reported separately |
| Entry timing | On confirmation — entry at the close of the candle where a pivot leaves the ZigZag's provisional slot. Computed via a genuine walk-forward replay (pivots recomputed on every prefix of the series, one candle at a time) so no signal can see its own future — not the simpler "run once, drop the last pivot" shortcut |
| Stop-loss | Beyond the H2/L2 pivot, buffered by 0.25× ATR(14) on the hourly series (midpoint of the plan's 0.2–0.3× range) |
| Target / exit | Fixed 2R (mid of the plan's 1.5R/2R candidates) |
| Candle data source | Resampled from `WavePricePoint` ticks (path 2 in the plan — no Dhan historical-candle integration exists to try path 1) |

RSI period 14 and ZigZag threshold 1.5% are the plan's own proposed
defaults (`WAVE_ZIGZAG_PRESETS.weekly`), not new choices made here.

## Results

### Weighted subset — 16 stocks, 1,008 hourly candles

**1 signal fired.**

| Symbol | Direction | Entry time (IST) | Entry | Stop | Target | Outcome | R so far |
|---|---|---|---|---|---|---|---|
| BAJFINANCE | short | 2026-08-07 09:15:29 | 1100.40 | 1164.85 | 971.50 | still open at end of data | +0.35R |

Zero closed trades. Nothing to compute a win rate from.

### Full universe, partial — 30 of 209 symbols (ABB → BAJFINANCE), 1,890 hourly candles

**4 signals fired** (BAJFINANCE's signal is the same one as above — it's
alphabetically inside this batch too, expected overlap).

| Symbol | Direction | Entry time (IST) | Entry | Stop | Target | Outcome | R |
|---|---|---|---|---|---|---|---|
| AMBUJACEM | short | 2026-08-05 15:15:29 | 443.00 | 450.73 | 427.53 | still open | +1.16R |
| APLAPOLLO | short | 2026-08-06 14:15:29 | 1956.00 | 1996.07 | 1875.86 | still open | -0.35R |
| AMBER | short | 2026-08-07 09:15:29 | 7389.00 | 7543.98 | 7079.04 | **stop hit** | -1.00R |
| BAJFINANCE | short | 2026-08-07 09:15:29 | 1100.40 | 1164.85 | 971.50 | still open | +0.35R |

1 closed trade (a loss), 3 still open when the data ran out. A single
closed trade cannot produce a meaningful win rate — reporting it as 0% would
be technically true and completely misleading, which is exactly the kind of
claim this project's "don't over-claim from a short sample" rule exists to
prevent.

### Full pivot detail, for checking each signal against a real chart

Each signal is a **bearish regular divergence**: two confirmed swing-high
pivots (H1 then H2) where price made a higher high but RSI made a lower
high. Times are IST (session hours 09:15–15:30); the UTC instant is in
parentheses for cross-checking against raw `WavePricePoint`/log timestamps.

**BAJFINANCE (short)**
- H1: 2026-08-03 09:15:29 IST (`2026-08-03T03:45:29.469Z`) — price 1159.00, RSI 84.1
- H2: 2026-08-05 10:15:29 IST (`2026-08-05T04:45:29.444Z`) — price 1162.10, RSI 68.9
- Entry: 2026-08-07 09:15:29 IST (`2026-08-07T03:45:29.446Z`) — close 1100.40
- Data ends: 2026-08-07 15:15:29 IST — last price 1078.00 (still open, +0.35R unrealized)

**AMBUJACEM (short)**
- H1: 2026-08-03 15:15:29 IST (`2026-08-03T09:45:29.490Z`) — price 444.00, RSI 68.4
- H2: 2026-08-05 10:15:29 IST (`2026-08-05T04:45:29.444Z`) — price 449.95, RSI 67.4
- Entry: 2026-08-05 15:15:29 IST (`2026-08-05T09:45:29.509Z`) — close 443.00
- Data ends: 2026-08-07 15:15:29 IST — last price 434.00 (still open, +1.16R unrealized)

**APLAPOLLO (short)**
- H1: 2026-07-30 14:15:29 IST (`2026-07-30T08:45:29.551Z`) — price 1894.30, RSI 94.1
- H2: 2026-08-06 09:15:29 IST (`2026-08-06T03:45:29.479Z`) — price 1991.60, RSI 77.2
- Entry: 2026-08-06 14:15:29 IST (`2026-08-06T08:45:29.462Z`) — close 1956.00
- Data ends: 2026-08-07 15:15:29 IST — last price 1970.00 (still open, -0.35R unrealized)

**AMBER (short)**
- H1: 2026-08-03 09:15:29 IST (`2026-08-03T03:45:29.469Z`) — price 7510.50, RSI 66.0
- H2: 2026-08-05 13:15:29 IST (`2026-08-05T07:45:29.463Z`) — price 7532.50, RSI 61.0
- Entry: 2026-08-07 09:15:29 IST (`2026-08-07T03:45:29.446Z`) — close 7389.00
- Exit (stop hit): 2026-08-07 10:15:29 IST (`2026-08-07T04:45:29.662Z`) — price 7543.98, -1.00R

A note on APLAPOLLO's H1: it sits a week before H2 (2026-07-30 vs
2026-08-06), spanning almost the entire 9-day data window on its own — a
reminder of how little data this actually is. A "regular divergence" that
needs a full week just to find its first pivot is not a signal generator
you can expect to fire often. H1 RSI across the four signals ranges 66.0
(AMBER) to 94.1 (APLAPOLLO) — two of the four (BAJFINANCE 84.1, APLAPOLLO
94.1) are solidly overbought by the conventional 70 threshold, the other
two are not, so this data doesn't support a claim that the rule only fires
from overbought extremes.

**Every single signal across both universes was a short.** With five
signals total, that is far too few to say whether the RSI-divergence rule
has a real short bias, or whether nine days of an up-trending market just
happened to produce more "higher high, weaker RSI" setups than "lower low,
stronger RSI" ones. Worth watching once more data exists, not worth
theorizing about yet.

## A genuine finding: this script leaks memory on the production host

Not a strategy finding — an operational one, surfaced while trying to run
the full 209-symbol universe.

The production EC2 host is memory-tight: 3.8GB total RAM, running
`option-decode-api`, `option-decode-worker`, `option-decode-web`, MySQL, and
Redis. Running this backtest script against the full universe in a single
process caused resident memory to grow rapidly and non-linearly:

- First attempt (one bulk query for all 209 symbols): OOM-killed by the
  kernel at 1.5GB resident.
- Second attempt (rewritten to query one symbol at a time, expecting this
  to *cap* memory use to whatever one symbol's ticks take): OOM-killed
  again, at 3.1GB, then again at 2.6GB — **worse**, not better, despite
  each query handling only ~3,300 rows.
- Applying the `LD_PRELOAD=libjemalloc.so.2` fix already in use for the
  worker's own memory-growth issue (see `CLAUDE.md`'s "Worker memory
  growth" section) made no difference — ruling out the glibc
  page-hoarding pattern documented there as the cause here.
- Splitting the run into small batches (30 symbols per process invocation)
  worked for the first batch (30 symbols, clean run, memory released back
  to the OS on exit). The **second** batch (symbols 30–75) reached 2.37GB
  resident after only 45 symbols and ~34 seconds, well on its way to
  another OOM — that batch was killed manually before it could threaten
  production.
- Row counts per symbol are uniform (~3,313 rows each, confirmed via direct
  SQL) — this rules out a data-skew explanation (e.g. one symbol with
  abnormally large history).

**No production service was affected** — `option-decode-api/worker/web`
stayed active through all of this, confirmed after every incident via
`systemctl is-active` and by checking `dmesg` for which process the kernel
actually killed (always the script, `node ... backtest-divergence-1h.ts`,
never a production unit). But it was close enough — available memory hit
~104MB with 2GB+ already in swap during the second batch — that this is
worth fixing before anyone runs this script again, not filed away as a
curiosity. The growth pattern (worse with *more*, smaller queries than with
one big query) points at something in the Prisma `PrismaMariaDb` driver
adapter's pure-JS query path accumulating state across repeated
`findMany` calls in one process, rather than anything about this script's
own data structures — but that is a hypothesis, not a confirmed root cause.
Whoever runs the full-universe backtest next should either investigate that
properly first, or keep using small batches (`MODE=full`, `BATCH_START`,
`BATCH_SIZE` CLI args already exist in the script for this) with each batch
as its own process invocation and a memory check between batches.

## What this backtest cannot tell you yet

- Whether RSI-only regular divergence has an edge. Five signals is not a
  sample size a win rate can be computed from, let alone trusted.
- Whether the short-only skew is a real property of the signal or an
  artifact of nine days in one market regime.
- Anything about the ~179 symbols not yet scored in the full universe.
- Whether entry-on-confirmation, the 0.25×ATR stop, or the 2R target are
  good choices — they were picked to produce a number, not validated
  against alternatives. The plan's own open questions on entry timing,
  stop, and target are still open.

## Suggested next step

Not "run it again" — the data ceiling is the actual blocker, not this
script. Two independent things would need to happen before a second
backtest would say anything more than this one did:

1. **More days of `WavePricePoint` history.** The worker is already
   capturing it continuously; this is a matter of waiting, not building
   anything.
2. **Fix or route around the memory issue above** before anyone runs the
   full 209-symbol universe again, so a future run doesn't have to be
   manually killed mid-way like this one was.

Until then, this report is what nine days and 30-of-209 symbols can
honestly say: not enough evidence, either way.

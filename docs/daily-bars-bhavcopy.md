# DailyBar — real daily OHLC from the NSE bhavcopy archive

The only source of **real** daily candles in this app. Everything else is
synthesized from 1-minute LTP ticks, which cannot express a true daily
high/low and reaches back only as far as capture has been running.

Built 2026-08-10 to unblock Layer 1 of
[`high-winrate-fno-strategy-plan.md`](high-winrate-fno-strategy-plan.md) — the
daily regime filter, which needs ~50 daily bars for an EMA50 and ADX(14).
Nine days of intraday ticks cannot produce one, and `packages/dhan` exposes no
historical-candle endpoint. Bhavcopy is free, public and **retroactive**, so a
single backfill got 2.5 years at once instead of waiting a quarter.

## Current state

| | |
|---|---|
| Rows | 132,017 |
| Symbols | 209 (the active `FnoStock` universe) |
| Trading days | 646 |
| Range | 2024-01-01 → 2026-08-07 |
| Gaps | **None** — the missing-session check reports clean |

## Scripts

Backfill or top up (idempotent — re-run freely):

```bash
pnpm --filter @option-decode/api exec dotenv -e ../../.env.local -- tsx src/scripts/ingest-nse-bhavcopy.ts --from 2024-01-01 --to 2026-08-07
```

Verify the table and compute the regime filter:

```bash
pnpm --filter @option-decode/api exec dotenv -e ../../.env.local -- tsx src/scripts/daily-regime-duckdb.ts
```

Both are DuckDB-based: DuckDB attaches MySQL directly, parses the CSVs and
writes the rows, so the files never become JS values. Only the finished
per-symbol series cross into TypeScript, where the recursive indicators (EMA,
Wilder ATR, ADX) are computed.

## The archive

Current format is **UDiFF**, one zip per trading day:

```
https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_<YYYYMMDD>_F_0000.csv.zip
```

- The legacy `cm<DD><MON><YYYY>bhav.csv.zip` layout was retired in 2024 and
  now 404s. Do not follow guides that still reference it.
- Verified available back to **2024-01-02**. 2023 dates 404.
- Requests need a browser `User-Agent` **and** an `nseindia.com` `Referer`.
  Without them the host returns an HTML error page with a **200**, which looks
  like a corrupt zip rather than a refusal — hence the `PK` magic-byte check.
- ~2,400 EQ rows per day. We keep series `EQ` and `BE` only.

## Four traps, all of which were live in this data

Each of these was found by a check that is now permanent. None would have
raised an error on its own.

### 1. The CSV sniffer silently dropped 120 trading days

Bhavcopies before ~2024-06-21 carry a **35-field header against 34-field data
rows**. DuckDB's dialect detection fails on that and parses the whole file as
a single unnamed column; `union_by_name` then contributes nothing. The
download succeeded, no error was raised, and the days simply were not there.

Fixed by pinning every parse option rather than sniffing —
`delim`, `header`, `all_varchar`, `null_padding` — and by asserting that the
number of trading days staged equals the number of files downloaded. That
assertion is the real fix; the parse options only address the instance.

### 2. NSE trades on some weekends

The Union Budget session runs on 1 February whatever day it falls on.
**2026-02-01 was a Sunday and a full live session.** A weekday-only candidate
list skipped it, and Diwali Muhurat sessions can land on a Saturday too.

The ingest now probes every calendar day; non-trading days cost one cheap 404
each. Four weekend sessions exist in this range: 2024-01-20, 2024-03-02,
2024-05-18 and 2025-02-01.

### 3. `PrvsClsgPric` is NOT restated on ex-dates

The obvious corporate-action detector — compare NSE's previous close against
our own previous row — **does not work**. Across all 131k rows the two agree
everywhere except where a session is missing. It detects gaps, not splits.

What does work is `open / previous close`, because a split gaps the **open**
itself while a genuine crash opens near the previous close and falls intraday:

| Event | prev close | open | ratio |
|---|---|---|---|
| BAJFINANCE 1:10 | 9,331.0 | 956.0 | 0.103 |
| KOTAKBANK 1:5 | 2,132.6 | 426.0 | 0.200 |
| HDFCBANK 1:2 | 1,964.1 | 979.5 | 0.499 |
| RECLTD — real −25% (2024 election result) | 604.5 | 594.0 | **0.983** |
| INDUSINDBK — real −27% (2025 accounting) | 900.5 | 810.45 | **0.900** |

25% sits in the empty band between the two populations. **43 corporate actions
across 42 symbols** are present in this range; unadjusted, each is a fake
overnight crash that flips EMA50 and spikes ADX.

Prices are stored **exactly as published**. Back-adjustment is derived at read
time as a reverse cumulative product of the factors, so the table stays
faithful to the source and the adjustment stays inspectable.

### 4. Probing every calendar day gets you rate-limited

Re-running a multi-year backfill re-probes ~300 weekends and holidays. That
burst earns a **403 on everything** — at which point a 403 is
indistinguishable from a holiday unless you already know which dates are
settled.

Two fixes: confirmed 404s are recorded in
`$TMPDIR/nse-bhavcopy-cache/non-trading-days.json` so re-runs only cost the
genuinely unknown dates, and **403 is never treated as a holiday**. Conflating
them would record real trading days as non-trading and bake a permanent hole
into the archive that no later run would retry.

## Outstanding

- Daily top-up is scripted but **not yet scheduled**:
  [`scripts/bhavcopy-daily-topup.sh`](../scripts/bhavcopy-daily-topup.sh). It
  locks (via atomic `mkdir`, since macOS has no `flock`), re-asks for the last
  10 days so a missed run heals itself, logs, and exits non-zero on real
  failure. Cron and systemd-timer entries are in its header comment; schedule
  for 20:00 IST, after NSE publishes.
  - **A 404 within the last 3 days is never cached.** NSE publishes after the
    close, so a run during market hours 404s on today — caching that would
    record today as a holiday permanently. Recent dates stay unknown and get
    retried, and an already-poisoned cache heals itself on load.
- The 2026-02-01 Budget session was recovered on the second attempt, after
  backing off 240s from the rate limit. Worth remembering the shape of that
  recovery: because 403 is recorded as *unknown* rather than as a holiday, a
  plain re-run was all it took.
- Only the F&O universe is loaded. `--all-equities` loads every EQ/BE scrip if
  a wider universe is ever wanted.

## Regime filter output

Layer 1 as of 2026-08-07, over back-adjusted prices — EMA20/EMA50 for
direction, ADX(14) ≥ 20 for trend strength, ATR(14) ≥ 1.2% so a 1R move clears
costs:

| | |
|---|---|
| Uptrend | 63 |
| Downtrend | 28 |
| Chop | 118 |
| **Passes Layer 1** | **91 of 209 (44%)** |

Computed in ~750ms across 209 symbols and 645 days. This says which stocks are
in a tradeable regime, **not** that any setup exists on them — that is Layers
2–5 of the plan, which are not built.

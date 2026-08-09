# Database engine evaluation

Question asked (2026-08-09): can a different database engine give better
performance on this EC2 configuration?

Short answer: **not by replacing MySQL.** The OLTP path is already fine and a
swap would be a large migration for no gain there. The measurable win is on the
*historical/analytical* path, where a columnar tier is 89–616x faster and 46x
smaller on this exact data. Details and measurements below.

## The hardware constraint that decides most of this

Production is a **t4g.medium**: 2 vCPU Graviton2, 3,823 MB RAM, ~1,991 MB
available, EBS-backed, and stopped/started daily by EventBridge. That single
host already runs `option-decode-api`, `option-decode-worker`,
`option-decode-web`, MySQL and Redis — and the worker has a documented memory
problem (jemalloc `LD_PRELOAD` + a 15-minute restart timer, see CLAUDE.md).

**There is no room for a second database server process.** That eliminates
ClickHouse, QuestDB and a side-by-side PostgreSQL on merit alone, before any
performance argument. Any engine change has to either replace MySQL outright or
run embedded, in-process, with a hard memory cap.

## What the data actually looks like

`OptionContractTick` is the whole story. Everything else in the schema is
rounding error.

Measured on the local mirror (which holds **82,020,434 rows**, 2026-07-01 to
2026-08-07 — more than production, per `scripts/sync-prod-db.sh`'s
append-never-delete behaviour):

| Table | Rows | On disk |
|---|---|---|
| `OptionContractTick` | 82,020,434 | **57.68 GiB** (`.ibd`, ground truth) |
| everything else combined | ~330k | < 0.1 GiB |

Production: ~46.5M rows / 27.02 GB, same shape at 30-day retention.

> **`information_schema.TABLES` lies here.** It reported 10.8M rows and 6.24 GB
> for this table against an actual 82.0M rows and 57.68 GiB — stale InnoDB
> sampling stats, off by ~9x. Read the `.ibd` file size instead.

That works out to **755 bytes/row** on local, 620 bytes/row on production, for a
row whose actual information content is about 20 numbers. The reasons are
structural:

- `id` is a **cuid in `varchar(191)` utf8mb4**, and it is the clustered PK.
  InnoDB appends that ~25-byte key to *every one of the five secondary
  indexes*.
- `snapshotId` is a second 25-byte cuid, repeated on all ~460 rows of a
  snapshot.
- `underlyingSymbol`, `expiryLabel`, `securityId` are `varchar(191)` strings
  repeated verbatim on every row.
- Three of the five secondary indexes are near-duplicate prefixes of each
  other:
  `(tradingDate, underlyingSymbol, expiryLabel, optionType, strikePrice, tickTime)`,
  `(underlyingSymbol, expiryLabel, optionType, strikePrice, tickTime)` and
  `(underlyingSymbol, expiryLabel, tradingDate, optionType, strikePrice, tickTime)`.

This is a time-series/append-only workload stored in a row-store OLTP engine,
scanned with a **128 MB buffer pool against 27 GB** (production is on the stock
default — see `docs/local-database.md`). Every historical scan is EBS-bound.

## Measurements

Four representative queries, taken from real access patterns in
`packages/db/src/market-repository.ts`. MySQL 8.4 InnoDB (128 MB pool, matching
production) versus DuckDB **deliberately throttled to 2 threads / 1 GB** to
approximate the t4g.medium.

Note the comparison is biased *in MySQL's favour*: MySQL ran unthrottled on a
10-core / 16 GB Mac, DuckDB was capped at t4g.medium-equivalent resources.

| Query | InnoDB | DuckDB (2 thr / 1 GB) | Speedup |
|---|---|---|---|
| Q1 — full chain for one `snapshotId` (~460 rows) | 47 ms | 10 ms | 4.7x |
| Q2 — one strike's whole IV series | 973 ms | 348 ms | 2.8x |
| Q3 — per-day OI aggregate, NIFTY (10.3M rows) | **38,013 ms** | 425 ms | **89x** |
| Q4 — full scan, 82M rows, 4 aggregates | **714,000 ms** (11m54s) | 1,158 ms | **616x** |

Reading straight off Parquet instead of DuckDB's native format is the same
speed: Q2 183 ms, Q3 552 ms, Q4 1,150 ms.

### Storage, same 82,020,434 rows

| Format | Size | Bytes/row | vs InnoDB |
|---|---|---|---|
| InnoDB (data + 5 indexes) | 57.68 GiB | 755 | 1x |
| DuckDB native | 4.53 GiB | 59 | **12.7x smaller** |
| **Parquet + zstd** | **1.24 GiB** | **16.2** | **46x smaller** |

Projected onto production's 46.5M rows: **27.02 GB → roughly 0.75 GB.**

Why the gap is so large: columnar dictionary-encodes the repeated
`underlyingSymbol` / `expiryLabel` / `optionType` strings to a few bits, stores
no per-row PK, needs no secondary indexes at all, and delta-encodes `tickTime`.
The 5 index copies of a 25-byte cuid simply cease to exist.

### One incidental finding worth keeping

DuckDB answered Q1 — a point lookup with *no index* — in 10 ms across 82M rows.
That works because **cuid carries a monotonic timestamp prefix**, so rows land
on disk in `snapshotId` order and min/max zonemaps prune to a single row group.
The same property means the InnoDB clustered PK is *not* randomly ordered
either; insert locality is fine. The cuid's cost here is width, not randomness.

## Engine-by-engine verdict

| Candidate | Verdict |
|---|---|
| **Tuned InnoDB** (pool 128M→512M, drop redundant indexes, narrow the PK) | **Do this first.** Cheapest action available, no migration. Won't change the *class* of Q3/Q4 — a row-store still reads every column of every row — but directly targets the 97.8% hit rate and the index bloat. |
| **DuckDB + Parquet, embedded** | **Recommended for the history tier.** Measured above. No server process, no port, no extra RSS when idle, holds inside a 1 GB cap on a 4.5 GB dataset. Reads Parquet directly, so the files stay portable to anything else later. |
| **PostgreSQL + TimescaleDB** | Genuine option, *not measured*. Compression on this shape is typically 10–20x, and it would unify OLTP + time-series in one engine. But it means changing the Prisma provider, rewriting the raw SQL, replacing the `PrismaMariaDb` driver adapter, and migrating 27 GB — a large project whose OLTP half fixes nothing that is currently slow. |
| **ClickHouse** | Best-in-class for exactly this shape, but it is another server process on a 3,823 MB host that has ~1,991 MB free and a worker with memory spikes. Ruled out by the hardware, not by capability. |
| **MyRocks / InnoDB page compression** | 2–3x space at the cost of decompress CPU on every buffer-pool miss — a poor trade on a *burstable* 2-vCPU instance. Does not address the scan cost. Not measured. |
| **QuestDB / InfluxDB** | Same second-process problem as ClickHouse, plus ecosystem cost against Prisma. |

## Bias in the above — read before trusting the numbers

Stated plainly, because the headline figures flatter one option:

- **Only one alternative was measured.** DuckDB won a race it was the sole
  entrant in. TimescaleDB and MyRocks were ruled out by argument, not by
  benchmark.
- **The InnoDB baseline was un-tuned** — 128 MB pool against 57.68 GiB. That
  matches production, so it is a fair picture of *today*, but it is not a fair
  picture of MySQL. Tuned InnoDB was never measured.
- **Q4 is a query this application never runs.** The 616x is synthetic. The two
  queries closest to real access patterns, Q1 and Q2, gave 4.7x and 2.8x — and
  the production hot path is already 4 ms warm.

So the case for a columnar tier does **not** rest on the speed headline. It
rests on the two findings below.

### The evidence that actually decides it

`docs/divergence-trading-backtest-report.md` records that the 209-symbol
divergence backtest **cannot be run on the production host at all**. It was
OOM-killed at 1.5 GB, then 3.1 GB, then 2.6 GB; `LD_PRELOAD=libjemalloc.so.2`
made no difference; available memory reached ~104 MB with 2 GB in swap. Total
data involved is ~692k rows (209 symbols x ~3,313) — trivially small.

The suspected cause recorded there is the Prisma `PrismaMariaDb` adapter's
pure-JS path accumulating state across repeated `findMany` calls. That matters
enormously for engine choice:

- **Swapping MySQL for PostgreSQL would not fix it.** Prisma and the driver
  adapter remain in the path.
- **An embedded columnar engine would.** DuckDB aggregates in-process in C++
  and returns a handful of result rows; the 692k rows never become JS objects
  at all.

The second finding is storage: at 16.2 bytes/row, retention stops being a
constraint (below).

### Why "just push the aggregation into SQL" isn't sufficient on its own

It is the cheapest fix and it has a proven track record in this repo —
`getAtmCallIvHistory` went 2,373 ms → 71 ms that way. It would likely fix the
backtest OOM too, by returning few rows instead of many.

But it does not rescue heavy analytics, because **Q3's 38 s is MySQL doing the
aggregation server-side already**. Scanning NIFTY's 10.3M rows means touching
~7.8 GB at 755 bytes/row; no buffer pool setting on a 3,823 MB host fixes that.
Only a smaller on-disk representation does. Do the SQL pushdown regardless — it
is cheap and correct — but it caps out well short.

## Recommendation

**Keep MySQL as the system of record. Do not migrate the engine.** The OLTP hot
path is not the problem — CLAUDE.md's profiling has the overview endpoint at
4 ms warm with all analytics at ~12 ms, and Q1 above confirms indexed lookups
are healthy. Replacing MySQL would be a large, risky migration aimed at the part
that already works.

Two changes worth making, in order:

1. **Tune and de-bloat InnoDB.** Raise `innodb_buffer_pool_size` 128M → 512M
   (leaves ~1.5 GB headroom; re-measure the hit rate on both sides, and respect
   CLAUDE.md's "don't over-claim from a short sample"). Resolve the pending
   index audit — three of the five secondary indexes are overlapping prefixes,
   and the accumulated `performance_schema` counters from
   `ops/scripts/capture-index-usage.sh` should say whether they earn their
   space. Dropping unused ones is the single cheapest win available.

2. **Add a columnar history tier — don't replace anything.** Roll each closed
   trading day out to Parquet, query it with embedded DuckDB from the worker
   or API. Q3 goes 38 s → 0.4 s and Q4 goes 11m54s → 1.2 s, on t4g.medium-class
   resources, with the whole history sitting in ~0.75 GB instead of 27 GB.

### The benefit that may matter more than speed

At 16 bytes/row, **production's entire 30-day retention window fits in under a
gigabyte.** CLAUDE.md notes that once a trading day ages past
`SNAPSHOT_RETENTION_DAYS=30`, the local mirror is the only copy that exists.
A Parquet tier means years of history could be retained on the EC2 host in less
space than 30 days occupies today — which changes what backtesting is possible,
not just how fast it runs.

## Reproducing this

Measurements used a DuckDB copy built straight off MySQL:

```sql
INSTALL mysql; LOAD mysql;
ATTACH 'host=127.0.0.1 port=3306 user=option_decode password=… database=option_decode' AS m (TYPE mysql, READ_ONLY);
CREATE TABLE tick AS SELECT * FROM m.OptionContractTick;
COPY (SELECT * FROM tick) TO 'tick.parquet' (FORMAT parquet, COMPRESSION zstd);
```

The load took 350 s and the Parquet export 20 s, both on 2 threads. Throttle
with `SET threads=2; SET memory_limit='1GB';` to reproduce the t4g.medium
column.

Nothing in this evaluation was applied to any database. No schema, config or
production state was changed.

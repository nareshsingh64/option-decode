# Local MySQL & Redis (native)

The local dev database and cache. **Native Homebrew services, not Docker** —
this matches how production runs them (`docs/ec2-production-deploy.md`).
Migrated off Docker on 2026-08-08; `docker-compose.yml` was deleted in that
change, so any reference to it elsewhere is stale.

Keep this file current when the local DB setup changes — it is the thing that
saves re-deriving all of the below.

## Why native, not Docker

Docker Desktop's container startup raced `pnpm dev`: the API process would
start, fail to reach a MySQL that wasn't up yet, and hang permanently without
recovering — surfacing only as "Load failed" on the login screen. Homebrew
services register with `launchd` and are already running before a terminal
opens, which removes the race rather than working around it.

## What's installed

| | Value |
|---|---|
| MySQL | `mysql@8.4` (Homebrew, keg-only), currently 8.4.11 |
| Redis | `redis` (Homebrew), currently 8.10.x |
| MySQL port | `127.0.0.1:3306` (standard — matches prod) |
| Redis port | `127.0.0.1:6379` (standard — matches prod) |
| MySQL data dir | `/opt/homebrew/var/mysql` |
| MySQL config | `/opt/homebrew/etc/my.cnf` |
| Redis config | `/opt/homebrew/etc/redis.conf` |

```bash
brew services list          # both should show "started"
brew services restart mysql@8.4
```

Ports are deliberately the standard ones, not Docker's old offset `3308`/`6380`
— production parity was the point of the migration. If another local project
ever needs its own MySQL, give *that* one the offset port.

## Two config changes that are load-bearing

Both were needed to get the stack working and are easy to lose on a reinstall:

1. **`mysql-native-password = ON`** in `/opt/homebrew/etc/my.cnf` under
   `[mysqld]`. The old Docker container passed `--mysql-native-password=ON`
   for the `mariadb` npm driver (`@prisma/adapter-mariadb`, which
   `packages/db` uses). Without it the plugin loads as `DISABLED` and
   `CREATE USER ... IDENTIFIED WITH mysql_native_password` fails outright with
   "Plugin 'mysql_native_password' is not loaded".

2. **Redis Stack `loadmodule` lines commented out** in
   `/opt/homebrew/etc/redis.conf`. Homebrew's stock config references
   `redisbloom`/`redisearch`/`redisjson`/`redistimeseries` `.so` files that
   aren't installed, and Redis **aborts on startup** rather than skipping them
   ("Can't load module ... server aborting"). This app only speaks plain Redis
   (BullMQ + a live-feed tick cache), so disabling them is correct, not a
   workaround.

## Users and grants

```
option_decode@127.0.0.1   mysql_native_password
option_decode@localhost   mysql_native_password
root@localhost            caching_sha2_password, EMPTY PASSWORD
```

Both app-user hosts exist because connections arrive as either depending on how
the driver resolves `127.0.0.1`. Grants:

```sql
GRANT ALL PRIVILEGES ON option_decode.* TO 'option_decode'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `prisma_migrate_shadow_db_%`.* TO 'option_decode'@'127.0.0.1';
```

The **shadow-db grant is required for `prisma migrate dev`**, which creates and
drops a throwaway database on every run to diff the schema. Without it
migrations fail with `P3014` / `P1010` ("denied access on the database
`prisma_migrate_shadow_db_<uuid>`"), which reads like a connection problem but
is a privilege problem. It is wildcard-scoped to Prisma's naming pattern rather
than granted globally.

`root` has no password (Homebrew default; `mysql_secure_installation` was never
run). Acceptable on a single-user dev box, but it means `mysql -u root` is
unauthenticated — don't copy this shape anywhere else.

## Env wiring

`.env.local` is what the app reads (`dotenv -e ../../.env.local`):

```env
DATABASE_URL=mysql://option_decode:option_decode@127.0.0.1:3306/option_decode
REDIS_URL=redis://127.0.0.1:6379/0
```

**There are five `.env` files carrying `DATABASE_URL`**, and they drift:
`.env.local`, `.env`, `packages/db/.env`, `apps/api/.env`, `apps/worker/.env`.
The Prisma CLI reads whichever `.env` is in scope for its working directory,
which is *not* necessarily the one the app uses — so a port change has to be
applied to all of them or `pnpm db:migrate` and the running app will disagree
about which server they're talking to. All five were updated together in the
migration.

## Production parity (compared 2026-08-08)

Compared against `dhan-ec2`'s native MySQL. Everything not listed below is
identical — `max_connections` 151, `sql_mode`, `utf8mb4` /
`utf8mb4_0900_ai_ci`, `table_open_cache` 4000, `thread_cache_size` 9,
`innodb_io_capacity` 10000, `innodb_redo_log_capacity` 100M,
`tmp_table_size` 16M, `bind-address` 127.0.0.1, and `mysql_native_password=ON`
(prod sets it in `/etc/mysql/mysql.conf.d/mysqld.cnf` — so the local flag is
matching prod, not just the old Docker container).

| | Local | Production | Status |
|---|---|---|---|
| Version | 8.4.11 (Homebrew) | 8.4.10-0ubuntu0.26.04.1 | Patch-level only |
| `time_zone` | `+00:00` (pinned) | UTC | **Fixed 2026-08-08** |
| `lower_case_table_names` | 2 | 0 | **Cannot align** |
| `innodb_flush_method` | `fsync` | `O_DIRECT` | Platform, unavoidable |
| `innodb_buffer_pool_size` | 128M | 128M | Both stock (see below) |

### The timezone divergence (fixed)

macOS resolved `time_zone=SYSTEM` to **IST**, production resolves it to
**UTC**. About 20 tables carry a DB-side `DEFAULT CURRENT_TIMESTAMP(3)`
(`User.createdAt`, `OptionChainSnapshot.createdAt`,
`DhanApiRequestLog.requestedAt`, `SimTrade.openedAt`, …), and a probe insert
confirmed local was writing them **330 minutes ahead of UTC** while prod wrote
UTC. Any row created through the DB default rather than through Prisma Client
was silently 5h30m off from production's equivalent — in a market-hours
application where session windows matter.

Fixed by pinning `default-time-zone = '+00:00'` in
`/opt/homebrew/etc/my.cnf`. **Rows written locally before 2026-08-08 may still
carry IST-stamped defaults** — dev data only, but don't trust old local
timestamps for anything comparative.

### The case-sensitivity divergence (cannot be fixed, must be respected)

`lower_case_table_names` is **2 locally** (macOS forces it — the filesystem is
case-insensitive, and MySQL refuses to start with `0` on such a volume) versus
**0 in production**. Consequence: a query naming a table with the wrong case
succeeds locally and **fails in production**.

Prisma generates correct casing, so ORM queries are safe. The exposure is raw
SQL. Today there is exactly one raw query —
`getAtmCallIvHistory` in `packages/db/src/market-repository.ts` — and it uses
correct casing (`OptionChainSnapshot`, `OptionContractTick`), as does
`packages/db/sql/market_indexes.sql`. **Any new `$queryRaw` must be
case-checked by eye; local green is not evidence.**

### Stray prod config files — inert, but note the shape

`/etc/mysql/mysql.conf.d/` holds `mysqld.cnf.bak` and
`mysqld.cnf.pre-fix-2026-07-31`. MySQL's `!includedir` only reads `*.cnf`, so
neither is loaded. This is the same near-miss as the nginx `sites-enabled`
trap in CLAUDE.md, where globbing *does* pick backups up — safe here purely
because of the extension. Don't create `mysqld-backup.cnf`.

## Current tuning: stock, and undersized

`my.cnf` carries only `bind-address`, `mysqlx-bind-address`, and the
native-password line. Everything else is Homebrew default, which means:

- **`innodb_buffer_pool_size` is 128MB against an ~11GB data directory** —
  and **production is also on the 128MB stock default, against 27.57GB**
  (`OptionContractTick` is 27.02GB / ~46.5M rows there). So this is not a
  local-only gap.

  Measured on prod 2026-08-08: buffer pool hit rate **97.8%** (11,060 disk
  reads out of 512,018 requests) — over a short window on a
  recently-restarted server, so treat it as indicative, not settled. The hot
  working set (latest snapshots) evidently fits; the misses are the historical
  scans. This is a plausible contributor to the slow query stages in CLAUDE.md's
  performance table (`getLatestOptionChainSnapshot` 766ms,
  `getAtmCallIvHistory` 2,373ms before its rewrite).

  **Do not raise it on prod without weighing the memory history.** That host is
  a t4g.medium: 3,823MB total, ~1,991MB available, and the worker already has
  a documented memory problem (jemalloc `LD_PRELOAD` mitigation + a 15-minute
  restart timer). A modest bump — 128M → 512M — would leave roughly 1.5GB
  headroom; anything larger starts competing with the worker's spikes. Test
  outside market hours and re-measure the hit rate on both sides before and
  after, per CLAUDE.md's "don't over-claim from a short sample".
- `slow_query_log` is **OFF** and `long_query_time` is the default 10s — the
  same trap noted for production: "no slow queries" is not a signal, because
  nothing is being measured. Turn it on deliberately when investigating.
- `max_connections` 151. Note this is unrelated to the app's real constraint:
  the `mariadb` driver's connection **pool** is the undocumented default of 10
  (see CLAUDE.md's performance section) — pool exhaustion happens long before
  MySQL's own limit.

## Data provenance

The database was restored from the pre-migration Docker volume
(`option-decode-dev_option_decode_mysql`) on 2026-08-08 and verified
**row-for-row across all tables** against that source before the volume was
deleted. All old `option-decode*` Docker volumes and their orphaned containers
have since been removed; Docker has no footprint for this project.

### Restoring from a mysqldump, if it's ever needed again

Two failure modes hit during that restore, both worth not rediscovering:

- **Never slice a dump file mid-way and import the fragment.** The header
  (`SET FOREIGN_KEY_CHECKS=0`, `SET TIME_ZONE='+00:00'`, `SQL_MODE`, …) is
  established once at the top and the rest of the file depends on it. Importing
  a slice without it fails on `DROP TABLE` against foreign keys
  (`ERROR 3730`) and then on `Variable 'time_zone' can't be set to NULL`
  (`ERROR 1231`). If a partial import is genuinely needed, prepend the dump's
  real first ~16 lines verbatim — don't hand-write a substitute.
- **Redirect stderr separately.** `mysqldump ... > out.sql 2>&1` writes
  mysqldump's own password warning into the SQL file as line 1, and the import
  then dies with a syntax error pointing at that warning text.

Production's own backup routine is in `docs/ec2-production-deploy.md` (needs
`--single-transaction --no-tablespaces`). For pulling prod data *down* into
this database, see the next section.

## Syncing production data down

```bash
scripts/sync-prod-db.sh --dry-run   # show the plan, touch nothing
scripts/sync-prod-db.sh             # sync whatever local is missing
```

Run it about once a week, or whenever you need current chains locally. It is
idempotent — re-running is cheap and repairs a partial previous run, so when in
doubt, just run it again.

### Local is the archive, not a copy

**Production keeps only `SNAPSHOT_RETENTION_DAYS=30` and prunes nightly.** On
2026-08-08 it held 19 trading days (2026-07-14 → 2026-08-07) and nothing older
existed anywhere. That single fact shapes the whole design: the script
**appends and never deletes**, because a "mirror prod exactly" mode would
destroy local history that cannot be re-fetched from any source. Once a day
ages out of prod's window, this laptop is the only place it exists.

The corollary is that **local will grow without bound**. At roughly 1.45 GB of
data + indexes per trading day, plan on ~30 GB per 20 trading days. There is no
local retention cap; add one deliberately if the data directory becomes a
problem.

### What the script does

Everything runs streamed — `ssh → mysqldump → zstd → mysql` with no
intermediate file, so the prod-side dump and the local import overlap and a
failure mid-run loses only the day in flight.

| Table class | Mode | Why |
|---|---|---|
| `OptionChainSnapshot`, `OptionContractTick` | `--insert-ignore`, one day at a time | The bulk. Sliced by `tradingDate` so only missing days move. |
| Reference + account state (`User`, `Plan`, `Subscription`, `FnoStock`, `SimTrade`, …) | `--replace` | Prod mutates these in place (`lastLoginAt`, subscription status), so prod should win. |
| Append-only (`PressureScore`, `WavePricePoint`, `Underlying`, `Expiry`, …) | `--insert-ignore` | Never clobber a local row — this is what preserves pruned history. |
| `_prisma_migrations` | **not synced** | Local owns its own migration state; overwriting it desynchronises `prisma migrate dev`. Preflight compares the heads instead. |

`--replace` is safe against the foreign key graph only because **every
constraint is `ON DELETE RESTRICT` with no cascades**, and `REPLACE` preserves
the primary key — so the delete-then-insert leaves children pointing at a row
that still exists. Check this again if a migration ever adds `ON DELETE
CASCADE`.

Which days to sync is decided by **comparing per-day `OptionChainSnapshot`
counts on both sides**, not by a checkpoint file — so state lives in the data
itself and cannot drift. It also means a day that was captured while the market
was still writing to it shows up as a mismatch and gets re-pulled
automatically. That was not hypothetical: the first baseline found 2026-07-22
holding 4,736 of 13,080 snapshots and 2026-08-03 holding 624 of 10,996, left
over from the partial `restore-current-expiry.sh` restore.

### Measured costs (2026-08-08)

| | |
|---|---|
| One trading day (4.04 M ticks, 2026-08-05) | **122 s end-to-end** |
| Link EC2 → this Mac | 18.2 MB/s (146 Mbit) |
| One day compressed | ~200 MB |
| Full 19-day baseline | ~2.2 GB, roughly 45–70 min |

**The wire is never the bottleneck** — 2.2 GB is about two minutes of transfer.
The cost is the dump on a 2-vCPU t4g.medium, and it is I/O bound, not CPU bound
(20 s of CPU in a 140 s dump). Per-day cost rises as the local secondary
indexes grow toward prod's 18 GB, so treat 122 s as the floor, not the average.

### Run it after market close

The script **refuses to run 09:00–15:45 IST on a weekday** unless given
`--force`. A full dump is ~30 minutes holding one `--single-transaction` read
view open; that is harmless when ingest is idle and undo-tablespace growth when
it is not, on a host with ~2 GB free and a worker that already has a documented
memory problem. The usable window is **16:00–23:30 IST**, before the
EventBridge stop at 23:55 IST.

It is deliberately **pull-initiated from the Mac rather than a cron on EC2**,
because that instance is on a start/stop schedule and is not reliably up — the
Mac can check reachability and fail cleanly instead of silently missing runs.

To make it weekly, a `launchd` agent is enough (it fires on the next wake if
the Mac was asleep):

```bash
launchctl submit -l com.option-decode.dbsync -- /Users/naresh.singh/option-decode-dev/scripts/sync-prod-db.sh
```

For a real schedule, write a `~/Library/LaunchAgents/com.option-decode.dbsync.plist`
with a `StartCalendarInterval` of Saturday 18:00 and `StandardOutPath` pointed
somewhere you will actually read.

### The buffer pool is raised only for the import

`innodb_buffer_pool_size` stays at the stock 128 MB in `my.cnf` **on purpose** —
that is the prod-parity documented above, and raising it permanently would make
local query timings useless as a signal about production. All three import
settings are dynamic on MySQL 8.4, so the script raises them and restores the
originals in an `EXIT` trap:

| | Normal | During import |
|---|---|---|
| `innodb_buffer_pool_size` | 128 M | 4 G |
| `innodb_redo_log_capacity` | 100 M | 2 G |
| `innodb_flush_log_at_trx_commit` | 1 | 2 |

If a run is killed hard enough to skip the trap, check these before drawing any
performance conclusion — a 4 G pool left behind will make local look much faster
than prod for reasons that have nothing to do with the code.

### What happens when the connection breaks

Tested, not assumed. A drop mid-day plays out like this:

1. The stream truncates mid-`INSERT` and the `mysql` client exits **1**
   (verified: a cut-off statement gives `ERROR 1064`).
2. `set -e` with `pipefail` fails that attempt — but **does not abort the
   run**; the day is retried up to `DAY_ATTEMPTS` (3) with a 40 s / 60 s
   backoff, then skipped so the remaining days still go.
3. Complete statements that arrived before the cut **stay committed** — this
   is fine, because `--insert-ignore` means a retry re-sends the whole day and
   skips what is already there.
4. The `cleanup` trap restores the MySQL settings and releases the lock. It
   runs on SIGTERM too, so a `launchd` shutdown mid-run is clean.
5. Anything still missing is repaired by the next run's count comparison.

The layered timeouts matter because they catch different failures:

| Mechanism | Catches |
|---|---|
| `ConnectTimeout=15` | Host down at connect time |
| `ServerAliveInterval=30` × `6` | Peer vanished — dead in ~3 min |
| `DAY_TIMEOUT` (900 s) wall clock | **A stalled remote `mysqldump`** |

That last one is the non-obvious case: a `mysqldump` blocked on a metadata
lock keeps the TCP connection perfectly healthy, so `ServerAlive*` never fires
and without a wall-clock bound the run would block until the next scheduled
fire. macOS ships no `timeout(1)`, so it is hand-rolled — and `set -m` is
load-bearing there, because it gives the background job its own process group.
Without it `kill` reaches only the wrapping subshell and the `ssh`/`mysqldump`
children are orphaned and keep running.

The `ssh` options are set **in the script**, not taken from `~/.ssh/config`.
That file is not in the repo, and the safety net should travel with the script.

### Knowing when it silently stops working

This is the failure that actually costs data. A weekly job that fails
unattended is invisible, and past 30 days the missed trading days are gone from
production for good.

- Every run writes `~/.option-decode-last-sync` **only on full success**, and
  each run reports how long ago that was — warning past 21 days, while there is
  still margin against the 30-day cliff.
- Failures raise a desktop notification via `osascript`, and the run exits
  non-zero.
- The `launchd` log is `~/Library/Logs/option-decode-dbsync.log`.

`caffeinate -i` wraps the scheduled run so idle sleep doesn't kill a 30-minute
job. Be honest about its limit: `-i` does **not** prevent sleep from a closed
lid or an explicit Sleep. Those still end the run — survivable, since the next
run repairs it, but the week is wasted.

### The `--where` quoting trap

Slicing by day looks like it should be `--where='tradingDate=$day'`. It is
silently catastrophic: the outer single quotes close against the ones in the
value, mysqldump receives `--where=tradingDate=2026-07-14`, and **MySQL
evaluates the bare token as arithmetic** (`2026-7-14` = 2005) rather than a
date. It matches nothing, prints no warning, and exits 0. Use escaped double
quotes, which survive both shell hops and read as a string literal:

```
--where='tradingDate=\"$day\"'
```

Verification is a row-count comparison per day plus an orphan check
(`OptionContractTick` with no parent `OptionChainSnapshot`), because
mysqldump's preamble turns foreign key checks off — a tick whose snapshot never
arrived inserts happily and stays invisible. Per CLAUDE.md's standard, the
script exiting 0 is not the evidence; the counts matching is.

### It brings real user data down

The sync includes prod's `User` table — real email addresses and password
hashes — plus `Subscription`, `PushSubscription`, and both token tables. That is
deliberate, so local login and the auth-gated `/app` routes behave exactly as
they do live. Be aware it is real PII sitting on a laptop, and that the
`MUTABLE_TABLES` list in the script is where to trim it if that changes.

## First-time setup

See `docs/getting-started.md` — it carries the install + `CREATE DATABASE` /
`CREATE USER` / `GRANT` sequence for a fresh machine.

## Diagnostics

```bash
scripts/diagnose-performance.sh
```

Rewritten for native MySQL in the same migration (it was entirely
`docker compose exec`-based and would now fail outright). It talks to
`127.0.0.1:3306` directly. It reports no api/worker logs, because locally those
run in the foreground of your `pnpm dev` terminal — there is no log file to
tail, unlike production's `/opt/option-decode-native/logs/`.

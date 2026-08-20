# Maintenance weekend — Sat 22 / Sun 23 Aug 2026

First monthly maintenance weekend under `docs/operations-schedule.md`. Read
that file's "Constraints" section first.

Everything here is backlog that could not be done safely on a weekday. Nothing
in it is urgent enough to justify a weekday window — which is the point.

## Before starting

**Naresh:** start instance `i-09354330ecf68b4f9` (ap-south-1) around 09:00 IST
Saturday. Nothing else is needed up front; the EventBridge stop rule does not
fire at weekends, so the box stays up until stopped manually.

Note the box will boot into its normal startup: services start, and BullMQ
will replay the missed retention cron. **Stopping the worker is the first
action** for exactly that reason.

## Saturday 22 Aug — the work that needs locks

| # | task | est. | notes |
|---|---|---|---|
| 1 | Verify state; stop the worker | 5 min | `apply-index-drop.sh --stop-worker` does this itself |
| 2 | **Drop the unused index** | <1 min | 9.16 GB; the DDL measured 0.14s on a 99.5M-row copy |
| 3 | **Raise `innodb_buffer_pool_size`** | 15 min | currently the 128 MB default against a 57.8 GB table; needs a MySQL restart |
| 4 | **Measure the new delete rate** | 15 min | one timed batch — everything after this is sized from the measurement, not a guess |
| 5 | **Retention catch-up** | 2–5 hrs | ~7 days / ~23M rows overdue; duration depends entirely on step 4 |
| 6 | Verify, restart worker | 15 min | |

### 1. Index drop

```bash
ssh dhan-ec2 'sudo /opt/option-decode-native/shared/apply-index-drop.sh --stop-worker'
```

Drops `OptionContractTick_underlyingSymbol_expiryLabel_tradingDate__idx` —
0 reads across 11 boot sessions. Refuses to run if any transaction older than
30s exists, takes the lock with `lock_wait_timeout 15` so it fails fast rather
than queueing, and records the migration as applied afterwards so no future
deploy re-attempts it.

The migration is currently parked at
`/opt/option-decode-native/shared/deferred-migrations/` and removed from the
host's git checkout, so no deploy can reintroduce it into the API's
`ExecStartPre`. **Restore it into the checkout after this succeeds**, otherwise
the next `git pull` silently re-arms it.

Two sibling indexes must NOT be dropped: `[tickTime]` (179.4M reads) and
`[tradingDate, ...]` (37.2M reads, and it backs `sync-prod-db.sh`'s per-day
`mysqldump --where`). Both read zero on any single day, which is how they were
nearly lost.

### 3. Buffer pool

`innodb_buffer_pool_size` is unset in `/etc/mysql/`, so MySQL uses its 128 MB
default. Hit rate is 95.5% (14.2M physical reads against 314.7M logical) where
a healthy figure is >99%.

On a 3.8 GB host shared with api/worker/web, **512–768 MB** is the realistic
ceiling. This largely *moves* memory rather than consuming more — OS page
cache becomes InnoDB's own cache, which is far more efficient for this
workload — but confirm free memory after the restart before proceeding.

### 4. Measure before sizing step 5

Time a single retention batch at the new buffer-pool size and derive the rate.
The backlog is ~23M rows; at the old ~500 rows/sec that is 12.8 hours, which
does not fit a weekend. **Do not start step 5 until step 4 gives a number.**
If the rate has not improved enough, catch up gradually over subsequent days
instead — the daily prune only needs to run slightly ahead of intake.

### 5. Retention catch-up

Apply `SNAPSHOT_RETENTION_BATCH_SIZE=200` first, then run the prune
repeatedly. Each transaction should be ~2.7 min at the old rate and
proportionally less at the new one, so an interruption is cheap.

## Sunday 23 Aug — config, and buffer for overrun

| # | task | est. |
|---|---|---|
| 7 | Finish any Saturday overrun (esp. retention) | — |
| 8 | Apply the schedule config changes | 30 min |
| 9 | Deploy, verify | 30 min |
| 10 | Renew the Dhan token so Monday is covered | 5 min |
| 11 | Stop the instance | — |

### 8. Config changes

In `/opt/option-decode-native/shared/.env.production`:

```
SNAPSHOT_RETENTION_CRON_PATTERN=0 5 3 * * *     # 08:35 IST, was 01:30 UTC (box was off)
SNAPSHOT_RETENTION_BATCH_SIZE=200               # was 5000 (~2M rows per transaction)
```

In `/etc/cron.d/option-decode-dhan-token-renew`:

```
47 2 * * 1-5   # 08:17 IST, was 02:50 — restart now lands before the prune
2 18 * * 1-5   # 23:32 IST, was 18:05 — plus --no-restart
20 4 * * 1-5   # 09:50 IST safety net, unchanged
```

`--no-restart` needs adding to `dhan-token-renew.sh` first — the evening run
does not need a restart, since the box reboots within 18 minutes and reads the
new token at boot.

### 10. Token

Renewing on Sunday leaves Monday covered, removing that month's manual-token
step. Only works on weekends the box runs.

## Naresh's AWS console changes

Not automatable — the instance role has no EventBridge permissions.

| rule | from | to |
|---|---|---|
| stop | 18:15 UTC | **18:20 UTC** (23:50 IST) |
| start | 02:45 UTC | unchanged |

## Explicitly NOT doing this weekend

**`OPTIMIZE TABLE` on `OptionContractTick`.** Dropping an index returns pages
to the tablespace free list, not to the filesystem, so the `.ibd` stays at
57.8 GB. Reclaiming it means rebuilding 91M rows with ~20 GB of temp space
against 53 GB free. Disk is at 64% and retention will reuse the freed pages
anyway. Revisit only if disk becomes a real constraint.

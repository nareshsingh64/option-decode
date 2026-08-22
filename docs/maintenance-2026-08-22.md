# Maintenance weekend — Sat 22 / Sun 23 Aug 2026

First monthly maintenance weekend under `docs/operations-schedule.md`. Read
that file's "Constraints" section first.

Everything here is backlog that could not be done safely on a weekday. Nothing
in it is urgent enough to justify a weekday window — which is the point.

## How it runs

**Unattended.** `ops/scripts/maintenance-weekend.sh` drives the whole Saturday
sequence and emails after every step. Started 2026-08-22 09:15 IST.

```bash
sudo /opt/option-decode/ops/scripts/maintenance-weekend.sh --status
sudo tail -f /opt/option-decode-native/logs/maintenance-weekend.log
```

The instance starts and stops on its own — `option-decode-maint-start-20260822`
and `-20260823` at 09:00 (both self-deleting), `option-decode-weekend-stop` at
18:00. Nothing manual is needed at either end.

## Saturday 22 Aug — the work that needs locks

| # | task | est. | notes |
|---|---|---|---|
| 1 | Stop the worker, wait for the lock to clear | 5–15 min | see the boot-prune note below |
| 2 | **Drop the unused index** | <1 min | 9.16 GB; the DDL measured 0.14s on a 99.5M-row copy |
| 3 | **Raise `innodb_buffer_pool_size`** | 15 min | 128 MB default against a 57.8 GB table; auto-rollback if MySQL does not return |
| 4 | **Measure the delete rate** | 15 min | the gate — everything after is sized from this |
| 5 | **Retention catch-up** | to 17:00 | 72,844 snapshots overdue |
| 6 | Verify, restart the worker | 15 min | |

### The prune is already running when the box boots

Measured on the day: seven minutes after the 09:00 start, a retention prune was
at **152,922 rows and growing ~22k/minute**, replayed by BullMQ as a missed
cron. It holds the metadata lock the index drop needs.

Two things about killing it that are not obvious:

- **Stopping the worker is not enough.** MySQL keeps executing the DELETE
  server-side; it does not notice the dead client mid-statement. The thread has
  to be killed explicitly.
- **Speed matters more than care here.** The rollback cost is proportional to
  what has accumulated. Killed at 190k it took ~7 minutes; on 2026-08-20 the
  same transaction reached 850k and took **three hours**, saturating the host.

### 5. Retention catch-up

The backlog is 72,844 snapshots, roughly 29M ticks. At the pre-tuning rate of
~500 rows/sec that is over twelve hours and would not fit the weekend, which is
why step 4 gates it. The driver deletes in batches of 100 snapshots (~40k rows)
so an interruption costs minutes, and stops at 17:00 regardless of progress.

## Sunday 23 Aug — config, and buffer for overrun

Run the same driver — it resumes from `shared/maint-state` rather than
redoing completed steps.

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

`--no-restart` is already in `dhan-token-renew.sh` (2026-08-20), and the
weekend entry `0 12 * * 6,0` is already installed — so the token renews itself
at 17:30 today and tomorrow whether or not anything else gets done.

### 10. Token

Automatic. The `0 12 * * 6,0` cron renews at 17:30 both days with
`--no-restart`, so Sunday's run carries a full-life token into Monday and
**there is no manual token to paste this week**. It only fires on weekends the
box is actually running, so it costs nothing on the other three.

## AWS console — done 2026-08-20

Not automatable from the host; the instance role has S3-backup permissions
only. All five schedules are live:

| schedule | cron (Asia/Calcutta) | |
|---|---|---|
| `option-decode-start` | `15 8 ? * MON-FRI` | unchanged |
| `option-decode-stop` | `50 23 ? * MON-FRI` | moved from 23:45 |
| `option-decode-weekend-stop` | `0 18 ? * SAT,SUN` | new safety net |
| `option-decode-maint-start-20260822` | one-time, self-deleting | 09:00 Sat |
| `option-decode-maint-start-20260823` | one-time, self-deleting | 09:00 Sun |

## Explicitly NOT doing this weekend

**`OPTIMIZE TABLE` on `OptionContractTick`.** Dropping an index returns pages
to the tablespace free list, not to the filesystem, so the `.ibd` stays at
57.8 GB. Reclaiming it means rebuilding 91M rows with ~20 GB of temp space
against 53 GB free. Disk is at 64% and retention will reuse the freed pages
anyway. Revisit only if disk becomes a real constraint.

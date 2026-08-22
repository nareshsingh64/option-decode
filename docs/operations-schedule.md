# Operations schedule

The production host runs on a fixed weekday window with a monthly weekend
maintenance session. This file is the single reference for what runs when, and
— more importantly — for the constraints that make certain times unusable.

Decided 2026-08-20 after two failed maintenance attempts, both caused by
constraints nobody had written down.

## The cost model that chose this shape

Instance `i-09354330ecf68b4f9`, `t4g.medium`, `ap-south-1`.

| option | instance hrs/mo | monthly | annual |
|---|---|---|---|
| 24/7 | 730 | $178.14 | $2,137.68 |
| 16 hrs x 5 days | 348 | $97.16 | $1,165.92 |
| **weekday window + monthly weekend** | **345** | **$96.55** | **$1,158.60** |

At $0.212/hr instance, $0.67/day storage, $3.00/mo VPC; 30.42 days and 21.75
weekdays per average month.

Two things this math settled:

- **The monthly maintenance weekend is free.** It costs ~$1.70 of instance
  time and lands the option *below* a flat 16x5 schedule. There is no cost
  argument for skipping it, and a strong reliability argument for keeping it.
- **~$23.38/month is fixed** (storage + VPC) and does not scale with runtime.
  Savings only ever come out of the instance hours, so the floor is not zero.

The one remaining lever is **MCX**: it extends the day from ~7.75h to 15.5h,
i.e. half the compute (~$37/month). It supplies roughly a quarter of wave
alerts and 7 of 45 sim trades, so it is a coverage decision, not an obvious
cut.

> Verify $0.212/hr against the actual bill. It is well above the published
> on-demand rate for `t4g.medium`, so it may be blended with storage or data
> transfer. If the true instance rate is lower, the absolute savings shrink
> but the ranking of the options does not change.

## Weekday schedule (Mon–Fri)

| IST | UTC | What | Owner |
|---|---|---|---|
| 08:15 | 02:45 | Instance start (`option-decode-start`, `15 8 ? * MON-FRI`) | EventBridge |
| 08:15 | 02:45 | `[EC2 START]` email — services, memory, swap, disk | systemd |
| 08:17 | 02:47 | Dhan token renewal — restarts api + worker | cron |
| 08:35 | 03:05 | Retention prune begins | BullMQ |
| 09:00 | 03:30 | MCX opens | — |
| 09:14 | 03:44 | NSE opens | — |
| 09:45 | 04:15 | Worker memory report | cron |
| 09:50 | 04:20 | Memory alert + token safety-net (`--threshold-hours 14`) | cron |
| 15:41 | 10:11 | NSE closes | — |
| 15:45 | 10:15 | Sim EOD mark (NSE) | BullMQ |
| 23:30 | 18:00 | MCX closes | — |
| 23:32 | 18:02 | Dhan token renewal, `--no-restart` | cron |
| 23:40 | 18:10 | Sim EOD mark (MCX) | BullMQ |
| 23:50 | 18:20 | `[EC2 STOP]` email — includes an MCX-settlement check | systemd |
| 23:50 | 18:20 | Instance stop (`option-decode-stop`, `50 23 ? * MON-FRI`) | EventBridge |

### Why these exact times

**08:17, not 08:20.** The renewal restarts api and worker. It used to fire
five minutes *after* the retention prune began, killing it mid-transaction
every single weekday — see below. It now runs before the prune starts.

**08:35 for the prune**, so the renewal's restart has already happened.

**23:32 with `--no-restart`.** The evening renewal previously ran at 23:35 and
restarted services three minutes before the 23:40 MCX settlement pass. The
restart buys nothing in the evening: the box reboots in 18 minutes and reads
the new token at boot anyway.

**23:50 stop, not 23:45.** Measured from `journalctl --list-boots`,
`poweroff.target` was being reached at 18:15:34 UTC every day, leaving the
23:40 settlement pass a five-minute margin rather than the fifteen the docs
claimed.

## Monthly maintenance weekend

**Saturday + Sunday, once a month.** The instance is **started manually**; the
EC2 instance role has S3-backup permissions only, so it cannot schedule itself.
Shutdown is automatic — `option-decode-weekend-stop` (`0 18 ? * SAT,SUN`,
Asia/Calcutta) stops the box at 18:00 IST every Saturday and Sunday. On
non-maintenance weekends the box is already off and that fires harmlessly; its
purpose is that a maintenance weekend can never leave the instance running. This is the only window with no market, no ingest, no token-renewal
collision and no shutdown deadline.

Saturday is for work that holds locks or needs a MySQL restart. Sunday is the
buffer — for anything that overran, plus verification.

### The work runs itself: `ops/scripts/maintenance-weekend.sh`

Nobody sits with it. The driver runs the whole six-step sequence unattended and
emails after **every** step, so silence never means "quietly broken".

```bash
sudo /opt/option-decode/ops/scripts/maintenance-weekend.sh          # run / resume
sudo /opt/option-decode/ops/scripts/maintenance-weekend.sh --status # progress only
sudo /opt/option-decode/ops/scripts/maintenance-weekend.sh --from 3 # force a step
```

| step | what | subject |
|---|---|---|
| 1 | stop the worker, wait for the lock to clear | `[MAINT 1/6]` |
| 2 | drop the dead index, record the migration as applied | `[MAINT 2/6]` |
| 3 | raise the buffer pool, restart MySQL | `[MAINT 3/6]` |
| 4 | time one delete batch | `[MAINT 4/6]` |
| 5 | retention catch-up | `[MAINT 5/6]` |
| 6 | verify, restart the worker | `[MAINT 6/6]` |

Four properties are load-bearing rather than convenience, and each one exists
because of a specific failure:

- **A hard 17:00 cutoff.** The token renewal fires 17:30 and the box powers off
  at 18:00. Nothing may be in flight when either happens — that collision is
  what produced the three-hour rollback on 2026-08-20. Long steps check the
  clock and stop cleanly rather than being interrupted.
- **Auto-rollback on the MySQL restart.** It is the only step that can leave the
  host with no database. If MySQL does not answer within 60s the previous
  config is restored and MySQL restarted again, and the mail says `ROLLED BACK`
  rather than the run simply dying.
- **The step-4 threshold is a rule, not a judgement call**, because the point
  of the driver is that nobody is watching: at or above 1,500 rows/sec it runs
  the full catch-up; between 500 and 1,500 it works to the cutoff and carries
  the rest to Sunday; **below 500 it stops and reports**. Grinding at a rate
  that low is exactly what produced Thursday's rollback.
- **Resumable.** Progress is recorded per step in
  `shared/maint-state`, so Sunday continues rather than redoing work.

### Two bugs the first run hit, both in the measurement rather than the database

Recorded because each failed *silently* and the second is a general trap.

**`date +%s%3N` yields 19 digits on this host, not 13.** `%3N` is not truncated
to milliseconds, so it appends full nanoseconds and every duration computed
from it is nonsense. Time long steps in whole seconds instead; the precision
was never needed.

**`group_concat_max_len` is 1024, and GROUP_CONCAT truncates without
warning.** The batch's id list was built with `GROUP_CONCAT` and needs ~2,700
characters for 100 cuids, so it was cut mid-id. A truncated `IN` list is still
valid SQL — it simply matches nothing. Every batch deleted zero rows and no
error was raised anywhere. Select batches with a **derived subquery**, which
has no length limit:

```sql
DELETE FROM OptionContractTick WHERE snapshotId IN (
  SELECT id FROM (
    SELECT id FROM OptionChainSnapshot
    WHERE tradingDate < DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    ORDER BY tradingDate LIMIT 100
  ) t
);
```

Delete the parent **last** so the child statements see the same batch.

**The lesson is not either bug — it is that the guard could not tell.** Both
faults surfaced as `0 rows/sec`, which tripped the below-threshold rule and
stopped the run with an email saying the database was too slow. It was not:
the driver was measuring nothing. A threshold is only ever as trustworthy as
the measurement feeding it, so the driver now aborts explicitly when a timing
batch deletes zero rows rather than treating zero as a legitimate rate.

### `.env.production` cannot be sourced by bash

Line 31 is

```
EMAIL_FROM=Option Decode <support@pytrade.co.in>
```

unquoted, so `set -a; . ./.env.production` reads `<` as a redirection, aborts
the source at that line, and **every variable defined after it — including
`DATABASE_URL` — is silently left unset**. The shell prints one error and
carries on, so a script that does not check ends up running Prisma with no
datasource.

That is how the first run dropped the index but failed to record the migration:
`prisma migrate resolve --applied` died on a validation error nobody read. An
unrecorded migration is worse than it sounds — the next deploy re-attempts the
DROP in the API's `ExecStartPre`, the index is already gone, and the API does
not start.

Grep the one value out instead of sourcing the file:

```bash
export DATABASE_URL=$(grep -m1 "^DATABASE_URL=" ./.env.production | cut -d= -f2-)
```

The driver now does this and verifies afterwards that
`_prisma_migrations` actually has the row, emailing `CHECK NEEDED` if not.

**Expect the prune to be running when the box comes up.** The retention cron is
still at a time the box is off, so BullMQ replays it as a missed job at worker
startup — measured 2026-08-22: 152k rows and growing ~22k/minute seven minutes
after boot. Step 1 handles it, but note that MySQL keeps executing the DELETE
server-side after the worker stops; it does not notice the dead client
mid-statement, so the thread has to be killed explicitly. Catching it at 190k
rather than 850k was the difference between a seven-minute rollback and a
three-hour one.

**The Dhan token renews itself on a maintenance weekend.** A cron entry at
12:00 UTC (17:30 IST) on Sat and Sun — thirty minutes before the weekend stop
— renews with `--no-restart`. It can only fire when the instance happens to be
running at 17:30 on a weekend, i.e. on a maintenance weekend, so it costs
nothing on the other three. Renewing then carries a full-life token into
Monday and **removes that month's manual-token step**. Ordinary weekends still
need a token generated by hand at web.dhan.co on Sunday evening.

`--no-restart` is not optional there. The maintenance window is exactly when
long database work is in flight, and a restart mid-transaction is the failure
this whole reorganisation exists to prevent.

## Why retention had never once completed

Three misconfigurations compounding. All three are fixed by config, not code.

**1. The cron fired while the box was off.**
`SNAPSHOT_RETENTION_CRON_PATTERN=0 30 1 * * *` is 01:30 UTC; the box boots at
02:45 UTC. So the job was always a *missed* cron that BullMQ replayed at worker
startup. "It runs at boot" was a side effect, not a design.

**2. The batch was enormous.** `SNAPSHOT_RETENTION_BATCH_SIZE=5000` — and the
batch unit is *snapshots*, each carrying ~400 ticks. One transaction therefore
deleted **~2 million rows**. At the observed ~500 rows/sec that is over an
hour per transaction.

**3. The token renewal killed it five minutes in**, every weekday.

Net effect measured 2026-08-20: a transaction 30+ minutes old holding a
metadata lock on `OptionContractTick`, then a **3-hour rollback** that undid
850k row deletions, 221 GB read and 437 GB written, with iowait at 79%.
Retention sat **7 days past** its 30-day window.

The lock is also what took the API down that morning — the pending index-drop
DDL queued behind it, and because migrations run in the API's `ExecStartPre`,
the API could not start at all.

**A DDL that can block indefinitely must never gate a service start.** That is
the durable lesson; the choice of window is secondary.

### Fixes

| setting | from | to | why |
|---|---|---|---|
| `SNAPSHOT_RETENTION_CRON_PATTERN` | `0 30 1 * * *` | `0 5 3 * * *` | 03:05 UTC = 08:35 IST, a time the box is actually up |
| `SNAPSHOT_RETENTION_BATCH_SIZE` | 5000 | 200 | ~80k rows / ~2.7 min per transaction, so an interruption costs minutes not hours |
| token renewal (morning) | 02:50 UTC | 02:47 UTC | restart lands before the prune, not during |
| token renewal (evening) | 18:05 UTC | 18:02 UTC + `--no-restart` | clears the 23:40 settlement pass |
| EventBridge stop | 18:15 UTC | 18:20 UTC | settlement gets 10 minutes, not 5 |

With the 50-batch loop cap, 200 x 50 = 10,000 snapshots per run — roughly one
day's intake, so it keeps pace once the backlog is cleared.

## Constraints — check these before scheduling anything

Two maintenance attempts have already been lost to constraints that were not
written down. Both times the work itself took under a second.

| avoid | when | why |
|---|---|---|
| boot-time retention prune | 08:15 IST + up to several hours | holds a metadata lock on `OptionContractTick` |
| Dhan token renewal | 02:47 / 04:20 / 18:02 UTC | restarts api+worker; a 200 from RenewToken kills the old token instantly |
| market hours | 09:00–23:30 IST | MCX opens before NSE and closes long after |
| host shutdown | 23:50 IST | a build started too late is cut off |

The box is **Mon–Fri only** (verified from `journalctl --list-boots`; the only
weekend entries are short manual starts). So the genuinely clean window is a
manually started weekend.

## Division of responsibility

**AWS console (not automatable from the host)** — the instance role
`OptionDecodeEc2S3BackupRole` has no EventBridge permissions:

- the start/stop schedule rules
- starting the instance for a maintenance weekend

**On the host** — everything else: cron times, env config, migrations, DDL,
retention runs, verification.


## Verified state (2026-08-20)

Read back from the console and the host rather than assumed.

| schedule | cron (Asia/Calcutta) | target |
|---|---|---|
| `option-decode-start` | `15 8 ? * MON-FRI *` | EC2 StartInstances |
| `option-decode-stop` | `50 23 ? * MON-FRI *` | EC2 StopInstances |
| `option-decode-weekend-stop` | `0 18 ? * SAT,SUN *` | EC2 StopInstances |

All three enabled, schedule group `default`, execution role
`option-decode-scheduler-role`, instance `i-09354330ecf68b4f9`.

**`docs/ec2-production-deploy.md` said 8:55 AM / 11:55 PM IST. Both were
wrong** — a reminder that schedule times in prose drift from the thing that
actually fires. Read the console or `journalctl --list-boots`, not the doc.

Token renewal (`/etc/cron.d/option-decode-dhan-token-renew`, UTC):

```
50 2  * * 1-5   --threshold-hours 25                 08:20 IST
2  18 * * 1-5   --threshold-hours 25 --no-restart    23:32 IST
20 4  * * 1-5   --threshold-hours 14                 09:50 IST safety net
0  12 * * 6,0   --threshold-hours 25 --no-restart    17:30 IST maintenance weekends
```

Lifecycle email: `option-decode-lifecycle-alert.service`, enabled. Both paths
tested end to end on 2026-08-20 — start and stop mails delivered.

# Option Decode — working notes for Claude

Things that are true about this project and are expensive to rediscover. Read
this before touching anything; it is meant to replace the reminders the user
would otherwise have to repeat every session.

## Shape

pnpm + turbo monorepo, TypeScript throughout.

| Path | What it is |
|---|---|
| `apps/web` | Next.js 15 PWA (App Router), the trading terminal UI |
| `apps/api` | Fastify server, `/api/*`, SSE market stream |
| `apps/worker` | BullMQ worker — Dhan ingest, snapshots, alerts, wave screener |
| `packages/analytics` | Pressure, bias, alerts, Strike Matrix, Elliott Wave |
| `packages/trading` | Trade recommendations |
| `packages/db` | Prisma client + repositories (`market-repository.ts` is the big one) |
| `packages/types` | Shared types **and the few runtime constants the web app needs** |
| `packages/dhan`, `packages/utils`, `packages/config` | Feed client, helpers, env loading |

## The verification gate

Run all three before claiming anything works. Never report "done" on a build
that has not passed them:

```bash
pnpm turbo run typecheck lint test
```

For anything touching `apps/web`, also run a production build — the dev server
tolerates module-resolution problems that `next build` does not:

```bash
pnpm --filter @option-decode/web build
```

Tests are Node's own `node:test` run through `tsx` (`tsx --test`). No Jest, no
Vitest. **`apps/web` has no test script at all** — UI/builder logic there is
verified against live data (below), not unit tests. Don't claim test coverage
for it.

## Local development

- The env file is **`.env.local`**, not `.env`. Every `dev` script reads it
  (`dotenv -e ../../.env.local`). `.claude/launch.json` must point there too.
- API on **4000**, web on **3000**. Start them with the preview/launch tooling,
  never a bare `pnpm dev` in Bash.
- **MySQL and Redis run natively via Homebrew** (`brew services`), not
  Docker — matches production exactly, standard ports (MySQL `3306`, Redis
  `6379`). `docker-compose.yml` was removed; if you see a stale reference to
  it, that's the pre-migration setup. The app's MySQL user needs
  `mysql_native_password` active server-side (`/opt/homebrew/etc/my.cnf`,
  `mysql-native-password = ON`) for the `mariadb` driver, and a grant scoped
  to `` `prisma_migrate_shadow_db_%`.* `` for `prisma migrate dev`'s shadow
  database — both already set up on this machine.
  **`docs/local-database.md` is the full reference** — config, users/grants,
  the five drifting `.env` files, tuning state, and restore gotchas. Read it
  before touching the local DB; update it when the setup changes.
- **`scripts/sync-prod-db.sh` pulls production data down** for local testing
  and backtesting. It **appends and never deletes**, because prod prunes at
  `SNAPSHOT_RETENTION_DAYS=30` — once a trading day ages out there, local is
  the only copy that exists. Refuses to run during market hours (a long
  `--single-transaction` dump on a 2-vCPU box competes with live ingest);
  window is 16:00–23:30 IST. Idempotent, so re-run freely. Costs and the
  `--where` quoting trap are in `docs/local-database.md`.
- `/api/market/overview` is **not** auth-gated — curl it directly for real
  payloads. Everything behind `/app` is.
- **The app is auth-gated and Claude does not log in.** If a change needs
  visual confirmation, ask the user to sign in to the browser pane, then drive
  it from there. Don't enter credentials, and don't work around the gate.

## Production

Native systemd on a single Ubuntu EC2 host, `pytrade.co.in`, SSH alias
**`dhan-ec2`**. The `docker-compose*.yml` files in the repo are the pre-migration
setup — **production is not Docker**. Don't follow Docker runbooks against it.

Services: `option-decode-api`, `option-decode-worker`, `option-decode-web`.

Deploy is two steps — the script cannot pull, because root lacks the deploy key:

```bash
ssh dhan-ec2 'cd /opt/option-decode && git pull'
```

```bash
ssh dhan-ec2 'sudo bash /opt/option-decode/ops/native-migration/native-deploy.sh'
```

Releases land in `/opt/option-decode-native/releases/<sha>` with a `current`
symlink; rollback is flipping the symlink and restarting the three units (the
script prints the exact command). Env lives in
`/opt/option-decode-native/shared/.env.production`.

MySQL: database name is **`option_decode`**. `$MYSQL_DATABASE` is **not set** on
that host — `sudo mysql "$MYSQL_DATABASE"` fails with "No database selected".
Always name it: `sudo mysql option_decode -e "..."`.

Prisma uses the **driver adapter** (`PrismaMariaDb`, pure JS) with
`engineType = "client"` — there is no Rust query engine in a release. Don't
diagnose against one.

### Edge and TLS — Cloudflare is gone (2026-08-05)

Nameservers moved from Cloudflare to **GoDaddy** (`ns57/ns58.domaincontrol.com`).
There is **no proxy in front of the origin any more**: DNS resolves straight to
the EC2 elastic IP `13.127.247.201`, and nginx on that host terminates TLS
itself with a **Let's Encrypt** certificate (`certbot --nginx`, auto-renewing
via `certbot.timer`, renewal dry-run verified). The old self-signed cert at
`/etc/nginx/certs/selfsigned.crt` is no longer served for these hostnames.

Consequences worth knowing before diagnosing anything edge-related:

- A `curl` to `https://pytrade.co.in` now returns the **real response**. An
  earlier version of this file said a 403 was Cloudflare's bot challenge and
  could be ignored — that is no longer true, and a 403 today means something
  is genuinely wrong.
- No Cloudflare DDoS filtering or CDN caching, and the origin IP is public.
  nginx's own bot-blocking `location` rules in
  `/etc/nginx/sites-enabled/option-decode` are the only filter now.
- **Never write backup files into `/etc/nginx/sites-enabled/`** — nginx globs
  that directory, so a `.bak` loads as a second config and `nginx -t` fails on
  duplicate directives. Keep them somewhere else entirely.
- If the site is unreachable, check the apex A record first. GoDaddy's zone
  defaults to parking IPs (`3.33.130.190` / `15.197.148.33`,
  `awsglobalaccelerator.com`), and enabling domain Forwarding silently
  re-adds them.
- Your own resolver cache will lie to you after a DNS change. `dig @1.1.1.1`
  bypasses it; `curl` does not. Use `curl --resolve host:443:13.127.247.201`
  to test the origin deliberately.

### Transactional email

Sends via **GoDaddy SMTP** (`smtpout.secureserver.net:465`, implicit SSL, so
`SMTP_SECURE=true`) authenticating as `support@pytrade.co.in`, which is also
`EMAIL_FROM`. The mailbox password is an ordinary password — no App Password,
no OAuth. `deliverSmtpEmail`'s `secure: true` branch handles 465 correctly
(`tls.connect` does emit `connect`, which is what it waits on).

This combination passes DMARC, which matters: the domain publishes
`p=quarantine`, and SPF is `v=spf1 include:secureserver.net -all`. Because the
envelope sender and the From header are both `@pytrade.co.in` and GoDaddy is
SPF-authorised, alignment holds. **Any new sender must be added to that SPF
record first** — the `-all` is a hard fail, so e.g. SES mail would be
quarantined until `include:amazonses.com` is added.

Inbound mail for the domain is GoDaddy's (`MX smtp.secureserver.net`), not the
Cloudflare Email Routing that used to forward to Outlook.

### Dhan access tokens live 24 hours, and the weekend cannot be automated

There is no long-lived credential. The 12-month "API key & secret" only MINTS
a token, and minting needs an interactive browser login with 2FA every time.
The one automatable path is `GET /v2/RenewToken`, which extends an **active**
token by another 24h. `ops/scripts/dhan-token-renew.sh` does that; cron is
`ops/cron/option-decode-dhan-token-renew`, installed by `native-deploy.sh`.

The endpoint's contract was established by probing production, and the docs
are wrong or ambiguous on both halves — **do not "correct" it from them**:

```
GET  https://api.dhan.co/v2/RenewToken
headers: access-token, dhanClientId          <- NOT client-id
200 body: {"createTime":..., "expiryTime":..., "token":"<JWT>"}
```

POST returns 400 DH-905. `client-id` — the header every *other* Dhan call in
this app uses — also fails. The response field is `token`, not `accessToken`.

**The call is destructive: a 200 kills the old token immediately.** Hence the
script validates the new one against `/v2/fundlimit` *before* persisting,
backs up and writes atomically, and logs the response body untruncated on the
failure path — a JWT is ~300 chars, and truncating there could destroy the
only copy in existence. That is not hypothetical: the first probe run consumed
a live token and it was recovered by pasting from the log.

**Renewal runs at 08:20 and 23:35 IST, Mon–Fri — not every 12 hours.** The
times are pinned to the EC2 window (08:15 boot, 23:55 shutdown), not to a
clock. 23:35 is 20 minutes before shutdown specifically so a full-life token
goes into the overnight gap; a literal 12-hourly cadence would put one run in
the middle of the night when the box is off, and it would simply never fire.
Both runs pass `--threshold-hours 25` so they renew unconditionally.

**Monday morning always needs a manual token, and no cron can fix that.**
Friday's 23:35 renewal produces a token good until Saturday 23:35; the box is
off from Friday 23:55 to Monday 08:15, which is 56 hours against a 24-hour
token. An expired token cannot be renewed, only regenerated at web.dhan.co.
The post-boot run is written to fail loudly with `MANUAL ACTION REQUIRED`
rather than leave a wall of 401s. A Sunday-evening paste covers Monday and
lets cron carry the rest of the week.

A token is only renewable if it was minted from Dhan Web: `tokenConsumerType`
`SELF` and an empty `partnerId`. The script's preflight refuses a partner
token rather than burning it to find out.

**A 5xx from Dhan is not a token problem, and the script must not treat it as
one.** This cost real time twice. On 2026-08-17 RenewToken returned 200 and
the *verification* call answered 502; the script discarded a brand-new token
the old one had already been spent to obtain, and Monday needed a manual
regeneration for nothing. On 2026-08-18 RenewToken itself answered 502, the
existing token was untouched and stayed valid another 15 hours, and it was
still reported as FAILED.

Both are now handled by the same principle: **decide what a failure MEANS
before reacting to it.**

- **After RenewToken returns 200 the calculus inverts.** The old token is dead
  from that moment, so the new one is the only credential in existence and
  DISCARDING it is the destructive act. A 5xx or timeout on the verify call is
  retried, then the token is persisted anyway and reported as
  `SUCCESS (UNVERIFIED)`. Only a 4xx is a real rejection — and even then the
  token is written to the log rather than lost.
- **A 5xx on RenewToken itself is genuinely ambiguous**, and the ambiguity is
  resolved rather than guessed. It usually means the request never arrived, so
  the old token is fine and retrying is free — but it can mean the service
  processed the call and the reply was lost, in which case the old token is
  already dead and a new one exists that nobody received. So after a 5xx the
  script probes the OLD token against `/v2/fundlimit`: still authenticates ⇒
  the renewal did not happen ⇒ retry (3 attempts). Does not ⇒ the renewal DID
  happen ⇒ `MANUAL ACTION REQUIRED`, do not retry into a wall.
- **An unreachable Dhan with the token intact is `NO ACTION NEEDED`, not
  FAILED.** The alert says so and states the hours remaining. Alert severity
  that does not track actual severity is how a benign upstream blip gets
  investigated twice.

The preflight also proves the token is ALIVE, not merely unexpired: a JWT's
`exp` claim cannot know it was revoked server-side, and on 2026-08-17 every run
cheerfully reported "token valid, 10.98h remaining" about a credential that had
been dead since 08:20. One read-only `/v2/fundlimit` call closes that. Note the
response is judged the OPPOSITE way round there — before RenewToken the old
token is still alive, so a 4xx is real news and stops the run, while a 5xx must
NOT block a legitimate renewal.

**Schedule note.** Both 502s hit the 08:20 IST run and both 23:35 runs were
clean, which looks like a Dhan maintenance window — but the cron only ever
probes at those two times, so that is 2 observations against 2, not evidence.
The app's own Dhan calls show 5 5xx across ~127k requests over six days, and
those are market-data endpoints which may be different infrastructure from
`/v2/RenewToken`. Do not move the schedule on this without more data. A 09:50
IST run at `--threshold-hours 14` was added as a net instead: it fires only
when the 08:20 run failed to reset the clock, and exits quietly otherwise.

**Every renewal emails its outcome** (added 2026-08-16). Subject is
`[SUCCESS]` or `[FAILED]` followed by the IST timestamp — status first so it
reads in a phone notification without being opened. SUCCESS reports the expiry
*decoded from the new token* rather than assuming "24h from now", and whether
that token is itself renewable, which is what decides if the next cron run can
work at all.

- **Recipients live in `TOKEN_ALERT_EMAIL` in `.env.production`**, not in the
  repo — comma-separated for more than one. They go into a single `To` header
  rather than a loop, so one connection either delivers to all of them or
  fails as a unit; a loop lets the second address fail silently after the
  first has gone out. A missing value logs and carries on: no alert address
  should ever be the reason a renewal fails.
- **It sends through the app's own GoDaddy mailbox, and that is load-bearing**
  — see the transactional-email section above. `p=quarantine` plus a hard-fail
  `-all` SPF means any other sender is quarantined until the DNS record
  changes.
- **The token is never in the email.** Mail is forwarded and archived, and a
  JWT sitting in an inbox is a live credential. Status, expiry and a masked
  client id only.
- **Alerting hangs off `die()`**, not repeated at each exit, so every failure
  path is covered and any added later is covered for free — including the
  Monday `MANUAL ACTION REQUIRED` case, which is the one that most needed a
  voice and was previously silent unless somebody opened the log.
- Mail is best-effort and wrapped so an SMTP outage cannot turn a good renewal
  into a non-zero exit. That failure mode ends with someone "fixing" a token
  that was never broken.
- **`--test-alert` sends a sample and exits without touching the token.** It
  exists because the only other way to see the email is to renew for real, and
  RenewToken destroys the current token the moment it returns 200 — this is
  not an endpoint you can just try.

**The API does not log to journald.** `journalctl -u option-decode-api` shows
only systemd's own lines; the application's pino output goes to
`/opt/option-decode-native/logs/api/api.log`. Reading the journal and seeing
nothing is not evidence that nothing was logged.

**Logrotate had never run in production until 2026-08-11**, and it failed
three different ways at once. Source of truth is `ops/logrotate/option-decode`
in the repo; `native-deploy.sh` now `install`s it to
`/etc/logrotate.d/option-decode` as a real **root:root 0644** file on every
deploy. It used to be a *symlink into the checkout*, which cannot work:

- **The paths were wrong.** They globbed `/opt/option-decode/logs/` (the
  pre-migration Docker checkout) while systemd writes to
  `/opt/option-decode-**native**/logs/`, so nothing matched — `api.log`
  reached 26 MB unrotated and `rotate 14` retained no history. `apps/web` was
  never listed under either path.
- **Logrotate rejects the repo file on two separate safety checks**: it
  refuses a config that is group/other-writable (git checks out `0664` under
  the default umask) *and* one not owned by uid 0 (repo files are `ubuntu`).
  Fixing only the mode leaves the ownership error, and vice versa — hence the
  copy-on-deploy rather than a symlink.
- **All three failures are invisible in normal operation.** A non-matching
  glob and both safety refusals are reported only by
  `logrotate -d /etc/logrotate.d/option-decode`. Run that after touching it;
  the deploy script now does, and warns if it stops parsing.
- **Never `sudo tee` the `/etc/logrotate.d/` path** while it is still a
  symlink anywhere: the write follows into the git checkout, and `sudo chown`
  on a symlink follows too, leaving a root-owned tracked file the next
  `git pull` cannot overwrite.

Silver lining worth knowing: because rotation never ran, `api.log` holds
unbroken history back to 30 Jul 2026, which is what made the 5-trading-day
API error-rate analysis possible at all.

Log parsing note: `api.log` interleaves pino JSON with plain-text Prisma and
pnpm output from each unit's `ExecStartPre`, so roughly **46% of its lines are
not JSON**. They carry no `statusCode`, so request-rate analysis is unaffected
— but a naive `json.loads` per line will look alarming. The Docker-era
`172.18.0.1` MySQL errors in there are historical (last seen 30 Jul 2026),
not live; `DATABASE_URL` is `127.0.0.1` now.


## Verify against live data, not fixtures

This is the standing expectation for anything that computes a number a trader
reads. A change is not done because the types check — it is done when it has
been run against a real option chain and the output was inspected.

The pattern: fetch a real payload, then run the actual functions over it.

```bash
curl -s "http://localhost:4000/api/market/overview?underlying=NIFTY" -o /tmp/ov.json
```

Then a throwaway `.mts` next to the code, run with
`pnpm --filter <pkg> exec tsx <script>`, importing the real modules with their
`.js` specifiers. **Delete the script afterwards** — don't leave temp files in
the tree.

Bugs this has caught that typechecking never would: support/resistance ranking
excluding the ATM strike; a delta band silently picking the wrong strike; a
ladder recommending a contract with 65 traded.

### Don't over-claim from a short sample

A real lesson from this repo: a metric read over two minutes was reported as a
fix, and fuller data showed the opposite. Growth that looks like a plateau over
a short window is often a step in a staircase. Before saying a change improved
something, measure the same way, over the same span, on both sides — and if a
claim turns out wrong, retract it plainly.

## Daily OHLC comes from NSE bhavcopy, not Dhan

`DailyBar` holds **real** daily candles — 209 F&O stocks, 646 trading days,
2024-01-01 onward — backfilled from the NSE UDiFF bhavcopy archive. It is the
only real OHLC in this app; everything else is synthesized from 1-minute LTP
ticks and cannot express a true daily high/low. Dhan's client has **no**
historical-candle endpoint, so this is the only way to get history without
waiting for capture to accumulate.

`docs/daily-bars-bhavcopy.md` is the full reference. The four traps that cost
real time, all now guarded by permanent checks:

- **The CSV sniffer silently drops files.** Bhavcopies before ~2024-06-21 have
  a 35-field header against 34-field data rows; DuckDB then parses the whole
  file as one column and `union_by_name` contributes nothing — no error, 120
  trading days simply absent. Parse options are pinned, and the ingest asserts
  days-staged equals files-downloaded.
- **NSE trades on some weekends.** The Union Budget session runs on 1 February
  whatever day it falls on (2026-02-01 was a Sunday). Probe every calendar day.
- **`PrvsClsgPric` is not restated on ex-dates**, so it cannot detect splits —
  it detects *missing sessions*. Splits are found on `open / previous close`,
  which separates them from genuine crashes (a split gaps the open; a crash
  opens near the previous close and falls intraday). 43 corporate actions sit
  in this range; unadjusted, each flips EMA50 and spikes ADX.
- **403 is rate limiting, not a holiday.** Recording it as a holiday would bake
  a permanent hole into the archive. Confirmed 404s are cached so re-runs stay
  cheap; 403s stay unknown and get retried.

Prices are stored exactly as published. Back-adjustment is derived at read time
in `daily-bars-duckdb-source.ts`, the single loader both the regime report and
the pullback backtest go through — deliberately one copy, since a drift in that
adjustment would surface as a strategy result rather than a data bug.

Daily top-up: `scripts/bhavcopy-daily-topup.sh`, cron-safe (atomic-`mkdir`
lock, 10-day self-healing lookback). Not scheduled yet. **A 404 within the last
3 days is never cached as a holiday** — NSE publishes after the close, so a run
during market hours 404s on today, and caching that would blank today forever.

## Strategy backtests: the pullback rule has been measured and does not work

`docs/pullback-strategy-backtest.md`. Trend Pullback Continuation over 646 days
and 209 stocks: **52.9% out-of-sample win rate (CI 45-61%), +0.008R net per
trade** across 155 holdout trades. First result here with a sample large enough
to mean anything, and it is negative. Three things worth not rediscovering:

- **Costs are 80% of the gross edge** (0.042R gross -> 0.008R net). Stop
  distance, not signal quality, is the dominant lever on anything like this.
- **Only the RSI 40-55 pullback band carries weight.** Removing it: 45.6% win
  rate, -0.095R. The ATR floor changes the trade count by zero; the ADX floor
  doubles trades for identical expectancy.
- **All the profit is 2026** (2024 -1.9R, 2025 -2.3R, 2026 +8.1R). The
  aggregate hides this completely.

Do not tune it to reach a target win rate: with two of three years negative,
any parameter set that hits 60% here is fitted to the 2026 stretch.

**A post-hoc market-bias re-test found the one stable bucket.** Gating on
market direction (NIFTY 50 EMA20/50, or breadth - they agree 89% of the time)
lifts out-of-sample expectancy 0.008R -> 0.038R. But partitioning the
*unfiltered* baseline shows the whole effect is **short trades in a falling
market**: +0.169R over 96 trades, and positive in all three years
(+0.169/+0.160/+0.178). Longs lose whether the market agrees (-0.044R) or not
(-0.185R). The surviving claim is one-sided and was found post-hoc - re-test it
pre-registered before believing it. `docs/output/stocks-bias-retest.xlsx`.

NSE **index** daily bars now live in `DailyBar` as series `IDX` (NIFTY 50,
BANK, 500 - from `ingest-nse-index-bhavcopy.ts`, a different archive from the
equity bhavcopy). `loadDailyBars()` filters to EQ/BE by default so indices
never enter the tradeable universe - passing the wrong series would backtest
NIFTY as if it were a stock.

**Track B (index option selling) cannot be validated** —
`docs/index-option-selling-backtest.md`. The binding constraint is **expiry
cycles, not calendar days**: 21 trading days of chain data contain only **9
complete cycles** (a cycle needs both the expiry day for settlement and an
earlier day for entry). Entering on more days inside a cycle adds trades, not
independent observations.

- Its 89% win rate is **expected by construction** — a 0.15-delta strangle wins
  70-85% on random data. Never quote it. Worst loss and drawdown are the
  metrics.
- **The tail is invisible at n=9.** Over the same 9 cycles, changing only the
  entry day (7 DTE vs 4 DTE) moves the worst single trade from -13 to -286
  points, 22x. A backtest that has not met the tail has not tested short
  premium.
- Bid/ask **are** populated on index option ticks, so fills are modelled at the
  touch (sell the bid, buy the ask) rather than at the mid.
- The extraction reads ~30M ticks and takes ~290s — fine once, too slow to loop.

Combined workbook for both tracks: `docs/output/strategy-backtests.xlsx`,
regenerated by `scripts/build-strategy-backtests-xlsx.py` from the two JSON
dumps.







### Units: rupees are not points, and the mistake looks conservative

A backtest charged `brokeragePerLeg * legs` — **₹20** — straight against a P&L
denominated in **index points**, so every leg cost 20 *points*. On a two-legged
strangle that was 40 points against an average credit of 119, and 80 points on
a four-legged condor against an 83-point credit. The correct conversion is
rupees ÷ lot size: about **0.31 points/leg on NIFTY and 1.0 on SENSEX**, i.e.
20–65x smaller.

Two things make this worth remembering beyond the one fix:

- **It survived review because it looked conservative.** A backtest whose
  numbers come out worse than expected attracts far less scrutiny than one
  that looks good. Check the direction of an error before trusting that a
  pessimistic result is a safe one — this one flipped an iron condor's
  published average from **−3.9 to +70.6 points**, reversing a conclusion the
  write-up had drawn about protection being pure expense.
- **Points are not comparable across underlyings.** NIFTY's lot is 65 and
  SENSEX's is 20, so one NIFTY point is worth 3.25x a SENSEX point of P&L.
  Anything summed across indices has to be rupees.

## The close is an auction now (CAS, from 2026-08-03)

`docs/nse-cas-impact.md` is the reference, measured against our own capture
rather than quoted from a broker blog. The short version, because it changes
what a settlement price *is*:

F&O-eligible cash stocks stop continuous trading at **15:15**; a 20-minute
auction (reference price = VWAP 15:00-15:15, band ±3%, random close 15:28-15:30,
matching 15:30-15:35) sets the official close. Index closes are built from those
constituent closes, so **index option final settlement is a single auction print
instead of a 30-minute VWAP**. F&O keeps trading to **15:40**.

- **Spot freezes at 15:15 and steps once at ~15:29.** Verified in
  `OptionChainSnapshot`: the stepped value equals the `DailyBar` close exactly
  on every day where both exist. A frozen spot after 15:15 is the auction, not
  a dead feed.
- **The terminal gap widened ~3-7x.** Last-price-at-15:15 vs official close,
  across 209 F&O stocks: **9.0 bps pre-CAS -> 39.0 bps** over the first five CAS
  sessions, converging (62.6 -> 25.1 bps by day five). NIFTY's auction step has
  run 0 to **196 points (0.80%)**, mean absolute ~33 points over the last five.
- **The day-1 upward bias decayed to a coin flip in a week** (79.9% of stocks
  closed above their 15:15 price on 3 Aug, 51.7% by 7 Aug). Don't build on the
  headline number.
- **The option market prices the auction before we can see it.** SENSEX expiry
  13 Aug: `strike + CE - PE` on the expiring contract tracked the frozen spot
  until 15:24, then ran 77,922 -> 78,079 by 15:30 and held flat to 15:41, while
  our spot showed 77,861 throughout. That parity value is a synthetic
  auction-close indicator we can build from data already captured.
- **`apps/api/src/server.ts:2219` still hardcodes a 15:30 close** in a private
  duplicate of `isMarketSessionOpen`, so the API serves the stored ticker feed
  from 15:30-15:41 - across the CAS print. The `NSE_SESSION_*` constants in
  `@option-decode/types` are already 09:14-15:41; this call site was missed.
- Any expiry-day backtest predating August 2026 is measuring a settlement
  mechanism that no longer exists.

## Feed gotchas (Dhan)

- **Greeks are zeroed far more widely than "ITM calls".** `delta`,
  `impliedVolatility`, `theta`, `gamma` all come back as literal `0` —
  originally recorded here as "~47 CE strikes", which **understates it
  badly**. Measured on production 2026-08-11 (NIFTY, 462 ticks):
  **358 of 462 zeroed on the 0-DTE expiry (167 CE + 191 PE)** and
  **287 of 462 on the next expiry** — so puts are hit too, not just calls,
  and only 104 / 175 ticks respectively carry a usable delta. Expiry day
  inflates it (deltas genuinely collapse at 0 DTE) but does not explain it.
  Treat `0` as missing, never as a real value.
- **That zeroing is what starves the Strike Matrix delta bands.** Those
  bands are narrow (intraday 0.15–0.25, weekly 0.12–0.20, monthly
  0.08–0.15), so once ~three-quarters of the chain has no usable delta,
  almost nothing qualifies. Same 2026-08-11 snapshot: the intraday band
  held **exactly 2 strikes** (1 CE + 1 PE) and the **weekly band held 0**.
  A DRCR "bias" there is a ratio of one strike against one strike, and a
  weekly "Transitional" was *no data at all* rather than a market read.
  The UI now says which of the two it is and prints the sample size —
  don't undo that by treating DRCR bias as comparable in weight to the
  Dashboard's whole-chain bias.
- **Put-call parity does not rescue those deltas.** The feed's own CE and PE
  deltas at the same strike disagree by up to 0.11, so a reconstructed delta is
  not trustworthy enough to gate a recommendation on.
- `openInterest` / `volume` / `changeInOpenInterest` are **raw contract
  quantities**. Divide by the tick's own `lotSize` for lots — and honour the
  user's `quantityDisplayMode` preference rather than hardcoding either unit.
- `lotSize` comes from the tick, not a constant. **NIFTY is 65, not the 75
  everyone reaches for** — verified against `OptionContract.lotSize` (1,878
  NIFTY rows, all 65) and `FnoLotSize` across four contract months; SENSEX is
  20. When the tick has no lot size, use `getFallbackLotSize()` from
  `@option-decode/types` — the one table, not a retyped copy. Note the stored
  `OptionContractTick` rows carry **no** lotSize column, so anything reading
  history has to join `OptionContract` or `FnoLotSize`. A wrong lot size never
  fails loudly: it silently rescales every rupee figure and every
  rupees-to-points conversion, so the failure mode is plausible numbers.
- India VIX is often absent locally; the range builder falls back to a 15%
  default and says so in the UI.

## Margin: the app's own model overstates index options by ~2x

`computeDynamicMarginForTrade` (packages/db/src/sim-repository.ts) uses

```
max(0.20 * spot + premium - otmAmount, 0.10 * spot)
```

which is the SEBI-style **prescribed minimum** short-option formula. Applied to
an index option it lands roughly **2.0–2.4x above what a broker actually
blocks**. Worked example, NIFTY 2026-08-14, spot 24,366, short 24,650 CE at
15.95, lot 65:

| | |
|---|---|
| app model | 4,605 pts/unit → **₹2,99,335** = 18.9% of the ₹15.84L notional |
| published | **₹1.25–1.5 lakh** per lot for a naked NIFTY short held overnight = 7.9–9.5% |

Exposure margin alone is a documented 2% of contract value; the balance is
SPAN. **This affects Paper Trade Pro's live buying-power display**, not just
backtests — it is not only a research concern, and it is not yet fixed.

Real margin is SPAN + Exposure, which the exchange revalues **six times a
trading day** from its own risk arrays. It cannot be reconstructed from stored
option chains, so nothing here will ever be exact. Backtests use a separate,
deliberately coarse model — a percentage of notional plus however far a short
is ITM — calibrated to the published range and stated as ±20%. Strike distance
while OTM is *not* modelled: the published figures overlap too heavily to fit
that curve, and inventing a coefficient would be false precision.

If a real number is ever needed, Dhan has a margin calculator endpoint. Note
its MCP credentials are separate from the app's `.env.production` token and
were expired when this was written.

## Performance: the API is round-trip-bound, not compute-bound

Profiled against production on 2026-08-05, a cold `/api/market/overview`:

| Stage | Cost |
|---|---|
| `getMarketAuxData` (cold) | ~2,800 ms |
| `getLatestOptionChainSnapshot` | 766 ms |
| `getAtmCallIvHistory` (before its rewrite) | 2,373 ms |
| **every analytics function combined** | **~12 ms** |

`calculatePressureScore`, `generateMarketAlerts`, `calculateStrikeMovement`,
`calculateMarketBias`, `calculateTradeRecommendations` — all of it, over 462
ticks — is single-digit milliseconds. **Optimising the maths is wasted
effort.** Query count and external calls are where the time goes.

### The connection pool is 10, and nothing says so

`PrismaMariaDb` is constructed with host/port/user/password/database only
(`packages/db/src/index.ts`), so the pool size is the `mariadb` driver's
*undocumented default of 10*. It is not in the schema, the env, or the
config.

**Any `Promise.all` over more than a few queries will starve every other
request in the process.** `getAtmCallIvHistory` fanned out one query per
trading day — 25 at once — and the symptom looked nothing like the cause:
four unrelated endpoints (`elliott-wave`, its alerts, `strike-matrix`, a
second `overview`) all completed *within 40ms of each other at ~10.31s*,
which is the 10s pool-acquire timeout plus their own work. The overview tail
hit 31.5s against a 1.3s median. Logins showed
`pool timeout ... (active=0 idle=0 limit=10)`.

Unrelated endpoints finishing simultaneously at a suspiciously round number
is the signature of pool exhaustion, not of slow endpoints. Prefer one query
over N; if a fan-out is genuinely needed, chunk it well below 10.

### Two costs that cannot be optimised away, only relocated

- **Dhan's scrip master** is 34MB / ~203k rows, downloaded to resolve MCX
  contracts. ~0.4s from EC2 plus parsing.
- **Dhan rate-limits LTP and OHLC to 1 request/sec *combined***, so
  `getFreshMarketAuxData` sleeps 1.1s between them by design. Removing that
  sleep breaches the limit on every refresh.

`getMarketAuxData` serves stale-while-revalidate *only once an entry exists*
— the cold path blocks. Hence `warmOverviewCaches()` after `app.listen()`:
the server pays this at boot rather than the first user. It is deliberately
not awaited, and a failure only logs.

Net effect of the three fixes: first request after a deploy went 3,702ms →
107ms, steady state ~1,373ms median → 4ms.

**That 4ms no longer holds — do not diagnose against it.** Re-measured on
2026-08-14 during market hours, `/api/market/overview` is **4,132ms median
over 240 requests** (p90 7,210ms, p99 11,952ms, max 30,214ms). Cause not yet
established; being investigated separately. Two things are already ruled in
or out:

- **Not pool exhaustion.** In the same window `strike-matrix` ran at a 7ms
  median and `elliott-wave` at 74ms. Starvation slows everything uniformly —
  that signature is unrelated endpoints finishing together at ~10.31s, not
  one endpoint being slow while its neighbours are fast.
- **The host was I/O saturated**: 34–53% iowait, ~19MB/s read / ~38MB/s
  write, 1.4G of 4G swapped. Whether overview is a victim of that or
  independently regressed is the open question.

How to measure it again: `api.log` puts the URL on the `incoming request`
line and the duration on the `request completed` line, joined by `reqId` —
neither line alone is enough, which is why an earlier read of this file
concluded response times could not be attributed to endpoints at all.

## Conventions that bite

- **Runtime values crossing into `apps/web`**: `next.config.ts` carries
  `transpilePackages` + `resolve.extensionAlias` so the workspace packages'
  `.js` import specifiers resolve. If a `next build` fails with
  "Can't resolve './something.js'" while typecheck passes, that is the cause.
- **One source of truth for thresholds.** Band edges and gates are defined once
  and imported (`DRCR_BANDS` in types, `STRIKE_MATRIX_HORIZONS` target deltas,
  `MIN_RECOMMENDATION_OPEN_INTEREST`, `OI_BREADTH_DOMINANCE_RATIO`). If a number
  is needed in a second place, export it — do not retype it. Contract lot
  sizes were the counter-example: the same eleven-symbol table sat in **six**
  files, three in `packages/db` and three in `apps/web`, one of them carrying
  a "keep in sync" comment and no way to enforce it. They now live once, as
  `FALLBACK_LOT_SIZES` / `getFallbackLotSize()` in `packages/types`.
- Any strike the app *names as tradeable* passes the same liquidity gate
  (`MIN_RECOMMENDATION_OPEN_INTEREST`, volume > 0). Two standards is a bug.
- **There are two "bias" signals and they are not the same thing.** The
  user reported them disagreeing; they are *supposed* to.
  `calculateMarketBias` (analytics/index.ts) is **Chain Bias** — whole-chain
  PE-vs-CE pressure over every tick, both directions of OI change,
  Bullish/Bearish at a ±6 gap, labels `Bullish | Bearish | Balanced`.
  `calculateStrikeMatrix`'s bias is **Writer flow (DRCR)** — put-vs-call
  *opening*-OI conviction inside one horizon's narrow delta band only,
  labels `Bullish | Neutral | Bearish | Transitional`. Different inputs,
  different universes, different label sets, and independent poll cadences
  (30s SSE vs 60s/5min/15min) against a 10s snapshot cache, so they can
  also be reading different captures. "Balanced" and "Neutral" are *not*
  synonyms across the two. The UI names the universe in each label for
  exactly this reason — don't rename either back to a bare "Bias".
- **Support/resistance is marked in two places and must come from ONE
  ranking.** The Dashboard's `pressure.supportZones`/`resistanceZones`
  (`topZones` in analytics) and the Option Chain's row marks are the same
  verdict shown twice — unlike the two bias signals above, these are *not*
  supposed to differ. The chain now takes both the strikes it force-shows and
  the ranks it paints straight from those zones; its own per-row scores are
  kept for inspection but decide nothing. Keeping two rankings in sync by hand
  is the bug, not the fix.

  They did disagree (2026-08-17, NIFTY spot 24,256): the chain marked 24,200 as
  strongest support while the Dashboard said 24,000. Both call `pressureValue`
  — the maths was never the problem. Three divergences were:

  - **The chain ranked only the rows it displayed.** VIX 11.58 on 1.2 DTE gave
    an expected-move window of just `[24,094-24,418]`, so 24,000 was never a
    candidate however strong it was.
  - **The guard watched a different number than the ranking.** Outside-window
    walls were force-included by *raw OI*, but marks are ranked by
    `pressureValue`. 24,000 was only THIRD by raw OI (12.31M vs 24,200's
    12.47M, a 1.3% gap) yet FIRST by score (352,092 vs 271,964), because its
    OI built while its premium **fell** (writing) where 24,200's premium
    **rose** (put buying, which is not a floor). A guard must rank on the same
    metric as the thing it guards.
  - **The guard was not directional.** For puts it spent one of its two slots
    on 24,300 — above spot, and discarded by the support ranking on the very
    next line.

  Also aligned: the chain averaged volume across *visible rows* while the
  Dashboard averages across the *whole chain*, so the same strike scored
  differently in each view (24,200: 271,964 vs 295,943).

  Verified on the live production UI, not just the API — 24,000 renders with an
  `OUTSIDE RANGE` flag and carries the strongest-support mark, matching the
  Dashboard on all four marks.
- **An expired option settles at its own session close, not "expiry + 24h".**
  One NSE-shaped schedule was being applied to MCX as well, and the gap showed
  up as expired positions left OPEN with their margin still counted. Two
  CRUDEOIL trades that expired 2026-08-17 were still open the next afternoon,
  both ITM, so a real loss sat unrealised for a full extra day.

  The old rule required `expiryDate + 86_400_000`. `expiryDate` is a
  `@db.Date`, so it is **UTC midnight** — meaning that rule only became true at
  00:00 UTC the day AFTER expiry, while the only job acting on it runs at 15:45
  IST. A Friday expiry therefore waited until Monday, the job being
  weekdays-only.

  Two halves to the fix, and both are needed:

  - `expirySettlementMoment()` asks each contract for its own close via
    `getSessionCloseIstMinutes()` in `packages/types` — **NSE 15:41, MCX
    23:30**, nearly eight hours apart. The exchange list (`MCX_UNDERLYINGS`)
    lives beside the session constants, because the only reason to know a
    symbol's exchange is to pick its session times.
  - A **second EOD pass at 23:40 IST** (`sim-eod-mtm:mark-mcx`). The 15:45 run
    is four minutes after the NSE close but *before* MCX has finished trading,
    so without an evening pass a commodity still could not settle until the
    next day. 23:40 clears the 23:30 close and beats the host's 23:55 shutdown.

  Same queue, job name and handler for both passes — settlement is idempotent
  (a conditional `updateMany` on `status = OPEN`), so a contract settled in the
  afternoon is simply not found in the evening.

  Net effect: NSE settles same day +4 minutes, MCX same day +10 minutes, and a
  Friday expiry no longer waits for Monday.
- **Paper Trade Pro is per-user, and the admin view is READ ONLY.** Users see
  only their own simulator account: no `/api/sim/*` route takes a user
  identifier at all — every one resolves the caller from the session cookie —
  and `closeSimTrade` re-checks `account: { userId }` on the trade itself, so a
  guessed trade id gets nothing. Keep it that way. **Do not add a `userId`
  parameter to `/api/sim/*`**; a surface that cannot name another user is a
  structural guarantee that no future role-checking bug can turn into a
  cross-user leak.

  Admin oversight lives in a separate `/api/admin/sim/*` namespace behind
  `requireAdminUser` (403, matching the other admin routes), added 2026-08-17:
  `GET /accounts` lists every active account, `GET /accounts/:userId` returns
  one in full. There is deliberately **no endpoint to close or reset another
  user's trades** — that is a different feature with a different blast radius,
  and its absence is the guarantee, not the UI.

  Two things that are load-bearing rather than stylistic:

  - **`getSimSummaryForUserId` exists because `getSimSummary` would CREATE an
    account.** The latter goes through `getOrCreateSimAccount`, so pointing it
    at another user's id makes a read perform a write — an admin merely
    *looking* at someone who has never traded would conjure a `SimAccount` for
    them, and the list would then be populated with accounts it had just
    invented. The read-only variant returns null instead.
  - **The list carries no unrealised P&L, on purpose.** Marking open positions
    costs one `OptionContractTick` read per leg and those reads are cold in
    practice; measured at ~975ms for ONE account with two open trades. Doing
    that per row against a pool of 10 is how `getAtmCallIvHistory` starved the
    API. Live marks belong on the single-account detail view.

  The list also skips accounts whose `User` row is missing. Production honours
  the FK (0 orphans), but `sync-prod-db.sh` imports through mysqldump with
  foreign-key checks off, so a **dev machine can have `SimAccount` rows with no
  `User`** — this one did, and it crashed the first test run.
- Comments here explain **why**, especially where a fix encodes a real incident
  ("live NIFTY gave 24500 against a spot of 24367"). Match that: a comment that
  restates the code is noise; one that records the failure it prevents is not.

## Commits

Body-first, plain prose, no bullet-point summaries of the diff. Say what was
wrong, what the evidence was (real numbers from real data), and what changed.
Sign off with the `Co-Authored-By` trailer. Commit and push only when asked.

## Open threads

- **Worker memory — SOLVED (2026-08-19). It was `new Intl.DateTimeFormat`
  inside a per-row loop.** Everything below this entry is the two-week hunt
  that led here; it is kept because the wrong turns are instructive, but the
  answer is one line.

  `istDateKey()` in `packages/analytics/src/wave-screener.ts` constructed a
  formatter on every call, and `calculateRvol` called it **twice per price
  point** — across ~216 symbols x ~740 points that is **~318,000 constructions
  per scan**.

  **`Intl.DateTimeFormat` is backed by ICU, which allocates in C++.** That is
  the whole reason this took so long: the cost is invisible to
  `process.memoryUsage()`, so every measurement showed a flat ~60 MB V8 heap
  beside a multi-gigabyte RSS, and the search kept going to Prisma, the
  mariadb driver, jemalloc and `--max-old-space-size` — all of which were
  innocent.

  Measured in isolation at the real call count, same loop otherwise:

  | | peak RSS | heapTotal |
  |---|---|---|
  | one formatter reused | **77 MB** | 16 MB |
  | new formatter per call | **4,278 MB** | 53 MB |

  Verified on production the same day. Per-scan allocation across the same
  223-symbol universe went from a **+1,657 MB mean over seven pre-fix scans**
  to **+6 MB over seven post-fix scans**. With
  `option-decode-worker-restart.timer` disabled, the worker then held **45
  uninterrupted minutes at a flat 372–377 MB** cgroup memory, four full scans
  inside that one generation adding 4 MB in total; host available memory
  stayed ~2,070 MB with swap flat, and the API answered 200 in 6 ms warm.
  **The restart timer is gone** — deleted, not merely disabled.

  **All of that is one afternoon, and one afternoon is not proof.** A check is
  scheduled for **Thu 2026-08-20, 10:05 IST** (a one-shot in
  `~/.claude/scheduled-tasks/worker-memory-post-fix-check/`, which fires after
  the 09:45 memory report and its 09:50 alert). If that file is gone — the
  task auto-disables once it runs — do the check by hand rather than assuming
  it passed.

  Two specific reasons tomorrow tests something today could not:

  - **Nothing restarts the worker any more.** Every number in this whole entry,
    including the 45 minutes above, is a peak reached *within* a bounded
    generation. From 2026-08-20 the worker runs from the 08:15 IST boot to the
    23:55 shutdown — roughly a 15-hour generation. Slow accumulation that
    7-minute restarts were concealing gets its first chance to appear. The
    figure to read is the trend in per-scan before→after deltas across that
    whole generation, not any single peak.
  - **Thursday loads full history.** Monday's readings are structurally low
    (see the lookback point below) and one was already mistaken for a fix in
    this very investigation. Compare like with like.

  **If it regressed, do not re-arm a restart timer.** That is what turned a
  one-line bug into three weeks. Find which allocation grew, by the A/B method
  below. To stop the bleeding meanwhile, `WAVE_SCREENER_SCAN_ENABLED=false`
  disables the scan alone and leaves quote capture running.

  The regression tripwire in `ops/scripts/worker-memory-alert.sh` is **600 MB**
  against a ~330 MB baseline (lowered from 1,200, which had been sized off a
  Monday reading). Silence on a weekday means no regression; Friday brings the
  trend table regardless.

  **Never construct an `Intl` formatter inside a loop.** Hoist it to module
  scope — it is stateless for formatting. The other three call sites in the
  repo (`packages/utils/src/index.ts` x2, `market-repository.ts`) were hoisted
  at the same time; they are request-path rather than per-row, so they were
  not causing this, but the rule is the same.

  Two things the hunt got structurally right, worth reusing:

  - **The controlled A/B is what found it.** Replaying the real loop over the
    real universe with one line different — identical queries, identical
    159k rows through both arms — put 976 MB of a 1,136 MB peak on the
    analytics and cleared the database layer at 160 MB. Every theory before
    that was mechanism-first and every one was wrong. Isolate the variable
    before proposing a cause.
  - **Memory scaling linearly with rows is a per-row allocation**, and that
    is a strong enough signal to act on. It also explains the calendar
    pattern the user spotted: Monday looked healthy because the 2-day
    lookback reaches into an empty weekend (~30 points/symbol against ~750 by
    Wednesday), so the same code allocated a fraction as much. A workload
    that is quiet on Mondays is a clue about input size, not about the code
    changing.

  `WAVE_SCREENER_SCAN_ENABLED=false` disables the scan (and only the scan —
  quote capture keeps running, or `WavePricePoint` would drain and the next
  measurement would be meaningless). It was added as a kill switch during
  this investigation and kept as a safety valve; it is not needed in normal
  operation.

  *Historical — the hunt, retained for the reasoning:* Two earlier diagnoses
  in this file were wrong; both retractions
  are below, because the way each was reached is the reusable part.
  - *What was believed (2026-08-05):* a live `malloc_trim(0)` (via `gdb -p`)
    returned 4.58 G of a 4.92 G RSS, so glibc was blamed for hoarding freed
    pages. The unit got
    `Environment=LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2`
    and this file recorded it as "holds steady around 570–600 MB across
    cycles". **That number is not reproducible today.**
  - *Also wrong, same day, mine:* `smaps` shows **1,902 MB in a single
    anonymous mapping**, and I read that shape as "must be the V8 heap",
    then nearly set `--max-old-space-size` on the strength of it. **Don't.**
    The worker was already logging the numbers that disprove it. One
    contiguous mapping is not evidence of a heap; check it against
    `process.memoryUsage()` before concluding anything.
  - *What the measurements actually say (2026-08-11, production, 20s
    sampling across full cycles):*

    ```
    RSS=2907MB  heapUsed=133MB  heapTotal=163MB  external=9.4MB  arrayBuffers=2.3MB
    RSS= 225MB  heapUsed= 82MB  heapTotal=115MB  external=7.9MB  arrayBuffers=0.7MB
    ```

    - **Not the JS heap.** `heapTotal` never passes ~165 MB while RSS reaches
      2.9 G, so `--max-old-space-size` would never bind — it is a no-op here,
      not a fix.
    - **Not a leak.** RSS falls back to ~225 MB on its own, repeatedly. The
      memory *is* released. What a 3.8 G host shared with api/web/MySQL/Redis
      cannot absorb is the transient **peak**, which is a different problem
      with a different fix than the ratchet everyone assumed.
    - **Not `ArrayBuffer`s either.** `external` + `arrayBuffers` stay under
      10 MB throughout, which retires the DhanLiveFeedClient theory that
      motivated the original logging.
    - It is **native memory outside V8's accounting** — `nativeGapMb` in the
      log (RSS minus heapTotal/external/arrayBuffers) swings ~100 MB → ~2.7 G.
  - *Attributed to the capture job, first cycle after instrumenting:*

    ```
    capture:before  RSS= 169MB  nativeGap= 106MB
    capture:after   RSS=1206MB  nativeGap=1070MB   (one captureOnce)
    ```

    ~964 MB of native allocation inside a **single** `captureOnce()` — and
    that sample was taken *after market close, on a job that was skipping
    storage*, so the burst is not proportional to ticks processed. That
    points at the query/setup path rather than tick volume.
  - **Neither 2026-08-12 fix reduced the peak — retracted.** Both were
    reported here as wins on a metric that could not show otherwise.
    Per-15-minute-generation peak RSS: **pre-split 1,819-2,485 MB,
    post-split 1,726-2,955 MB, post-serialise 2,870 MB.** Flat to slightly
    worse. The celebrated "mean delta +873 MB → +18 MB" measured allocation
    *within a job* and was then compared across a change that split one job
    into seven — the metric fell by construction. **Measure peak RSS per
    restart generation, never per-job deltas, when judging a partitioning
    change.**
  - *Fix 1 — one job per underlying (2026-08-12).* `captureOnce` fanned out
    ~14 chain writes in one 31-41s job. Two traps this hit, both worth not repeating: the queue limiter
    was `max 1 per 15s` and would have throttled a 30s cycle to a single job
    (silent capture starvation), and staggering by *enqueue delay* does not
    space jobs that are already overdue — delayed jobs survive the 15-minute
    restart in Redis, so a restart replayed the backlog back-to-back and
    produced **five index-capture 429s in six seconds** on a path with zero
    all day. Pacing now happens at the head of each job, and fan-out jobs
    older than one interval are dropped.
  - **"It is the BANKNIFTY chain write" was wrong — do not re-derive it.**
    The remaining ~3% of bursts are *not* proportional to chain size:
    COPPER's **138-tick** chain burst 994 MB while its 738-tick BANKNIFTY
    neighbour averaged **−43 MB**, and SENSEX's worst (1,441 MB) beat
    BANKNIFTY's (1,295 MB) on half the ticks. Per-underlying mean deltas are
    all near zero. There is no big-chain write to optimise.
  - **The actual allocator is the screener SCAN, on a 3-minute cadence.**
    Within one generation RSS is ~350 MB baseline with **5 spikes to
    ~1.9 GB, returning to baseline each time** — 5 spikes per 15 minutes
    against `SCREENER_SCAN_INTERVAL_MS = 3 * 60_000`, an exact match. The
    scan loops ~216 symbols calling `getSpotPriceHistory`/
    `getWavePriceHistory` per symbol. It is **already sequential and
    `points` goes out of scope each iteration**, so nothing retains 216
    histories at once and "batch the loading" fixes a problem that does not
    exist — I proposed exactly that before reading the loop. The open
    question is whether the allocator simply fails to return pages during
    ~216 back-to-back queries (a periodic yield would help) or one step
    dominates; `wave:screener-scan:progress` samples now answer it.
  - *Fix 2 — serialise the wave screener (2026-08-12).* What predicts a
    burst is **overlap**, not size. Across ~1,500 post-split captures the
    screener ran during 102 of them and 25 burst (**24.5%**); of the other
    1,412, only 21 burst (**1.5%**) — a ~16x rate from a component
    overlapping 6.7% of jobs but causing 54% of bursts. The reason is
    structural and easy to miss: this process runs **four** BullMQ workers
    (market-snapshot, quote-capture, screener-scan, universe-sync), and
    `concurrency: 1` constrains each worker against *itself only*, never
    against the others. `heavy-job-lock.ts` (a plain in-process promise
    chain — they share a process, so a Redis lock would be theatre) now
    serialises them. Job duration is what decides which capture is unlucky:
    SILVER averages 0.4s and never burst once; BANKNIFTY averages 10.1s and
    burst most.
  - **ISOLATED (2026-08-12, controlled A/B on the host).** Four fixes had
    been shipped on plausible mechanism and none moved the peak, so the
    scan's per-symbol work was replayed one variable at a time over the same
    214 symbols:

    ```
    queries only (getWavePriceHistory x214):  peak 225MB, settles to 163MB
    indices only (getSpotPriceHistory x7):    peak 186MB
    queries + Elliott Wave / RSI / RVOL:      peak 976MB, stays  955MB
    ```

    **The database layer is cleared outright** — Prisma, the `mariadb`
    driver and the query volume all behave. The allocator is the **wave
    analytics**: short-lived JS churn that V8 *does* collect (`heapTotal`
    never leaves ~62 MB) while the freed pages stay with the allocator.
    Every theory aimed at the DB path — WASM query compiler, prepared
    statement cache, row volume — was aimed at the wrong half of the loop.
  - **"Never returned" was wrong: it was "not returned YET."** Samples taken
    5 s after the loop sit inside jemalloc's **10 s default decay window**,
    so they read as permanent. At 30 s:

    ```
    jemalloc defaults (10s decay):  peak 938MB, 288MB after 30s idle
    dirty_decay_ms:0 + bg thread:   peak 721MB, 136MB after 30s idle
    ```

    Hence `MALLOC_CONF=background_thread:true,dirty_decay_ms:0,muzzy_decay_ms:0`
    on the unit. **Always settle longer than the decay window before
    concluding memory is held.**
  - *Dead end, do not repeat:* `dirty_decay_ms:2000` paired with a 100 ms
    in-loop yield. A page must sit dirty for the whole decay window to become
    purgeable, so a 100 ms pause can never trigger a 2 s decay. Both numbers
    shipped in one commit without being checked against each other.
  - *Leading suspect, WRONG — retired 2026-08-19:* Prisma's WASM query
    compiler. The A/B cleared it outright: 216 queries returning 159k rows
    peaked at **160 MB**. The real culprit was ICU, which fits the same
    "native memory invisible to Node" fingerprint — which is the lesson.
    That fingerprint identifies a *class* of allocator, not a component, and
    it is satisfied by every native library the process links. It narrows
    nothing on its own; only isolating the variable did. Original reasoning
    kept below.

    (`engineType = "client"`). WASM linear memory is a native mmap invisible
    to `process.memoryUsage()`, which fits this signature exactly — and
    `schema.prisma`'s own comment records the *previous* engine holding
    "multiple GB completely invisible to Node's own memory APIs, on a process
    that otherwise sits under 100MB of V8 heap". Same fingerprint, new
    engine. Both `createMany` call sites already route through
    `insertInFixedShapes`, so the known prepared-statement-cache vector is
    already guarded — this is something else.
  - *Contained, not fixed — and the containment is now REMOVED.*
    `option-decode-worker-restart.timer` restarted the worker every 15
    minutes (7 from 2026-08-19 morning) and was the only reason the box
    survived; host sat at ~120 MB available with 1.37 G swapped. It was
    disabled and deleted the same day the formatter was fixed. Do not
    re-create it — see the unit comment in `option-decode-worker.service`.
  - Still true and still a trap: systemd's `memory peak` is a cgroup
    high-water mark, so it overstates a moment rather than describing the
    steady state. Use mid-cycle RSS, `smaps_rollup`, or `free -m`.
  - **The instrumentation is in `apps/worker/src/worker.ts` and is the point
    of it — read the log before theorising.** It samples every 20s (2-minute
    sampling caught the burst in ~1 sample in 3 and missed the rise and fall,
    which is how "grows unboundedly" survived as a description) and brackets
    each capture job.
- **First-login latency** — server side is done (see the performance section
  above; 3,702 ms → 107 ms cold, 4 ms warm). Users originally reported 20–25 s
  and nothing measurable on the API ever accounted for that, so the remainder
  is presumed browser-side: first-visit asset download plus hydration on top
  of a ~215 KB overview payload, with `/app` server-rendered `cache: "no-store"`.
  Never confirmed with a DevTools trace.
- **Option Chain intents #3 and #4** — monitoring support/resistance *shifting*
  between snapshots, and predicting whether a level breaks or moves. Both need
  snapshot-over-snapshot history and are not built.

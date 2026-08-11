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
- `lotSize` comes from the tick, not a constant (it is not always 75).
- India VIX is often absent locally; the range builder falls back to a 15%
  default and says so in the UI.

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

## Conventions that bite

- **Runtime values crossing into `apps/web`**: `next.config.ts` carries
  `transpilePackages` + `resolve.extensionAlias` so the workspace packages'
  `.js` import specifiers resolve. If a `next build` fails with
  "Can't resolve './something.js'" while typecheck passes, that is the cause.
- **One source of truth for thresholds.** Band edges and gates are defined once
  and imported (`DRCR_BANDS` in types, `STRIKE_MATRIX_HORIZONS` target deltas,
  `MIN_RECOMMENDATION_OPEN_INTEREST`, `OI_BREADTH_DOMINANCE_RATIO`). If a number
  is needed in a second place, export it — do not retype it.
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
- Comments here explain **why**, especially where a fix encodes a real incident
  ("live NIFTY gave 24500 against a spot of 24367"). Match that: a comment that
  restates the code is noise; one that records the failure it prevents is not.

## Commits

Body-first, plain prose, no bullet-point summaries of the diff. Say what was
wrong, what the evidence was (real numbers from real data), and what changed.
Sign off with the `Co-Authored-By` trailer. Commit and push only when asked.

## Open threads

- **Worker memory growth — the "570–600 MB" claim below was WRONG; measured
  again 2026-08-11 and it is the V8 heap, not glibc.** Keeping the history
  because the retraction is the useful part.
  - *What was believed (2026-08-05):* a live `malloc_trim(0)` (via `gdb -p`)
    returned 4.58 G of a 4.92 G RSS, so glibc was blamed for hoarding freed
    pages. The unit got
    `Environment=LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libjemalloc.so.2`
    and this file recorded it as "holds steady around 570–600 MB across
    cycles". **That number is not reproducible today.**
  - *What is actually true (2026-08-11, live production):* jemalloc **is**
    still loaded (4 mappings in `/proc/<pid>/maps` — check that before
    assuming it was dropped). The worker nonetheless reaches **1.4 G RSS in
    under 5 minutes** and **3.1 G cgroup peak per 15-minute cycle**, three
    cycles running. `smaps_rollup` shows 2.07 G anonymous, and `smaps`
    attributes **1,902 MB of it to a single anonymous mapping** — one
    contiguous region, which is the shape of the V8 heap, not of scattered
    native `ArrayBuffer`s.
  - *The ceiling explains it.* `v8.getHeapStatistics().heap_size_limit` on
    this host is **1,960 MB** — V8 sized its default old space from total
    RAM, not knowing api + worker + web + MySQL + Redis share a 3.8 G box.
    The heap sits at ~97% of that limit, and the unit passes **no**
    `--max-old-space-size`. Sustained CPU is ~33% of a core (5 min CPU per
    15 min wall), consistent with GC thrashing against the cap.
  - *Nothing is fixed — it is contained.* `option-decode-worker-restart.timer`
    kills and restarts the worker every 15 minutes; that timer is the only
    reason the box survives. Host sits at ~120 MB available with 1.37 G
    swapped. Do not read "no OOM in the logs" as health.
  - **Before diagnosing further, add instrumentation: the worker logs no
    memory at all today.** `process.memoryUsage()` +
    `v8.getHeapStatistics()` per cycle is the missing first step, and would
    settle "collectable garbage vs genuine retention" — which a heap
    snapshot under `--max-old-space-size` can then localise. The Dhan feed's
    per-message `ArrayBuffer`s are still a suspect but are no longer the
    leading one; a single 1.9 G mapping points at retained JS objects.
  - Still true and still a trap: systemd's `memory peak` is a cgroup
    high-water mark, so it overstates a moment rather than describing the
    steady state. Use mid-cycle RSS, `smaps_rollup`, or `free -m`.
- **First-login latency** — server side is done (see the performance section
  above; 3,702 ms → 107 ms cold, 4 ms warm). Users originally reported 20–25 s
  and nothing measurable on the API ever accounted for that, so the remainder
  is presumed browser-side: first-visit asset download plus hydration on top
  of a ~215 KB overview payload, with `/app` server-rendered `cache: "no-store"`.
  Never confirmed with a DevTools trace.
- **Option Chain intents #3 and #4** — monitoring support/resistance *shifting*
  between snapshots, and predicting whether a level breaks or moves. Both need
  snapshot-over-snapshot history and are not built.

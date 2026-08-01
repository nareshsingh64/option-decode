# Option Decode: Docker → Native EC2 Migration Scope

Grounded in the actual `docker-compose.prod.yml`, `Dockerfile`, and
`nginx/default.conf` as they exist today, not a generic template.

## What's currently containerized vs. already native

| Component | Today | After migration |
|---|---|---|
| MySQL | Native on host (already migrated out of Docker) | No change |
| Redis | Container (`redis:7-alpine`, named volume) | Native `redis-server` |
| nginx | Container (TLS termination, rate limiting, proxy) | Native `nginx` |
| api (Fastify) | Container, `tsx src/server.ts`, runs `prisma migrate deploy` on start | systemd unit |
| worker (BullMQ) | Container, `tsx src/worker.ts` | systemd unit |
| web (Next.js) | Container, `pnpm start` | systemd unit |

Everything moves onto the same single EC2 host — this isn't a re-platforming,
just removing the container layer.

## Concrete simplifications this removes

- **BuildKit cache management disappears entirely** — no more
  `docker-build-cache-prune` cron, no more 20GB/day growth.
- **The DATABASE_URL gateway-IP gotcha goes away.** Today, api/worker reach
  native MySQL through the Docker bridge's gateway IP, which breaks if the
  bridge subnet ever changes (documented gotcha in `database-prisma-mysql.md`).
  Once api/worker are native processes too, they just connect to
  `127.0.0.1:3306` directly.
- **No more dev/prod compose file mixups** (a mistake we actually hit this
  session).
- **No more `expose` vs `ports` confusion** when curling a service from the
  host during debugging.

## What needs deciding before starting (not technical blockers, just choices)

1. **Process manager: systemd vs pm2.** Recommend systemd — it's already how
   MySQL is managed on this host (`mysql-safe-restart.sh` uses `systemctl`),
   so it keeps one consistent operational model instead of two. pm2 gives
   nicer built-in log rotation/monitoring but adds a second supervisor
   paradigm to the box.
2. **Release layout: in-place vs. release-dir + symlink.** Building straight
   into `/opt/option-decode` on every deploy is simplest but loses Docker's
   "swap an image tag to roll back instantly" property. A
   `/opt/option-decode/releases/<git-sha>/` + `current -> releases/<sha>`
   symlink pattern restores near-instant rollback (flip the symlink, restart
   services) at the cost of a bit more deploy-script complexity. Recommend
   adopting this — it's the one piece of real Docker benefit worth
   deliberately replacing rather than just dropping.
3. **Logs: journald vs. keep file-tee + logrotate.** There's already a
   `logrotate.d/option-decode` policy tuned for the current
   `./logs/api`/`./logs/worker` tee'd files. Systemd units default to
   journald, but can also redirect stdout/stderr to the same file paths to
   keep that policy working unchanged. Recommend keeping the file-tee
   approach for continuity — journald migration can be a later, separate
   cleanup.

## Migration steps

**1. Install native runtimes on the EC2 host**
Node 22 (NodeSource apt repo, matching the `node:22-alpine` version pin),
`corepack enable && corepack prepare pnpm@11.8.0 --activate` (same pin as the
Dockerfile — corepack works identically outside a container), `redis-server`
via apt (verify the Ubuntu 22.04 default package version is ≥7 to match
`redis:7-alpine`; if not, use the official Redis apt repo), `nginx` via apt.

**2. Create a dedicated service account**
Run api/worker/web as an unprivileged `option-decode` system user rather than
`ubuntu`/root, to keep the process-isolation property Docker was providing.
Set ownership on `/opt/option-decode`, `logs/`, and build output accordingly.

**3. Build**
Port the Dockerfile's build steps to a deploy script run on the host:
`pnpm install --frozen-lockfile && pnpm --filter @option-decode/db db:generate
&& pnpm --filter @option-decode/web build`. If adopting the release-dir
pattern, this happens inside the new `releases/<sha>/` directory before the
symlink flips.

**4. systemd units** (`/etc/systemd/system/`)
- `option-decode-api.service` — `EnvironmentFile=.env.production`,
  `ExecStartPre` running `prisma migrate deploy` (matching today's container
  startup command exactly), `ExecStart` running `tsx src/server.ts`,
  `Restart=on-failure`, `User=option-decode`.
- `option-decode-worker.service` — same shape, no migrate step.
- `option-decode-web.service` — `pnpm --filter @option-decode/web start`,
  `After=option-decode-api.service` (best-effort ordering — nginx will just
  briefly 502 if web wins the race, same as today's healthcheck window).

No direct systemd equivalent to Docker's `healthcheck:` + `depends_on:
condition: service_healthy` — `Restart=on-failure` covers crash recovery, but
there's no built-in "wait until actually serving 200s" gate. Worth a small
cron/systemd-timer watchdog script if that gap matters, otherwise accept the
same brief bad-gateway window the current deploy already has.

**5. nginx**
Move `nginx/default.conf` to `/etc/nginx/sites-available/`, swap the
container-hostname upstreams (`web:3000`, `api:4000`) for `127.0.0.1:3000`
and `127.0.0.1:4000`, copy `nginx/certs/` to `/etc/nginx/certs/`, enable the
site, `systemctl enable --now nginx`. Rate-limiting config (`login_limit`,
`auth_api_limit`) carries over unchanged.

**6. Redis**
Native `redis-server` with a data directory matching what the
`option_decode_redis` named volume held. Confirm BullMQ and the live-feed
tick cache have no dependency on anything Alpine/container-specific (they
don't — it's plain Redis protocol).

**7. Update `.env.production`**
`DATABASE_URL` → `127.0.0.1:3306` (or a unix socket) instead of the Docker
bridge gateway IP. `REDIS_URL` → `127.0.0.1:6379`.

**8. Rewrite the deploy flow**
Replace `docker compose ... build` / `up -d --force-recreate` in the runbook
and in `option-decode-web-tester`'s `references/production-ec2.md` with the
systemd equivalent: `git pull`, build (or build-into-new-release-dir), then
`systemctl restart option-decode-api option-decode-worker`, then
`systemctl restart option-decode-web` — same two-step ordering as today's
"api/worker first, then web" pattern to keep the bad-gateway window short.

**9. Cutover**
Do this after market close (same 15:30–16:00 IST window already used for
other risky maintenance). Stop the Docker stack, start the native stack,
run the existing smoke tests from `production-ec2.md`
(`curl -kI https://localhost/`, `/login`, `/api/auth/me`), then check
`https://pytrade.co.in` from a browser. Keep the Docker Compose files and
images in place (don't `docker system prune -a`) for a burn-in period —
instant rollback is just `docker compose ... up -d` again if something's
wrong.

**10. Cleanup (only after the burn-in period is stable)**
Remove the `docker-build-cache-prune` cron (no longer applicable). Decide
whether to uninstall Docker entirely or leave it installed-but-idle as a
safety net for a while longer.

## Risks worth naming explicitly

- This is a live trading-hours application — the cutover itself is the
  highest-risk step and should happen in a low-traffic window with a
  rehearsed rollback, not as a routine deploy.
- Redis version drift (apt default vs. `redis:7-alpine`) needs a one-time
  check, not assumed compatible.
- Running as root instead of a dedicated service user would be a real
  regression in isolation — worth doing properly (step 2), not skipping.
- Losing image-tag rollback is a genuine trade-off; the release-dir symlink
  pattern (decision #2) is what closes that gap — worth deciding on
  deliberately rather than defaulting to in-place builds.

## Suggested order of work

Steps 1–7 can be built and tested on the host *without* touching production
traffic (native services can run on alternate ports, e.g. 3001/4001, while
Docker still serves 80/443). Only step 9 (the actual cutover) needs a
maintenance window. That means most of this can be done incrementally, with
the risky part compressed into a single short, reversible cutover step.

# Option Decode EC2 Production Deploy

Option Decode runs natively on the EC2 host as systemd services — api, worker,
and web are each a `pnpm ... exec tsx` process managed by systemd, not
containers. MySQL, Redis, and nginx are also native (apt) installs. Docker is
no longer part of the live stack (migration completed via
`ops/native-migration/`); if you find a reference to `docker compose` for
this app anywhere else, it's stale.

## Directory layout

- `/opt/option-decode` — the authenticated git checkout. `git pull` happens
  here. This is the *source*, not what's actually running.
- `/opt/option-decode-native/` — the live app:
  - `releases/<git-sha>/` — one full checkout+build per deploy.
  - `current` — symlink to the active release. This is what systemd units
    point at.
  - `shared/.env.production` — the one real env file, symlinked into every
    release rather than duplicated.
  - `logs/{api,worker,web}/` — persistent across releases and deploys.

## 1. Initial Environment Setup

(Already done for `pytrade.co.in` — reference for a from-scratch setup or a
new secret.)

```bash
sudo mkdir -p /opt/option-decode-native/shared
nano /opt/option-decode-native/shared/.env.production
```

Set real values for:

- `APP_PUBLIC_URL`
- `MYSQL_ROOT_PASSWORD`
- `MYSQL_PASSWORD`
- `SESSION_SECRET`
- `JWT_SECRET`
- `DHAN_CLIENT_ID`
- `DHAN_ACCESS_TOKEN`
- `SMTP_HOST`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `EMAIL_FROM`
- `SNAPSHOT_RETENTION_DAYS` (defaults to 90 if unset — confirm this is
  actually the value you want; a silently-defaulted retention window is
  what let `OptionContractTick` grow to 27GB+ before anyone noticed)
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

Generate strong secrets:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Generate browser push VAPID keys (from inside a built release, or any
checkout with dependencies installed):

```bash
pnpm --filter @option-decode/worker exec web-push generate-vapid-keys
```

For `pytrade.co.in`, keep:

```env
APP_PUBLIC_URL=https://pytrade.co.in
```

## 2. HTTPS Certificate

(Already in place — reference for a cert renewal or a new host.)

```bash
chmod +x scripts/generate-self-signed-cert.sh
sudo scripts/generate-self-signed-cert.sh /etc/nginx/certs pytrade.co.in www.pytrade.co.in
```

`ops/native-migration/nginx-native.conf` (deployed to
`/etc/nginx/sites-available/`) reads the cert from `/etc/nginx/certs/`
directly — not from a path inside the repo. The browser will show a warning
because this is self-signed; that's expected.

## 3. Deploy

```bash
cd /opt/option-decode
git pull origin main
sudo bash ops/native-migration/native-deploy.sh
```

This builds a new release (only if one doesn't already exist for the current
git SHA), symlinks `current` to it, then restarts services in the same
order the old Docker runbook used — api/worker first (shorter downtime,
`prisma migrate deploy` runs automatically via the api unit's
`ExecStartPre`), then web after a short pause — and prunes old releases,
keeping the last 5.

The script must run as root (`sudo`) — it `chown`s the new release to the
`option-decode` service user at the end.

Restart without a new deploy (e.g. after a secret/env change, no code
change):

```bash
sudo systemctl restart option-decode-api option-decode-worker
sudo systemctl restart option-decode-web
```

Rollback to the previous release instantly, without rebuilding:

```bash
ls -1t /opt/option-decode-native/releases/   # find the previous SHA
sudo ln -sfn /opt/option-decode-native/releases/<previous-sha> /opt/option-decode-native/current
sudo systemctl restart option-decode-api option-decode-worker option-decode-web
```

## 4. Services

```bash
systemctl status option-decode-api --no-pager
systemctl status option-decode-worker --no-pager
systemctl status option-decode-web --no-pager
```

All three are `enabled` and start automatically on boot. Confirm this after
any reboot or instance-type change — a prior outage on this host was caused
by these three units having never been enabled, so a reboot silently left
the app down even though MySQL/Redis/nginx (enabled by default via apt) came
back fine.

**`option-decode-worker-restart.timer` was removed on 2026-08-19 and should
not come back.** It recycled the worker every 7 minutes (15 before that day)
to bound a memory growth blamed in turn on Prisma's native query engine, its
WASM successor, the mariadb driver and glibc — all four wrong. The cause was
a per-call `new Intl.DateTimeFormat` in the wave screener's rvol loop, about
318,000 ICU allocations per scan, allocated in C++ where
`process.memoryUsage()` could not see them. Commit `a85236d` hoists the
formatter; measured straight afterwards, the worker held a flat 372–377 MB
across 45 uninterrupted minutes and four full scans.

If you are provisioning a fresh host from this doc, simply do not create the
timer. If worker memory ever climbs again, find which allocation grows before
reaching for a restart — see CLAUDE.md's worker-memory entry for how three
weeks of mechanism-first guessing failed and what actually worked.

## 5. Smoke Tests

```bash
curl -kI https://localhost/
curl -kI https://localhost/login
curl -kI https://localhost/api/auth/me
curl -kI http://localhost/
```

Expected:

- HTTPS routes return `200`.
- `/api/auth/me` returns `200`.
- HTTP redirects to HTTPS for configured domain hosts.

From your browser:

```text
https://pytrade.co.in
```

Accept the self-signed certificate warning.

## 6. Create Admin User

Register from `/register`, then promote your user. Source the DB password
fresh in the same command (the env file is `640`, owned by
`option-decode`):

```bash
export MYSQL_PASSWORD=$(sudo grep '^MYSQL_PASSWORD=' /opt/option-decode-native/shared/.env.production | cut -d= -f2-)
mysql -u option_decode -p"$MYSQL_PASSWORD" option_decode -e \
  "update User set role='ADMIN', emailVerified=1 where email='naresh.singh64@gmail.com';"
```

## 7. Daily Operations

Deploy code changes — see section 3.

View logs (file-based, rotated via `ops/logrotate/option-decode` — not
`docker compose logs`):

```bash
tail -n 120 /opt/option-decode-native/logs/api/api.log
tail -n 120 /opt/option-decode-native/logs/worker/worker.log
tail -n 120 /opt/option-decode-native/logs/web/web.log
```

Backup Option Decode DB:

```bash
export MYSQL_PASSWORD=$(sudo grep '^MYSQL_PASSWORD=' /opt/option-decode-native/shared/.env.production | cut -d= -f2-)
mkdir -p ~/backups/option-decode/$(date +%F)
mysqldump -u option_decode -p"$MYSQL_PASSWORD" option_decode \
  | gzip > ~/backups/option-decode/$(date +%F)/option_decode.sql.gz
```

Stop the app without deleting data:

```bash
sudo systemctl stop option-decode-api option-decode-worker option-decode-web
```

Start it again:

```bash
sudo systemctl start option-decode-api option-decode-worker option-decode-web
```

MySQL and Redis are native services, not stopped/started with the app -
`systemctl stop/start mysql redis-server` separately if actually needed.

## 8. Instance Schedule

This instance is stopped/started automatically on weekdays via two AWS
EventBridge Scheduler rules (**08:15 / 23:50 IST**, read back from the console on 2026-08-20 — this doc said 8:55 AM / 11:55 PM and both were wrong) rather than running
24/7. `option-decode-api`, `option-decode-worker` and `option-decode-web`
all being `enabled` (section 4) is what makes this safe — the app comes back
up on its own after each scheduled start with no manual intervention.

# Option Decode EC2 Production Deploy

This runbook deploys Option Decode as the only live application on the EC2 instance. The old Dhan-Test application should already be backed up and stopped with `docker compose down` without `-v`.

## 1. Prepare EC2 Folder

```bash
sudo mkdir -p /opt/option-decode
sudo chown -R ubuntu:ubuntu /opt/option-decode
cd /opt/option-decode
```

Copy or clone this repository into `/opt/option-decode`.

## 2. Create Production Environment

```bash
cp .env.production.example .env.production
nano .env.production
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

Generate strong secrets:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

For `pytrade.co.in`, keep:

```env
APP_PUBLIC_URL=https://pytrade.co.in
```

## 3. Generate Self-Signed HTTPS Certificate

```bash
chmod +x scripts/generate-self-signed-cert.sh
scripts/generate-self-signed-cert.sh ./nginx/certs pytrade.co.in www.pytrade.co.in
```

The browser will show a warning because this is self-signed. This is expected.

## 4. Start Production Stack

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app build
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app up -d
```

First build can take several minutes because it installs workspace dependencies, builds Next.js, and generates Prisma client inside the Docker image. After the image is built, container startup is much faster because production no longer runs `pnpm install` or `next build` during app start.

Apply database migrations after pulling changes that include new Prisma migrations:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app run --rm api \
  pnpm --filter @option-decode/db db:migrate
```

Check status:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app ps
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app logs --tail=80 api
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app logs --tail=80 web
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app logs --tail=80 worker
```

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

Register from `/register`, then promote your user:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app exec -T mysql \
  mysql -u option_decode -p option_decode -e \
  "update User set role='ADMIN', emailVerified=1 where email='naresh.singh64@gmail.com';"
```

When prompted for the DB password, use `MYSQL_PASSWORD` from `.env.production`.

Non-interactive form:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app exec -T mysql \
  mysql -u option_decode -p"$MYSQL_PASSWORD" option_decode -e \
  "update User set role='ADMIN', emailVerified=1 where email='naresh.singh64@gmail.com';"
```

## 7. Daily Operations

Deploy code changes with a shorter bad-gateway window:

```bash
cd /opt/option-decode
git pull origin main
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app build
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app up -d --no-deps --force-recreate api worker
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app up -d --no-deps --force-recreate web
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app ps
```

Restart after token changes without rebuilding:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app up -d --no-deps --force-recreate api worker
```

View worker logs:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app logs --tail=120 worker
```

Backup Option Decode DB:

```bash
mkdir -p ~/backups/option-decode/$(date +%F)
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app exec -T mysql \
  mysqldump -u option_decode -p"$MYSQL_PASSWORD" option_decode \
  | gzip > ~/backups/option-decode/$(date +%F)/option_decode.sql.gz
```

Stop app without deleting data:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml --profile app down
```

Do not use `-v` unless you intentionally want to delete MySQL/Redis volumes.

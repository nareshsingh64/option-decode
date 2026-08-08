# Getting Started

Option Decode is a new Node.js/TypeScript application built separately from the
existing Flask trading app.

## Prerequisites

- Node.js 22 LTS or newer
- pnpm 9 or newer (`corepack enable && corepack prepare pnpm@11.8.0 --activate`
  to match the pinned version)
- MySQL and Redis, run natively via Homebrew — matches how production runs
  them (see `docs/ec2-production-deploy.md`), no Docker involved:

  ```bash
  brew install mysql@8.4 redis
  brew services start mysql@8.4
  brew services start redis
  ```

## Local Setup

```bash
cd option-decode
cp .env.example .env.local
```

Create the app database and user (first time only):

```bash
mysql -u root -e "
CREATE DATABASE IF NOT EXISTS option_decode;
CREATE USER IF NOT EXISTS 'option_decode'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY 'option_decode';
CREATE USER IF NOT EXISTS 'option_decode'@'localhost' IDENTIFIED WITH mysql_native_password BY 'option_decode';
GRANT ALL PRIVILEGES ON option_decode.* TO 'option_decode'@'127.0.0.1';
GRANT ALL PRIVILEGES ON option_decode.* TO 'option_decode'@'localhost';
GRANT ALL PRIVILEGES ON \`prisma_migrate_shadow_db_%\`.* TO 'option_decode'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`prisma_migrate_shadow_db_%\`.* TO 'option_decode'@'localhost';
FLUSH PRIVILEGES;
"
```

`mysql_native_password` must be active for the `mariadb` npm driver
(`@prisma/adapter-mariadb`) — enable it once via
`/opt/homebrew/etc/my.cnf`'s `[mysqld]` section: `mysql-native-password = ON`,
then `brew services restart mysql@8.4`. The shadow-db grant (wildcard-scoped
to Prisma's `prisma_migrate_shadow_db_*` naming pattern, not a blanket global
grant) is required for `prisma migrate dev`, which diffs against a
disposable shadow database on every run.

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Default local services:

- Web app: http://localhost:3000
- API: http://localhost:4000
- MySQL: 127.0.0.1:3306
- Redis: 127.0.0.1:6379

## Production Shape

Production runs natively on a single EC2 host — no Docker. See
`docs/ec2-production-deploy.md` for the full systemd/nginx setup and deploy
flow.

## Dhan Feed Mode

The worker starts in safe mock mode:

```env
MOCK_MARKET_FEED_ENABLED=true
```

To test live Dhan ingestion, set real credentials and disable mock mode:

```env
DHAN_CLIENT_ID=your_real_client_id
DHAN_ACCESS_TOKEN=your_real_access_token
MOCK_MARKET_FEED_ENABLED=false
```

Then restart your `pnpm dev` process so the worker picks up the new env
values.

Live mode fetches the nearest expiry for each configured underlying and persists
the normalized option-chain snapshot to MySQL.

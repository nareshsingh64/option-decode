# Getting Started

Option Decode is a new Node.js/TypeScript application built separately from the
existing Flask trading app.

## Prerequisites

- Node.js 22 LTS or newer
- pnpm 9 or newer
- Docker Desktop

## Local Setup

### Option A: Docker-only

Use this if Node.js and pnpm are not installed on your Mac yet.

```bash
cd option-decode
cp .env.example .env.local
docker compose up -d mysql redis
docker compose --profile app up web api worker
```

Default local services:

- Web app: http://localhost:3000
- API: http://localhost:4000
- MySQL: 127.0.0.1:3308
- Redis: 127.0.0.1:6380

### Option B: Host Node.js

Use this after installing Node.js 22 LTS or newer and pnpm 9 or newer.

```bash
cd option-decode
cp .env.example .env.local
docker compose up -d mysql redis
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

## First Production Shape

For the first EC2 version, run the same services with Docker Compose:

- web
- api
- worker
- mysql
- redis
- nginx

Before onboarding real users, add automated MySQL backups and move secrets into
server-only environment files.

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

Then restart the worker:

```bash
docker compose --profile app up -d --force-recreate worker
docker compose logs --tail=120 worker
```

Live mode fetches the nearest expiry for each configured underlying and persists
the normalized option-chain snapshot to MySQL.

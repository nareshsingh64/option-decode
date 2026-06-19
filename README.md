# Option Decode

Premium options research platform for live option-chain intelligence, pressure
analysis, historical replay, and paper trading.

This is the new Node.js/TypeScript build. It intentionally lives separately from
the existing Flask app so the product can evolve with a clean architecture while
still borrowing proven market-data and paper-trading ideas from the current
system.

## Apps

- `apps/web`: Next.js PWA and trading-terminal UI.
- `apps/api`: Fastify API for auth, market data, analytics, replay, and paper
  trading.
- `apps/worker`: background jobs for Dhan ingestion, replay jobs, reports, and
  backtests.

## Packages

- `packages/config`: typed environment parsing.
- `packages/db`: Prisma schema and MySQL client.
- `packages/dhan`: Dhan API adapter boundary.
- `packages/analytics`: deterministic pressure scoring and research metrics.
- `packages/trading`: paper-trading lifecycle primitives.
- `packages/types`: shared TypeScript contracts.

## Local Start

```bash
cp .env.example .env.local
docker compose up -d mysql redis
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

See `docs/getting-started.md` for more detail.

The default worker uses mock market snapshots so the dashboard and storage flow
can be tested safely. Set `MOCK_MARKET_FEED_ENABLED=false` with real Dhan
credentials when testing live ingestion.

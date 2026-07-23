# Bun/Elysia backend revamp

Status: **Milestone 1 foundation in progress on `revamp/bun-elysia-prisma`**. The Python/FastAPI service remains the only production backend.

Tracking issue: [#8](https://github.com/om-surushe/SendPlug/issues/8)

## Locked stack

- Bun 1.3
- TypeScript
- Elysia
- Prisma 7 with the PostgreSQL driver adapter
- PostgreSQL 18
- Redis 7 and BullMQ
- WorkOS AuthKit
- Gmail API with `gmail.send` and `gmail.readonly`
- Existing React/Vite frontend

## Workspace

```text
apps/api/              Elysia API
apps/worker/           BullMQ queue/worker foundation
packages/contracts/    Queue and API contracts
packages/database/     Prisma schema, migrations, and SQLite importer
web/                   Existing React dashboard
```

## Migration rules

1. Production stays on Python/SQLite until parity is demonstrated.
2. PostgreSQL imports must run against a consistent SQLite backup, never a copied WAL file.
3. Imports refuse a non-empty target and compare every source/target model count.
4. Existing sender ownership, legacy revoked tokens, quota dates, campaign states, encrypted secrets, and signatures must remain byte-compatible.
5. Quota reservation must use a single PostgreSQL transaction with row/advisory locking; a Prisma read-then-insert sequence is not sufficient.
6. WorkOS login and Google mailbox consent are separate operations so one account can connect multiple senders.
7. Restricted Gmail read scope is not activated publicly until Google verification and security requirements are satisfied.
8. Python remains rollback-capable until production data, API responses, worker behavior, WorkOS login, Gmail consent, send/read, and rollback have all been observed.

## Local foundation

```bash
cp revamp.env.example revamp.env
set -a; . ./revamp.env; set +a

docker compose -f compose.revamp.yml up -d
bun install
bun run db:validate
bun run db:generate
bun run db:migrate
bun run typecheck
bun test apps/api/test/app.test.ts packages/contracts/test/email-job.test.ts
bun --filter @sendplug/database test:integration
bun run dev:api
```

The API binds to `127.0.0.1:3000` by default. During development, Elysia OpenAPI is available at `/internal/docs`; production mode does not register it.

## SQLite importer

```bash
SQLITE_PATH=/secure/path/app.db \
DATABASE_URL=postgresql://... \
bun packages/database/src/import-sqlite.ts --dry-run

SQLITE_PATH=/secure/path/app.db \
DATABASE_URL=postgresql://... \
bun packages/database/src/import-sqlite.ts
```

The importer is intentionally one-shot and refuses a target containing accounts, senders, or campaigns.

## Prisma/Bun caveat

The generated Prisma client runs under Bun. Prisma CLI commands still require Node/npm to be present in development and CI. Production runtime images will contain Bun and the generated client, not the Prisma CLI.

## Evidence completed

- Prisma schema validation and client generation under Bun.
- PostgreSQL 18 initial migration.
- Elysia process connected to PostgreSQL and Redis with a healthy `/health` response.
- Unit tests for Elysia health/config and queue payload limits.
- Prisma transaction/relationship integration test.
- Synthetic SQLite import with exact count parity and non-empty-target refusal.
- Import of a mode-600 backup of the real production SQLite database with exact parity across accounts, users, memberships, senders, three token rows, quota reservations, campaigns, recipients, and suppressions; the local copy was deleted after verification.

## Remaining milestones

- Cross-language Fernet/HMAC golden vectors.
- Account-scoped API parity.
- Atomic PostgreSQL quota reservation.
- BullMQ delivery/campaign workers.
- WorkOS AuthKit and provider-token storage.
- Gmail API send/read.
- Shadow traffic, production cutover, and rollback test.

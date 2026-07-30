# Bun production-candidate architecture

Status: the MVP runtime is integrated on `revamp/mvp-cutover`, but production traffic has not moved. Python/FastAPI with SQLite remains the live/rollback implementation until the operational gates in the cutover runbook pass.

## Runtime

```text
HTTPS reverse proxy
        │ loopback :8100
        ▼
Bun/Elysia API ─────► PostgreSQL 18 (accounts, configuration, delivery state)
  │       │
  │       ├────────► Redis 7 noeviction (sessions, rate limits, BullMQ)
  │       └────────► static React/Vite build
  │
  └─ BullMQ ───────► Bun worker ── SMTP/STARTTLS ──► Gmail
```

Compose provides PostgreSQL, Redis, a Prisma migration job, one API, and one worker. PostgreSQL and Redis are private to the Compose network and use named volumes. The API alone publishes a loopback port for an external TLS proxy. API `/health` checks PostgreSQL and Redis; the worker publishes a Redis heartbeat after checking both dependencies, and its container healthcheck reads that heartbeat.

## Identity and credentials

Email/password signup and sessions are first-party and do not require OAuth. WorkOS AuthKit is an optional account-login path. It is not mailbox authorization. Gmail sender delivery supports App Password SMTP credentials only; no Gmail OAuth/API scope is requested.

App Passwords are encrypted in PostgreSQL and decrypted in trusted API/worker memory. The credential key and API-token pepper are mounted files, not database values. Tokens are sender-bound bearer credentials, returned once and stored as keyed hashes. Account and sender checks are enforced on administrative, send, and status paths.

## HTTP surface

The native API queues through `POST /api/v1/send` and reads sender-scoped status at `GET /api/v1/emails/:messageId`. A deliberately limited Resend-compatible `POST /emails` accepts common text/HTML fields; it is not a complete Resend implementation. Static React assets are built into and served by the API image. Internal OpenAPI routes are absent in production mode.

## Availability and durability boundaries

Redis uses AOF and `noeviction`: memory exhaustion fails work rather than silently evicting queued data. PostgreSQL and Redis volumes survive container replacement, but neither is a backup. Queue acceptance and database state are not one atomic transaction, and public send requests do not provide idempotency; ambiguous client retries can duplicate mail. A worker retry may still fail against Gmail quotas or policy. `sent` means SMTP acceptance only.

This is a single-VM MVP. The VM operator and anyone able to access the proxy, containers, databases, process memory, mounted secrets, logs, or backups are trusted. TLS and host backup/monitoring remain operator responsibilities.

## Migration invariant

The SQLite importer consumes a consistent stopped-writer backup, refuses a non-empty target, imports transactionally, and verifies source/target counts and checksums. The legacy Fernet credential key and token pepper must remain unchanged across import. Python/SQLite artifacts remain intact and runnable until post-cutover observation and rollback/reconciliation decisions are complete.

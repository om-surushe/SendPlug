# Bun MVP cutover runbook

This checklist is for the one-shot Python/SQLite to Bun/PostgreSQL cutover. Archive the release commit, commands, reports, checksums, image IDs, and Nginx configuration.

## Canonical VM layout

- `/home/ubuntu/sendplug` — Bun release checkout
- `/home/ubuntu/sendplug-state` — mode-0700 env, secrets, migration reports, and backups
- `/home/ubuntu/sendplug-python-rollback` — untouched Python/SQLite rollback checkout

Compose uses the fixed project name `sendplug`. Secret paths are absolute and independent of the release folder. Leave all WorkOS variables empty for the first cutover because local-email and WorkOS identities are not automatically linked.

## 1. Backup and rehearsal

1. Pin the reviewed commit in `SENDPLUG_IMAGE_TAG` and record the built image IDs.
2. Back up the Python `.env`, credential key, token pepper, SQLite via its backup API, Redis persistence, Git commit, and Nginx file as one protected set.
3. Import a recent SQLite backup into disposable PostgreSQL. Require `verified: true`, identical counts/checksums, mode-0600 backup, ownership invariants, and non-empty-target refusal.
4. Run legacy Fernet decryption and API-token verification using the unchanged credential key and pepper. Keep WorkOS disabled.
5. Create a PostgreSQL `pg_dump`, restore it into another disposable database, and repeat importer verification.
6. Exercise registration/login, recovery login, sender/token ownership, App Password test, native and Resend sends, status, quotas, suppressions, API/worker health, restart recovery, and overlap token rotation.

## 2. Write fence

At the approved maintenance window:

1. Save `/etc/nginx/sites-enabled/default` under `/home/ubuntu/sendplug-state/backups/`.
2. Drain or account for legacy Celery active/reserved work.
3. Install and validate a temporary Nginx maintenance configuration that returns `503` for every SendPlug route. Do this before stopping either stack so port `8100` cannot become publicly writable when the candidate starts.
4. Stop both the old Bun sidecar and Python Compose stacks without `-v`.
5. Prove that `/auth/register`, `/api/v1/send`, `/emails`, `/workos/`, and SMTP intake reject writes. Confirm no process holds SQLite.
6. Create a new consistent SQLite backup from the stopped volume, store it mode `0600`, and record its checksum. This post-fence file—not the rehearsal snapshot—is the final import source.
7. Record final queue counts and database counts.

Keep the maintenance configuration and write fence until import, restore verification, and loopback candidate read-only smoke tests pass.

## 3. Final import and PostgreSQL backup

PostgreSQL is not host-published. Run the importer through the Compose network:

```bash
state=/home/ubuntu/sendplug-state
ts=$(date -u +%Y%m%dT%H%M%SZ)
cd /home/ubuntu/sendplug

docker compose --env-file "$state/revamp.env" -f compose.revamp.prod.yml up -d postgres redis migrate

# source-final.sqlite3 was created after the write fence. Bun SQLite needs a
# writable private directory for temporary journal metadata; keep the stable
# source itself mode 0400.
mkdir -m 700 -p "$state/migration"
cp "$state/source-final.sqlite3" "$state/migration/source.sqlite3"
chmod 400 "$state/migration/source.sqlite3"
docker compose --env-file "$state/revamp.env" -f compose.revamp.prod.yml run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$state/migration:/migration/source" \
  -v "$state/backups:/migration/backups" \
  -e SQLITE_PATH=/migration/source/source.sqlite3 \
  -e BACKUP_PATH="/migration/backups/sendplug-$ts.sqlite3" \
  migrate bun /app/packages/database/src/import-sqlite.ts \
  | tee "$state/migration-production-$ts.json"

docker compose --env-file "$state/revamp.env" -f compose.revamp.prod.yml exec -T postgres \
  pg_dump -U sendplug -d sendplug -Fc > "$state/backups/postgres-$ts.dump"
chmod 600 "$state/backups/"*
```

Stop on any preflight, import, checksum, ownership, secret, or invariant error. Restore `postgres-$ts.dump` into a disposable database before opening traffic and verify it against `source.sqlite3`.

## 4. Candidate and atomic Nginx cutover

```bash
cd /home/ubuntu/sendplug
docker compose --env-file /home/ubuntu/sendplug-state/revamp.env \
  -f compose.revamp.prod.yml up -d --build
docker compose --env-file /home/ubuntu/sendplug-state/revamp.env \
  -f compose.revamp.prod.yml ps
curl -fsS http://127.0.0.1:8100/health
```

Require healthy PostgreSQL, Redis, API, and worker; successful migration; UI/docs assets; recovery authentication, ownership checks, and a sender credential test. Do not enqueue a delivery while rollback must remain write-free.

Copy the saved Nginx file to a temporary file, replace only root upstreams `127.0.0.1:8000` or `localhost:8000` with `127.0.0.1:8100`, install it atomically, run `nginx -t`, then reload. If validation fails, reinstall the maintenance configuration before any reload. Verify public read-only routes first; while there are still no Bun writes, the saved Python configuration remains the immediate rollback path.

After the public candidate passes, run one controlled send and verify status progression. From that point onward, use the post-write reconciliation rollback procedure below.

## 5. Rollback

Before any Bun write, stop Bun, reinstall and validate the saved Nginx file, start `/home/ubuntu/sendplug-python-rollback`, verify Python health, and reload Nginx. PostgreSQL import data may be removed only when verification still proves it exactly matches SQLite.

After any Bun write, do not run the destructive rollback script. Fence both stacks, preserve PostgreSQL/Redis/SQLite/logs, inventory PostgreSQL-only accounts/tokens/senders/deliveries/quotas, and perform a separately reviewed reconciliation. Never replay an ambiguous send unless duplicate email is acceptable.

## 6. Observation

Keep Python, SQLite, its Redis state, matching secrets, the Nginx backup, migration reports, and PostgreSQL backup through the observation window and at least one verified restore drill. `sent` means Gmail SMTP acceptance, not inbox delivery. Ambiguous SMTP outcomes are terminal and are not retried automatically to avoid duplicates.

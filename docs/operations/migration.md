# SQLite to PostgreSQL migration

This is a one-shot cutover. The importer opens SQLite read-only, refuses a non-empty PostgreSQL target, and writes all rows in one transaction. It verifies deterministic row counts and SHA-256 checksums before committing.

## Preconditions

1. Rehearse with the same release artifact and a recent copy of production data.
2. Apply the current Prisma migrations to a new, empty PostgreSQL database.
3. Stop the legacy API and workers. Do not copy a live WAL database.
4. Keep the legacy credential key and API-token pepper unchanged until all legacy senders and tokens have been exercised after cutover.
5. Ensure the operator can create the backup file and that its parent directory is private. The command refuses to overwrite a backup and forces mode `0600`.

The supported legacy database has SQLite `user_version=0` and the schema created by `src/storage.py`. Preflight rejects missing tables/columns, integrity or foreign-key failures, invalid nulls/types, unsupported enums, malformed scopes/dates, broken ownership, and invalid campaign counters.

## Rehearsal

Use a disposable **empty** PostgreSQL database. `BACKUP_PATH` must not already exist.

```bash
SQLITE_PATH=/secure/snapshot.sqlite3 \
REHEARSAL_DATABASE_URL='postgresql://…/sendplug_rehearsal' \
BACKUP_PATH=/secure/backups/sendplug-rehearsal.sqlite3 \
  scripts/migration/rehearse.sh | tee migration-rehearsal.json
```

The command performs preflight, creates a consistent SQLite backup at mode `0600`, imports transactionally, and independently verifies the target. Save the JSON reports. A successful report has `verified: true`, identical source/target counts and `checksums.overall`, and all invariants `ok`.

Exercise authentication with historical API tokens (including revoked/null-sender history), decrypt a legacy Fernet sender secret with the unchanged credential key, and inspect account ownership and timestamps. Then rehearse rollback:

```bash
SQLITE_PATH=/secure/snapshot.sqlite3 \
DATABASE_URL='postgresql://…/sendplug_rehearsal' \
  scripts/migration/rollback.sh
```

Rollback runs verification first and deletes only a target that exactly matches the SQLite source. Drop/recreate the disposable database afterward.

## Production cutover

Set a maintenance window and record the SQLite and PostgreSQL locations. Stop all legacy writers, then run:

```bash
SQLITE_PATH=/data/sendplug.sqlite3 \
DATABASE_URL='postgresql://…/sendplug' \
BACKUP_PATH="/secure/backups/sendplug-$(date -u +%Y%m%dT%H%M%SZ).sqlite3" \
  scripts/migration/run.sh | tee migration-production.json
```

Do not start new services unless every command succeeds. Archive the report and backup checksum. Confirm the backup permissions with `stat -c '%a %n' "$BACKUP_PATH"` (expected `600`).

## Post-import verification

The run script already performs independent verification. It can be repeated without writing either database:

```bash
SQLITE_PATH=/data/sendplug.sqlite3 DATABASE_URL='postgresql://…/sendplug' \
  bun packages/database/src/import-sqlite.ts --verify-only
```

Also smoke-test one sender per account, a current token, a revoked historical token, a null-sender historical token, campaign recipient state, suppressions, and quota dates. Compare the emitted source and target counts/checksums with rehearsal.

## Rollback

Keep legacy services stopped. Before any new PostgreSQL writes, restore service using the untouched SQLite source or its mode-`0600` backup. To clear the imported PostgreSQL target for a retry:

```bash
SQLITE_PATH=/data/sendplug.sqlite3 DATABASE_URL='postgresql://…/sendplug' \
  scripts/migration/rollback.sh
```

The rollback refuses if PostgreSQL no longer exactly matches the source. If new PostgreSQL writes have occurred, do not run it; preserve both databases and perform a separately reviewed reconciliation/restore.

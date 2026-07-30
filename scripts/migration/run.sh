#!/usr/bin/env bash
set -euo pipefail

: "${SQLITE_PATH:?Set SQLITE_PATH to the stopped legacy SQLite database}"
: "${DATABASE_URL:?Set DATABASE_URL to the empty PostgreSQL database}"
: "${BACKUP_PATH:?Set BACKUP_PATH to a new backup filename}"

if [[ "$BACKUP_PATH" != /* ]]; then
  echo "BACKUP_PATH must be absolute" >&2
  exit 2
fi

bun packages/database/src/import-sqlite.ts --dry-run
bun packages/database/src/import-sqlite.ts
bun packages/database/src/import-sqlite.ts --verify-only

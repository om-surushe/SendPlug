#!/usr/bin/env bash
set -euo pipefail

: "${SQLITE_PATH:?Set SQLITE_PATH to the exact SQLite source used for import}"
: "${DATABASE_URL:?Set DATABASE_URL to the PostgreSQL import target}"

# The importer first proves the target exactly matches the source, so unrelated data is never deleted.
CONFIRM_ROLLBACK=DELETE_IMPORTED_DATA bun packages/database/src/import-sqlite.ts --rollback

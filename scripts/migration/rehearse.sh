#!/usr/bin/env bash
set -euo pipefail

: "${SQLITE_PATH:?Set SQLITE_PATH to a synthetic or production-backup SQLite database}"
: "${REHEARSAL_DATABASE_URL:?Set REHEARSAL_DATABASE_URL to a disposable empty PostgreSQL database}"
: "${BACKUP_PATH:?Set BACKUP_PATH to a new absolute rehearsal backup filename}"

export DATABASE_URL="$REHEARSAL_DATABASE_URL"
"$(dirname "$0")/run.sh"

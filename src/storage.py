"""Durable storage for senders, API tokens, campaigns, and Gmail quotas."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import json
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from cryptography.fernet import Fernet

from .config import Config


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_secret(path: str) -> bytes:
    value = Path(path).read_bytes().strip()
    if not value:
        raise RuntimeError(f"Secret file is empty: {path}")
    return value


def _fernet() -> Fernet:
    return Fernet(_read_secret(Config.CREDENTIAL_KEY_FILE))


def _token_digest(token: str) -> str:
    return hmac.new(
        _read_secret(Config.API_TOKEN_PEPPER_FILE),
        token.encode(),
        hashlib.sha256,
    ).hexdigest()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    Path(Config.DATABASE_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(Config.DATABASE_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


LEGACY_ACCOUNT_ID = "account_legacy_admin"
LEGACY_USER_ID = "user_legacy_admin"


def init_db() -> None:
    lock_path = Path(f"{Config.DATABASE_PATH}.migration.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        _init_db_locked()


def _init_db_locked() -> None:
    now = _now()
    admin_email = Config.ADMIN_EMAIL.lower().strip()
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                provider_subject TEXT NOT NULL,
                email TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_login_at TEXT NOT NULL,
                UNIQUE(provider, provider_subject)
            );

            CREATE TABLE IF NOT EXISTS memberships (
                account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(account_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS senders (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL REFERENCES accounts(id),
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                encrypted_password TEXT NOT NULL,
                smtp_host TEXT NOT NULL DEFAULT 'smtp.gmail.com',
                smtp_port INTEGER NOT NULL DEFAULT 587,
                use_tls INTEGER NOT NULL DEFAULT 1,
                daily_limit INTEGER NOT NULL DEFAULT 400,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS api_tokens (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prefix TEXT NOT NULL UNIQUE,
                token_hash TEXT NOT NULL,
                scopes TEXT NOT NULL,
                sender_id TEXT NOT NULL REFERENCES senders(id),
                created_at TEXT NOT NULL,
                last_used_at TEXT,
                revoked_at TEXT
            );

            CREATE TABLE IF NOT EXISTS quota_reservations (
                message_id TEXT PRIMARY KEY,
                sender_id TEXT NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
                recipient_count INTEGER NOT NULL,
                quota_date TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS campaigns (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sender_id TEXT NOT NULL REFERENCES senders(id),
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                html TEXT,
                status TEXT NOT NULL DEFAULT 'draft',
                total INTEGER NOT NULL DEFAULT 0,
                sent INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS campaign_recipients (
                id TEXT PRIMARY KEY,
                campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                message_id TEXT UNIQUE,
                error TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(campaign_id, email)
            );

            CREATE TABLE IF NOT EXISTS account_suppressions (
                account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(account_id, email)
            );

            CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
                ON campaign_recipients(campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_quota_sender_date
                ON quota_reservations(sender_id, quota_date);
            """
        )
        db.execute(
            "INSERT OR IGNORE INTO accounts (id, name, created_at) VALUES (?, ?, ?)",
            (LEGACY_ACCOUNT_ID, "SendPlug administrator", now),
        )
        db.execute(
            """INSERT OR IGNORE INTO users
               (id, provider, provider_subject, email, name, created_at, last_login_at)
               VALUES (?, 'recovery', ?, ?, 'Administrator', ?, ?)""",
            (LEGACY_USER_ID, admin_email, admin_email, now, now),
        )
        db.execute(
            """INSERT OR IGNORE INTO memberships
               (account_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)""",
            (LEGACY_ACCOUNT_ID, LEGACY_USER_ID, now),
        )

        sender_columns = {row["name"] for row in db.execute("PRAGMA table_info(senders)")}
        if "account_id" not in sender_columns:
            db.execute("ALTER TABLE senders ADD COLUMN account_id TEXT REFERENCES accounts(id)")
        db.execute(
            "UPDATE senders SET account_id = ? WHERE account_id IS NULL",
            (LEGACY_ACCOUNT_ID,),
        )
        db.execute("CREATE INDEX IF NOT EXISTS idx_senders_account ON senders(account_id)")
        db.executescript(
            """
            CREATE TRIGGER IF NOT EXISTS senders_account_required_insert
            BEFORE INSERT ON senders WHEN NEW.account_id IS NULL
            BEGIN SELECT RAISE(ABORT, 'sender account_id is required'); END;
            CREATE TRIGGER IF NOT EXISTS senders_account_required_update
            BEFORE UPDATE OF account_id ON senders WHEN NEW.account_id IS NULL
            BEGIN SELECT RAISE(ABORT, 'sender account_id is required'); END;
            """
        )

        token_columns = {row["name"] for row in db.execute("PRAGMA table_info(api_tokens)")}
        if "sender_id" not in token_columns:
            db.execute("ALTER TABLE api_tokens ADD COLUMN sender_id TEXT REFERENCES senders(id)")
            db.execute(
                "UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE sender_id IS NULL",
                (now,),
            )

        legacy_suppressions = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'suppressions'"
        ).fetchone()
        if legacy_suppressions:
            db.execute(
                """INSERT OR IGNORE INTO account_suppressions
                   (account_id, email, reason, created_at)
                   SELECT ?, email, reason, created_at FROM suppressions""",
                (LEGACY_ACCOUNT_ID,),
            )

        violations = db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError(f"Database ownership migration failed: {violations}")


def legacy_identity() -> dict[str, str]:
    return {
        "user_id": LEGACY_USER_ID,
        "email": Config.ADMIN_EMAIL.lower().strip(),
        "name": "Administrator",
        "account_id": LEGACY_ACCOUNT_ID,
        "account_name": "SendPlug administrator",
        "role": "owner",
    }


def get_or_create_google_identity(
    subject: str, email: str, name: str, allow_create: bool = True
) -> dict[str, str]:
    normalized_email = email.lower().strip()
    now = _now()
    with connect() as db:
        row = db.execute(
            """SELECT u.id AS user_id, u.email, u.name, m.account_id, m.role,
                      a.name AS account_name
               FROM users u JOIN memberships m ON m.user_id = u.id
               JOIN accounts a ON a.id = m.account_id
               WHERE u.provider = 'google' AND u.provider_subject = ?""",
            (subject,),
        ).fetchone()
        if row:
            db.execute(
                "UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?",
                (normalized_email, name.strip() or normalized_email, now, row["user_id"]),
            )
            return dict(row) | {"email": normalized_email, "name": name.strip() or normalized_email}

        is_recovery_admin = hmac.compare_digest(
            normalized_email, Config.ADMIN_EMAIL.lower().strip()
        )
        if not allow_create and not is_recovery_admin:
            raise PermissionError("New account signups are disabled")
        account_id = LEGACY_ACCOUNT_ID if is_recovery_admin else f"account_{uuid.uuid4().hex}"
        user_id = f"user_{uuid.uuid4().hex}"
        if account_id != LEGACY_ACCOUNT_ID:
            account_name = (name.strip() or normalized_email.split("@", 1)[0]) + "'s workspace"
            db.execute(
                "INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)",
                (account_id, account_name, now),
            )
        else:
            account_name = "SendPlug administrator"
        db.execute(
            """INSERT INTO users
               (id, provider, provider_subject, email, name, created_at, last_login_at)
               VALUES (?, 'google', ?, ?, ?, ?, ?)""",
            (user_id, subject, normalized_email, name.strip() or normalized_email, now, now),
        )
        db.execute(
            """INSERT INTO memberships
               (account_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)""",
            (account_id, user_id, now),
        )
        return {
            "user_id": user_id,
            "email": normalized_email,
            "name": name.strip() or normalized_email,
            "account_id": account_id,
            "account_name": account_name,
            "role": "owner",
        }


def _safe_sender(row: sqlite3.Row, usage: int = 0) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "smtp_host": row["smtp_host"],
        "smtp_port": row["smtp_port"],
        "use_tls": bool(row["use_tls"]),
        "daily_limit": row["daily_limit"],
        "sent_today": usage,
        "active": bool(row["active"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "credential_configured": bool(row["encrypted_password"]),
    }


def create_sender(
    account_id: str,
    name: str,
    email: str,
    password: str,
    daily_limit: int = 400,
    smtp_host: str = "smtp.gmail.com",
    smtp_port: int = 587,
    use_tls: bool = True,
) -> dict[str, Any]:
    sender_id = uuid.uuid4().hex
    now = _now()
    encrypted = _fernet().encrypt(password.encode()).decode()
    with connect() as db:
        db.execute(
            """INSERT INTO senders
               (id, account_id, name, email, encrypted_password, smtp_host, smtp_port,
                use_tls, daily_limit, active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
            (
                sender_id,
                account_id,
                name.strip(),
                email.lower().strip(),
                encrypted,
                smtp_host.strip(),
                smtp_port,
                int(use_tls),
                daily_limit,
                now,
                now,
            ),
        )
    return get_sender_safe(account_id, sender_id)


def list_senders(account_id: str) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM senders WHERE account_id = ? ORDER BY created_at DESC",
            (account_id,),
        ).fetchall()
        return [_safe_sender(row, _usage(db, row["id"])) for row in rows]


def get_sender_safe(account_id: str, sender_id: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute(
            "SELECT * FROM senders WHERE id = ? AND account_id = ?",
            (sender_id, account_id),
        ).fetchone()
        if not row:
            raise KeyError("Sender not found")
        return _safe_sender(row, _usage(db, sender_id))


def get_sender(sender_id: Optional[str] = None, account_id: Optional[str] = None) -> dict[str, Any]:
    with connect() as db:
        if sender_id and account_id:
            row = db.execute(
                "SELECT * FROM senders WHERE id = ? AND account_id = ? AND active = 1",
                (sender_id, account_id),
            ).fetchone()
        elif sender_id:
            row = db.execute(
                "SELECT * FROM senders WHERE id = ? AND active = 1", (sender_id,)
            ).fetchone()
        else:
            row = db.execute(
                """SELECT * FROM senders WHERE account_id = ? AND active = 1
                   ORDER BY created_at LIMIT 1""",
                (account_id or LEGACY_ACCOUNT_ID,),
            ).fetchone()
        if not row:
            raise KeyError("No active sender configured")
        result = dict(row)
        result["password"] = _fernet().decrypt(row["encrypted_password"].encode()).decode()
        result["use_tls"] = bool(row["use_tls"])
        result.pop("encrypted_password", None)
        return result


def update_sender(
    account_id: str,
    sender_id: str,
    name: str,
    email: str,
    daily_limit: int,
    app_password: Optional[str] = None,
    active: bool = True,
) -> dict[str, Any]:
    with connect() as db:
        row = db.execute(
            "SELECT encrypted_password FROM senders WHERE id = ? AND account_id = ?",
            (sender_id, account_id),
        ).fetchone()
        if not row:
            raise KeyError("Sender not found")
        encrypted = row["encrypted_password"]
        if app_password:
            encrypted = _fernet().encrypt(app_password.encode()).decode()
        db.execute(
            """UPDATE senders SET name = ?, email = ?, encrypted_password = ?,
               daily_limit = ?, active = ?, updated_at = ? WHERE id = ? AND account_id = ?""",
            (name.strip(), email.lower().strip(), encrypted, daily_limit, int(active), _now(), sender_id, account_id),
        )
    return get_sender_safe(account_id, sender_id)


def delete_sender(account_id: str, sender_id: str) -> None:
    with connect() as db:
        exists = db.execute(
            "SELECT 1 FROM senders WHERE id = ? AND account_id = ?",
            (sender_id, account_id),
        ).fetchone()
        if not exists:
            raise KeyError("Sender not found")
        used = db.execute(
            """SELECT 1 FROM campaigns WHERE sender_id = ?
               UNION SELECT 1 FROM api_tokens WHERE sender_id = ? LIMIT 1""",
            (sender_id, sender_id),
        ).fetchone()
        if used:
            db.execute(
                "UPDATE senders SET active = 0, updated_at = ? WHERE id = ? AND account_id = ?",
                (_now(), sender_id, account_id),
            )
        else:
            db.execute("DELETE FROM senders WHERE id = ? AND account_id = ?", (sender_id, account_id))


def _usage(db: sqlite3.Connection, sender_id: str) -> int:
    row = db.execute(
        """SELECT COALESCE(SUM(recipient_count), 0) AS total
           FROM quota_reservations WHERE sender_id = ? AND quota_date = ?""",
        (sender_id, datetime.now(timezone.utc).date().isoformat()),
    ).fetchone()
    return int(row["total"])


def reserve_quota(sender_id: str, message_id: str, recipient_count: int) -> int:
    today = datetime.now(timezone.utc).date().isoformat()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT sender_id FROM quota_reservations WHERE message_id = ?", (message_id,)
        ).fetchone()
        if existing:
            if existing["sender_id"] != sender_id:
                raise ValueError("Message ID already belongs to another sender")
            return _usage(db, sender_id)
        sender = db.execute(
            "SELECT daily_limit FROM senders WHERE id = ? AND active = 1", (sender_id,)
        ).fetchone()
        if not sender:
            raise KeyError("Sender not found")
        usage = _usage(db, sender_id)
        if usage + recipient_count > sender["daily_limit"]:
            raise ValueError(
                f"Daily Gmail safety limit reached ({usage}/{sender['daily_limit']})"
            )
        db.execute(
            """INSERT INTO quota_reservations
               (message_id, sender_id, recipient_count, quota_date, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (message_id, sender_id, recipient_count, today, _now()),
        )
        return usage + recipient_count


def create_api_token(account_id: str, name: str, scopes: list[str], sender_id: str) -> tuple[dict[str, Any], str]:
    get_sender(sender_id, account_id)
    token_id = uuid.uuid4().hex
    prefix = f"smtp_{token_id[:8]}"
    raw = f"{prefix}_{secrets.token_urlsafe(32)}"
    now = _now()
    scopes = sorted(set(scopes))
    with connect() as db:
        db.execute(
            """INSERT INTO api_tokens
               (id, name, prefix, token_hash, scopes, sender_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (token_id, name.strip(), prefix, _token_digest(raw), json.dumps(scopes), sender_id, now),
        )
    return {
        "id": token_id,
        "name": name.strip(),
        "prefix": prefix,
        "scopes": scopes,
        "sender_id": sender_id,
        "created_at": now,
        "last_used_at": None,
        "revoked_at": None,
    }, raw


def list_api_tokens(account_id: str) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            """SELECT t.id, t.name, t.prefix, t.scopes, t.sender_id, t.created_at,
                      t.last_used_at, t.revoked_at, s.name AS sender_name, s.email AS sender_email
               FROM api_tokens t LEFT JOIN senders s ON s.id = t.sender_id
               WHERE s.account_id = ? OR (t.sender_id IS NULL AND ? = ?)
               ORDER BY t.created_at DESC""",
            (account_id, account_id, LEGACY_ACCOUNT_ID),
        ).fetchall()
        return [dict(row) | {"scopes": json.loads(row["scopes"])} for row in rows]


def update_api_token(account_id: str, token_id: str, name: str, scopes: list[str], sender_id: str) -> dict[str, Any]:
    get_sender(sender_id, account_id)
    with connect() as db:
        row = db.execute(
            """SELECT 1 FROM api_tokens t JOIN senders s ON s.id = t.sender_id
               WHERE t.id = ? AND t.revoked_at IS NULL AND s.account_id = ?""",
            (token_id, account_id),
        ).fetchone()
        if not row:
            raise KeyError("Active API token not found")
        db.execute(
            "UPDATE api_tokens SET name = ?, scopes = ?, sender_id = ? WHERE id = ?",
            (name.strip(), json.dumps(sorted(set(scopes))), sender_id, token_id),
        )
    return next(item for item in list_api_tokens(account_id) if item["id"] == token_id)


def verify_api_token(raw: str) -> Optional[dict[str, Any]]:
    if not raw.startswith("smtp_") or raw.count("_") < 2:
        return None
    prefix = "_".join(raw.split("_", 2)[:2])
    with connect() as db:
        row = db.execute(
            """SELECT t.*, s.account_id FROM api_tokens t
               JOIN senders s ON s.id = t.sender_id
               WHERE t.prefix = ? AND t.revoked_at IS NULL AND s.active = 1""",
            (prefix,),
        ).fetchone()
        if not row or not hmac.compare_digest(row["token_hash"], _token_digest(raw)):
            return None
        db.execute("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", (_now(), row["id"]))
        return {
            "sub": row["name"],
            "purpose": "api_token",
            "token_id": row["id"],
            "sender_id": row["sender_id"],
            "account_id": row["account_id"],
            "scopes": json.loads(row["scopes"]),
        }


def revoke_api_token(account_id: str, token_id: str) -> None:
    with connect() as db:
        result = db.execute(
            """UPDATE api_tokens SET revoked_at = ?
               WHERE id = ? AND revoked_at IS NULL AND sender_id IN
                   (SELECT id FROM senders WHERE account_id = ?)""",
            (_now(), token_id, account_id),
        )
        if not result.rowcount:
            raise KeyError("Active API token not found")


def create_campaign(
    account_id: str,
    name: str,
    sender_id: str,
    subject: str,
    body: str,
    html: Optional[str],
    recipients: list[str],
) -> dict[str, Any]:
    unique = list(dict.fromkeys(address.lower().strip() for address in recipients if address.strip()))
    if not unique:
        raise ValueError("At least one recipient is required")
    if len(unique) > 500:
        raise ValueError("A campaign is limited to 500 recipients")
    get_sender(sender_id, account_id)
    campaign_id = uuid.uuid4().hex
    now = _now()
    with connect() as db:
        db.execute(
            """INSERT INTO campaigns
               (id, name, sender_id, subject, body, html, total, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (campaign_id, name.strip(), sender_id, subject.strip(), body, html, len(unique), now),
        )
        db.executemany(
            """INSERT INTO campaign_recipients
               (id, campaign_id, email, updated_at) VALUES (?, ?, ?, ?)""",
            [(uuid.uuid4().hex, campaign_id, email, now) for email in unique],
        )
    return get_campaign(account_id, campaign_id)


def update_campaign(
    account_id: str,
    campaign_id: str,
    name: str,
    sender_id: str,
    subject: str,
    body: str,
    html: Optional[str],
    recipients: list[str],
) -> dict[str, Any]:
    unique = list(dict.fromkeys(address.lower().strip() for address in recipients if address.strip()))
    if not unique:
        raise ValueError("At least one recipient is required")
    if len(unique) > 500:
        raise ValueError("A campaign is limited to 500 recipients")
    get_sender(sender_id, account_id)
    now = _now()
    with connect() as db:
        row = db.execute(
            """SELECT c.status FROM campaigns c JOIN senders s ON s.id = c.sender_id
               WHERE c.id = ? AND s.account_id = ?""",
            (campaign_id, account_id),
        ).fetchone()
        if not row:
            raise KeyError("Campaign not found")
        if row["status"] != "draft":
            raise ValueError("Only draft campaigns can be edited")
        db.execute(
            """UPDATE campaigns SET name = ?, sender_id = ?, subject = ?, body = ?,
               html = ?, total = ? WHERE id = ?""",
            (name.strip(), sender_id, subject.strip(), body, html, len(unique), campaign_id),
        )
        db.execute("DELETE FROM campaign_recipients WHERE campaign_id = ?", (campaign_id,))
        db.executemany(
            """INSERT INTO campaign_recipients
               (id, campaign_id, email, updated_at) VALUES (?, ?, ?, ?)""",
            [(uuid.uuid4().hex, campaign_id, email, now) for email in unique],
        )
    return get_campaign(account_id, campaign_id)


def delete_campaign(account_id: str, campaign_id: str) -> None:
    with connect() as db:
        row = db.execute(
            """SELECT c.status FROM campaigns c JOIN senders s ON s.id = c.sender_id
               WHERE c.id = ? AND s.account_id = ?""",
            (campaign_id, account_id),
        ).fetchone()
        if not row:
            raise KeyError("Campaign not found")
        if row["status"] != "draft":
            raise ValueError("Only draft campaigns can be deleted")
        db.execute("DELETE FROM campaigns WHERE id = ?", (campaign_id,))


def list_campaigns(account_id: str) -> list[dict[str, Any]]:
    with connect() as db:
        return [dict(row) for row in db.execute(
            """SELECT c.* FROM campaigns c JOIN senders s ON s.id = c.sender_id
               WHERE s.account_id = ? ORDER BY c.created_at DESC""",
            (account_id,),
        ).fetchall()]


def get_campaign(account_id: str, campaign_id: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute(
            """SELECT c.* FROM campaigns c JOIN senders s ON s.id = c.sender_id
               WHERE c.id = ? AND s.account_id = ?""",
            (campaign_id, account_id),
        ).fetchone()
        if not row:
            raise KeyError("Campaign not found")
        result = dict(row)
        result["recipients"] = [dict(item) for item in db.execute(
            "SELECT id, email, status, message_id, error, updated_at "
            "FROM campaign_recipients WHERE campaign_id = ? ORDER BY email",
            (campaign_id,),
        ).fetchall()]
        return result


def start_campaign(account_id: str, campaign_id: str) -> list[dict[str, str]]:
    now = _now()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        campaign = db.execute(
            """SELECT c.status FROM campaigns c JOIN senders s ON s.id = c.sender_id
               WHERE c.id = ? AND s.account_id = ?""",
            (campaign_id, account_id),
        ).fetchone()
        if not campaign:
            raise KeyError("Campaign not found")
        if campaign["status"] != "draft":
            raise ValueError("Campaign has already been started")
        db.execute(
            "UPDATE campaigns SET status = 'queued', started_at = ? WHERE id = ?",
            (now, campaign_id),
        )
        rows = db.execute(
            "SELECT id, email FROM campaign_recipients WHERE campaign_id = ?",
            (campaign_id,),
        ).fetchall()
        queued = []
        for row in rows:
            message_id = f"{uuid.uuid4().hex}@campaign"
            db.execute(
                """UPDATE campaign_recipients
                   SET status = 'queued', message_id = ?, updated_at = ? WHERE id = ?""",
                (message_id, now, row["id"]),
            )
            queued.append({"email": row["email"], "message_id": message_id})
        return queued


def complete_campaign_recipient(message_id: str, state: str, error: Optional[str] = None) -> None:
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT campaign_id, status FROM campaign_recipients WHERE message_id = ?",
            (message_id,),
        ).fetchone()
        if not row or row["status"] in ("sent", "failed"):
            return
        db.execute(
            """UPDATE campaign_recipients SET status = ?, error = ?, updated_at = ?
               WHERE message_id = ?""",
            (state, error, _now(), message_id),
        )
        counts = db.execute(
            """SELECT COUNT(*) AS total,
                      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
                      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                      SUM(CASE WHEN status IN ('sent','failed') THEN 1 ELSE 0 END) AS done
               FROM campaign_recipients WHERE campaign_id = ?""",
            (row["campaign_id"],),
        ).fetchone()
        finished = counts["done"] == counts["total"]
        db.execute(
            """UPDATE campaigns SET status = ?, sent = ?, failed = ?, completed_at = ?
               WHERE id = ?""",
            (
                "completed" if finished else "sending",
                counts["sent"] or 0,
                counts["failed"] or 0,
                _now() if finished else None,
                row["campaign_id"],
            ),
        )


def unsubscribe_token(account_id: str, email: str) -> str:
    normalized = email.lower().strip()
    payload = f"{account_id}\0{normalized}"
    encoded = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    signature = hmac.new(
        _read_secret(Config.API_TOKEN_PEPPER_FILE), payload.encode(), hashlib.sha256
    ).hexdigest()[:32]
    return f"{encoded}.{signature}"


def identity_from_unsubscribe_token(token: str) -> Optional[tuple[str, str]]:
    try:
        encoded, supplied = token.rsplit(".", 1)
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
        if "\0" in payload:
            account_id, email = payload.split("\0", 1)
            expected = unsubscribe_token(account_id, email).rsplit(".", 1)[1]
            return (account_id, email) if hmac.compare_digest(supplied, expected) else None
        # Links sent before account ownership was introduced belong to the migrated admin account.
        email = payload.lower()
        legacy_signature = hmac.new(
            _read_secret(Config.API_TOKEN_PEPPER_FILE), email.encode(), hashlib.sha256
        ).hexdigest()[:32]
        return (LEGACY_ACCOUNT_ID, email) if hmac.compare_digest(supplied, legacy_signature) else None
    except Exception:
        return None


def suppress(account_id: str, email: str, reason: str = "unsubscribed") -> None:
    with connect() as db:
        db.execute(
            """INSERT OR REPLACE INTO account_suppressions
               (account_id, email, reason, created_at) VALUES (?, ?, ?, ?)""",
            (account_id, email.lower().strip(), reason, _now()),
        )


def is_suppressed(account_id: str, email: str) -> bool:
    with connect() as db:
        return bool(db.execute(
            "SELECT 1 FROM account_suppressions WHERE account_id = ? AND email = ?",
            (account_id, email.lower().strip()),
        ).fetchone())


def list_suppressions(account_id: str) -> list[dict[str, Any]]:
    with connect() as db:
        return [dict(row) for row in db.execute(
            """SELECT email, reason, created_at FROM account_suppressions
               WHERE account_id = ? ORDER BY created_at DESC""",
            (account_id,),
        ).fetchall()]


def dashboard(account_id: str) -> dict[str, Any]:
    with connect() as db:
        sender_ids = "SELECT id FROM senders WHERE account_id = ?"
        return {
            "senders": db.execute(
                "SELECT COUNT(*) FROM senders WHERE account_id = ? AND active = 1", (account_id,)
            ).fetchone()[0],
            "tokens": db.execute(
                f"SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL AND sender_id IN ({sender_ids})",
                (account_id,),
            ).fetchone()[0],
            "campaigns": db.execute(
                f"SELECT COUNT(*) FROM campaigns WHERE sender_id IN ({sender_ids})", (account_id,)
            ).fetchone()[0],
            "sent": db.execute(
                f"SELECT COALESCE(SUM(sent), 0) FROM campaigns WHERE sender_id IN ({sender_ids})",
                (account_id,),
            ).fetchone()[0],
            "failed": db.execute(
                f"SELECT COALESCE(SUM(failed), 0) FROM campaigns WHERE sender_id IN ({sender_ids})",
                (account_id,),
            ).fetchone()[0],
            "suppressed": db.execute(
                "SELECT COUNT(*) FROM account_suppressions WHERE account_id = ?", (account_id,)
            ).fetchone()[0],
            "recent_campaigns": [dict(row) for row in db.execute(
                f"""SELECT * FROM campaigns WHERE sender_id IN ({sender_ids})
                    ORDER BY created_at DESC LIMIT 5""",
                (account_id,),
            ).fetchall()],
        }

"""Durable storage for senders, API tokens, campaigns, and Gmail quotas."""
from __future__ import annotations

import base64
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


def init_db() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS senders (
                id TEXT PRIMARY KEY,
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

            CREATE TABLE IF NOT EXISTS suppressions (
                email TEXT PRIMARY KEY,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
                ON campaign_recipients(campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_quota_sender_date
                ON quota_reservations(sender_id, quota_date);
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(api_tokens)")}
        if "sender_id" not in columns:
            db.execute("ALTER TABLE api_tokens ADD COLUMN sender_id TEXT REFERENCES senders(id)")
            # Existing tokens had access to every sender. Revoke them rather than guess ownership.
            db.execute(
                "UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE sender_id IS NULL",
                (_now(),),
            )


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
               (id, name, email, encrypted_password, smtp_host, smtp_port,
                use_tls, daily_limit, active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
            (
                sender_id,
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
    return get_sender_safe(sender_id)


def list_senders() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM senders ORDER BY created_at DESC").fetchall()
        return [_safe_sender(row, _usage(db, row["id"])) for row in rows]


def get_sender_safe(sender_id: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT * FROM senders WHERE id = ?", (sender_id,)).fetchone()
        if not row:
            raise KeyError("Sender not found")
        return _safe_sender(row, _usage(db, sender_id))


def get_sender(sender_id: Optional[str] = None) -> dict[str, Any]:
    with connect() as db:
        if sender_id:
            row = db.execute(
                "SELECT * FROM senders WHERE id = ? AND active = 1", (sender_id,)
            ).fetchone()
        else:
            row = db.execute(
                "SELECT * FROM senders WHERE active = 1 ORDER BY created_at LIMIT 1"
            ).fetchone()
        if not row:
            raise KeyError("No active sender configured")
        result = dict(row)
        result["password"] = _fernet().decrypt(row["encrypted_password"].encode()).decode()
        result["use_tls"] = bool(row["use_tls"])
        result.pop("encrypted_password", None)
        return result


def update_sender(
    sender_id: str,
    name: str,
    email: str,
    daily_limit: int,
    app_password: Optional[str] = None,
    active: bool = True,
) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT encrypted_password FROM senders WHERE id = ?", (sender_id,)).fetchone()
        if not row:
            raise KeyError("Sender not found")
        encrypted = row["encrypted_password"]
        if app_password:
            encrypted = _fernet().encrypt(app_password.encode()).decode()
        db.execute(
            """UPDATE senders SET name = ?, email = ?, encrypted_password = ?,
               daily_limit = ?, active = ?, updated_at = ? WHERE id = ?""",
            (name.strip(), email.lower().strip(), encrypted, daily_limit, int(active), _now(), sender_id),
        )
    return get_sender_safe(sender_id)


def delete_sender(sender_id: str) -> None:
    with connect() as db:
        exists = db.execute("SELECT 1 FROM senders WHERE id = ?", (sender_id,)).fetchone()
        if not exists:
            raise KeyError("Sender not found")
        used = db.execute(
            """SELECT 1 FROM campaigns WHERE sender_id = ?
               UNION SELECT 1 FROM api_tokens WHERE sender_id = ? LIMIT 1""",
            (sender_id, sender_id),
        ).fetchone()
        if used:
            db.execute("UPDATE senders SET active = 0, updated_at = ? WHERE id = ?", (_now(), sender_id))
        else:
            db.execute("DELETE FROM senders WHERE id = ?", (sender_id,))


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
            "SELECT 1 FROM quota_reservations WHERE message_id = ?", (message_id,)
        ).fetchone()
        if existing:
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


def create_api_token(name: str, scopes: list[str], sender_id: str) -> tuple[dict[str, Any], str]:
    get_sender(sender_id)
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


def list_api_tokens() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            """SELECT t.id, t.name, t.prefix, t.scopes, t.sender_id, t.created_at,
                      t.last_used_at, t.revoked_at, s.name AS sender_name, s.email AS sender_email
               FROM api_tokens t LEFT JOIN senders s ON s.id = t.sender_id
               ORDER BY t.created_at DESC"""
        ).fetchall()
        return [dict(row) | {"scopes": json.loads(row["scopes"])} for row in rows]


def update_api_token(token_id: str, name: str, scopes: list[str], sender_id: str) -> dict[str, Any]:
    get_sender(sender_id)
    with connect() as db:
        row = db.execute(
            "SELECT 1 FROM api_tokens WHERE id = ? AND revoked_at IS NULL", (token_id,)
        ).fetchone()
        if not row:
            raise KeyError("Active API token not found")
        db.execute(
            "UPDATE api_tokens SET name = ?, scopes = ?, sender_id = ? WHERE id = ?",
            (name.strip(), json.dumps(sorted(set(scopes))), sender_id, token_id),
        )
    return next(item for item in list_api_tokens() if item["id"] == token_id)


def verify_api_token(raw: str) -> Optional[dict[str, Any]]:
    if not raw.startswith("smtp_") or raw.count("_") < 2:
        return None
    prefix = "_".join(raw.split("_", 2)[:2])
    with connect() as db:
        row = db.execute(
            "SELECT * FROM api_tokens WHERE prefix = ? AND revoked_at IS NULL", (prefix,)
        ).fetchone()
        if not row or not hmac.compare_digest(row["token_hash"], _token_digest(raw)):
            return None
        db.execute("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", (_now(), row["id"]))
        return {
            "sub": row["name"],
            "purpose": "api_token",
            "token_id": row["id"],
            "sender_id": row["sender_id"],
            "scopes": json.loads(row["scopes"]),
        }


def revoke_api_token(token_id: str) -> None:
    with connect() as db:
        result = db.execute(
            "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (_now(), token_id),
        )
        if not result.rowcount:
            raise KeyError("Active API token not found")


def create_campaign(
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
    get_sender(sender_id)
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
    return get_campaign(campaign_id)


def update_campaign(
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
    get_sender(sender_id)
    now = _now()
    with connect() as db:
        row = db.execute("SELECT status FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
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
    return get_campaign(campaign_id)


def delete_campaign(campaign_id: str) -> None:
    with connect() as db:
        row = db.execute("SELECT status FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
        if not row:
            raise KeyError("Campaign not found")
        if row["status"] != "draft":
            raise ValueError("Only draft campaigns can be deleted")
        db.execute("DELETE FROM campaigns WHERE id = ?", (campaign_id,))


def list_campaigns() -> list[dict[str, Any]]:
    with connect() as db:
        return [dict(row) for row in db.execute(
            "SELECT * FROM campaigns ORDER BY created_at DESC"
        ).fetchall()]


def get_campaign(campaign_id: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
        if not row:
            raise KeyError("Campaign not found")
        result = dict(row)
        result["recipients"] = [dict(item) for item in db.execute(
            "SELECT id, email, status, message_id, error, updated_at "
            "FROM campaign_recipients WHERE campaign_id = ? ORDER BY email",
            (campaign_id,),
        ).fetchall()]
        return result


def start_campaign(campaign_id: str) -> list[dict[str, str]]:
    now = _now()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        campaign = db.execute(
            "SELECT status FROM campaigns WHERE id = ?", (campaign_id,)
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


def unsubscribe_token(email: str) -> str:
    normalized = email.lower().strip()
    encoded = base64.urlsafe_b64encode(normalized.encode()).decode().rstrip("=")
    signature = hmac.new(
        _read_secret(Config.API_TOKEN_PEPPER_FILE), normalized.encode(), hashlib.sha256
    ).hexdigest()[:32]
    return f"{encoded}.{signature}"


def email_from_unsubscribe_token(token: str) -> Optional[str]:
    try:
        encoded, supplied = token.rsplit(".", 1)
        email = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode().lower()
        expected = unsubscribe_token(email).rsplit(".", 1)[1]
        return email if hmac.compare_digest(supplied, expected) else None
    except Exception:
        return None


def suppress(email: str, reason: str = "unsubscribed") -> None:
    with connect() as db:
        db.execute(
            "INSERT OR REPLACE INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)",
            (email.lower().strip(), reason, _now()),
        )


def is_suppressed(email: str) -> bool:
    with connect() as db:
        return bool(db.execute(
            "SELECT 1 FROM suppressions WHERE email = ?", (email.lower().strip(),)
        ).fetchone())


def list_suppressions() -> list[dict[str, Any]]:
    with connect() as db:
        return [dict(row) for row in db.execute(
            "SELECT * FROM suppressions ORDER BY created_at DESC"
        ).fetchall()]


def dashboard() -> dict[str, Any]:
    with connect() as db:
        return {
            "senders": db.execute("SELECT COUNT(*) FROM senders WHERE active = 1").fetchone()[0],
            "tokens": db.execute("SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL").fetchone()[0],
            "campaigns": db.execute("SELECT COUNT(*) FROM campaigns").fetchone()[0],
            "sent": db.execute("SELECT COALESCE(SUM(sent), 0) FROM campaigns").fetchone()[0],
            "failed": db.execute("SELECT COALESCE(SUM(failed), 0) FROM campaigns").fetchone()[0],
            "suppressed": db.execute("SELECT COUNT(*) FROM suppressions").fetchone()[0],
            "recent_campaigns": [dict(row) for row in db.execute(
                "SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 5"
            ).fetchall()],
        }

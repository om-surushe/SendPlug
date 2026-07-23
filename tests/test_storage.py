import asyncio
import base64
import hashlib
import hmac
import sqlite3
from datetime import datetime, timezone
from multiprocessing import Process

import pytest
from fastapi.security import HTTPAuthorizationCredentials

from src.config import Config
from src import storage
from src.auth import require_scope, verify_token

ACCOUNT = storage.LEGACY_ACCOUNT_ID


def fresh_db(tmp_path):
    Config.DATABASE_PATH = str(tmp_path / "app.db")
    storage.init_db()


def init_database(path):
    Config.DATABASE_PATH = path
    storage.init_db()


def test_existing_unscoped_tokens_are_revoked_during_migration(tmp_path):
    Config.DATABASE_PATH = str(tmp_path / "legacy.db")
    with sqlite3.connect(Config.DATABASE_PATH) as db:
        db.execute(
            """CREATE TABLE api_tokens (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE,
               token_hash TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL,
               last_used_at TEXT, revoked_at TEXT)"""
        )
        db.execute(
            "INSERT INTO api_tokens VALUES ('1','legacy','smtp_old','hash','[]','now',NULL,NULL)"
        )
    storage.init_db()
    with storage.connect() as db:
        row = db.execute("SELECT sender_id, revoked_at FROM api_tokens").fetchone()
    assert row["sender_id"] is None
    assert row["revoked_at"] is not None


def test_legacy_data_is_backfilled_to_recovery_account(tmp_path):
    Config.DATABASE_PATH = str(tmp_path / "legacy.db")
    with sqlite3.connect(Config.DATABASE_PATH) as db:
        db.execute(
            """CREATE TABLE senders (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
               encrypted_password TEXT NOT NULL, smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL,
               use_tls INTEGER NOT NULL, daily_limit INTEGER NOT NULL, active INTEGER NOT NULL,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
        )
        db.execute(
            """INSERT INTO senders VALUES
               ('sender-1','Primary','sender@example.com','encrypted','smtp.gmail.com',587,1,400,1,'now','now')"""
        )
        db.execute(
            "CREATE TABLE suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        db.execute("INSERT INTO suppressions VALUES ('person@example.com','unsubscribed','now')")
    storage.init_db()
    with storage.connect() as db:
        sender = db.execute("SELECT account_id FROM senders WHERE id = 'sender-1'").fetchone()
        suppression = db.execute("SELECT account_id FROM account_suppressions").fetchone()
        violations = db.execute("PRAGMA foreign_key_check").fetchall()
    assert sender["account_id"] == ACCOUNT
    assert suppression["account_id"] == ACCOUNT
    assert violations == []


def test_google_signup_policy_preserves_recovery_admin(tmp_path):
    fresh_db(tmp_path)
    with pytest.raises(PermissionError):
        storage.get_or_create_google_identity(
            "blocked-subject", "blocked@example.com", "Blocked", allow_create=False
        )
    admin = storage.get_or_create_google_identity(
        "admin-google-subject", Config.ADMIN_EMAIL, "Administrator", allow_create=False
    )
    assert admin["account_id"] == ACCOUNT


def test_database_initialization_is_concurrency_safe(tmp_path):
    path = str(tmp_path / "concurrent.db")
    processes = [Process(target=init_database, args=(path,)) for _ in range(4)]
    for process in processes:
        process.start()
    for process in processes:
        process.join(10)
    assert [process.exitcode for process in processes] == [0, 0, 0, 0]
    Config.DATABASE_PATH = path
    storage.init_db()
    with storage.connect() as db:
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 1


def test_sender_credentials_are_encrypted(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender(ACCOUNT, "Primary", "sender@example.com", "abcdefghijklmnop", 400)
    assert sender["credential_configured"] is True
    assert storage.get_sender(sender["id"], ACCOUNT)["password"] == "abcdefghijklmnop"
    assert b"abcdefghijklmnop" not in (tmp_path / "app.db").read_bytes()


def test_api_token_is_sender_scoped_hashed_editable_and_revocable(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender(ACCOUNT, "Primary", "sender@example.com", "abcdefghijklmnop")
    record, raw = storage.create_api_token(ACCOUNT, "app", ["send", "status"], sender["id"])
    assert raw.startswith(record["prefix"])
    verified = storage.verify_api_token(raw)
    authenticated = asyncio.run(
        verify_token(HTTPAuthorizationCredentials(scheme="Bearer", credentials=raw))
    )
    assert authenticated["token_id"] == record["id"]
    assert verified["sender_id"] == sender["id"]
    assert verified["account_id"] == ACCOUNT
    assert verified["scopes"] == ["send", "status"]
    assert require_scope("send")(verified) == verified
    updated = storage.update_api_token(ACCOUNT, record["id"], "renamed", ["status"], sender["id"])
    assert (updated["name"], updated["scopes"], updated["sender_email"]) == (
        "renamed", ["status"], "sender@example.com"
    )
    assert raw.encode() not in (tmp_path / "app.db").read_bytes()
    storage.revoke_api_token(ACCOUNT, record["id"])
    assert storage.verify_api_token(raw) is None


def test_sender_can_be_updated_without_replacing_password(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender(ACCOUNT, "Primary", "sender@example.com", "abcdefghijklmnop")
    updated = storage.update_sender(ACCOUNT, sender["id"], "Renamed", "new-sender@example.com", 350)
    assert (updated["name"], updated["email"], updated["daily_limit"]) == (
        "Renamed", "new-sender@example.com", 350
    )
    assert storage.get_sender(sender["id"], ACCOUNT)["password"] == "abcdefghijklmnop"


def test_quota_is_atomic_and_retry_idempotent(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender(ACCOUNT, "Primary", "sender@example.com", "abcdefghijklmnop", 2)
    assert storage.reserve_quota(sender["id"], "message-1", 1) == 1
    assert storage.reserve_quota(sender["id"], "message-1", 1) == 1
    assert storage.reserve_quota(sender["id"], "message-2", 1) == 2
    with pytest.raises(ValueError, match="limit"):
        storage.reserve_quota(sender["id"], "message-3", 1)


def test_quota_uses_utc_calendar_day(tmp_path, monkeypatch):
    fresh_db(tmp_path)
    sender = storage.create_sender(ACCOUNT, "Primary", "sender@example.com", "abcdefghijklmnop", 2)
    real_datetime = datetime
    seen_timezones = []

    class Clock:
        @classmethod
        def now(cls, tz=None):
            seen_timezones.append(tz)
            return real_datetime(2026, 7, 23, 23, 59, tzinfo=timezone.utc)

    monkeypatch.setattr(storage, "datetime", Clock)
    storage.reserve_quota(sender["id"], "message-utc", 1)
    assert seen_timezones and all(tz is timezone.utc for tz in seen_timezones)


def test_unsubscribe_token_and_suppression_are_account_scoped(tmp_path):
    fresh_db(tmp_path)
    other = storage.get_or_create_google_identity("google-2", "other@example.com", "Other")
    token = storage.unsubscribe_token(ACCOUNT, "person@example.com")
    assert storage.identity_from_unsubscribe_token(token) == (ACCOUNT, "person@example.com")
    assert storage.identity_from_unsubscribe_token(token + "x") is None
    legacy_email = "legacy@example.com"
    encoded = base64.urlsafe_b64encode(legacy_email.encode()).decode().rstrip("=")
    signature = hmac.new(
        storage._read_secret(Config.API_TOKEN_PEPPER_FILE),
        legacy_email.encode(),
        hashlib.sha256,
    ).hexdigest()[:32]
    assert storage.identity_from_unsubscribe_token(f"{encoded}.{signature}") == (
        ACCOUNT, legacy_email
    )
    storage.suppress(ACCOUNT, "person@example.com")
    assert storage.is_suppressed(ACCOUNT, "PERSON@example.com") is True
    assert storage.is_suppressed(other["account_id"], "person@example.com") is False


def test_campaign_deduplicates_and_aggregates(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender(ACCOUNT, "Primary", "sender@example.com", "abcdefghijklmnop")
    campaign = storage.create_campaign(
        ACCOUNT, "Launch", sender["id"], "Hello", "Body", None,
        ["one@example.com", "one@example.com", "two@example.com"],
    )
    assert campaign["total"] == 2
    queued = storage.start_campaign(ACCOUNT, campaign["id"])
    storage.complete_campaign_recipient(queued[0]["message_id"], "sent")
    storage.complete_campaign_recipient(queued[1]["message_id"], "failed", "bad address")
    complete = storage.get_campaign(ACCOUNT, campaign["id"])
    assert (complete["status"], complete["sent"], complete["failed"]) == ("completed", 1, 1)


def test_draft_campaign_can_be_updated_and_deleted(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender(ACCOUNT, "Primary", "sender@example.com", "abcdefghijklmnop")
    campaign = storage.create_campaign(
        ACCOUNT, "Draft", sender["id"], "Old", "Body", None, ["one@example.com"]
    )
    updated = storage.update_campaign(
        ACCOUNT, campaign["id"], "Updated", sender["id"], "New", "New body", None,
        ["two@example.com", "three@example.com"],
    )
    assert (updated["name"], updated["subject"], updated["total"]) == ("Updated", "New", 2)
    storage.delete_campaign(ACCOUNT, campaign["id"])
    assert storage.list_campaigns(ACCOUNT) == []


def test_cross_account_admin_operations_are_denied(tmp_path):
    fresh_db(tmp_path)
    other = storage.get_or_create_google_identity("google-3", "founder@example.com", "Founder")
    other_account = other["account_id"]
    legacy_sender = storage.create_sender(ACCOUNT, "Legacy", "legacy@example.com", "abcdefghijklmnop")
    other_sender = storage.create_sender(other_account, "Other", "other@example.com", "abcdefghijklmnop")
    campaign = storage.create_campaign(
        ACCOUNT, "Private", legacy_sender["id"], "Secret", "Body", None, ["one@example.com"]
    )
    token, _ = storage.create_api_token(ACCOUNT, "private", ["send"], legacy_sender["id"])

    assert [item["id"] for item in storage.list_senders(other_account)] == [other_sender["id"]]
    assert storage.list_campaigns(other_account) == []
    assert storage.list_api_tokens(other_account) == []
    assert storage.dashboard(other_account)["senders"] == 1
    with pytest.raises(KeyError):
        storage.get_sender_safe(other_account, legacy_sender["id"])
    with pytest.raises(KeyError):
        storage.create_api_token(other_account, "cross", ["send"], legacy_sender["id"])
    with pytest.raises(KeyError):
        storage.update_api_token(other_account, token["id"], "cross", ["send"], other_sender["id"])
    with pytest.raises(KeyError):
        storage.get_campaign(other_account, campaign["id"])
    with pytest.raises(KeyError):
        storage.delete_campaign(other_account, campaign["id"])

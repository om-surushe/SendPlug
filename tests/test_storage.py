import sqlite3

from src.config import Config
from src import storage


def fresh_db(tmp_path):
    Config.DATABASE_PATH = str(tmp_path / "app.db")
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


def test_sender_credentials_are_encrypted(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender("Primary", "sender@example.com", "abcdefghijklmnop", 400)
    assert sender["credential_configured"] is True
    assert storage.get_sender(sender["id"])["password"] == "abcdefghijklmnop"
    assert b"abcdefghijklmnop" not in (tmp_path / "app.db").read_bytes()


def test_api_token_is_sender_scoped_hashed_editable_and_revocable(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender("Primary", "sender@example.com", "abcdefghijklmnop")
    record, raw = storage.create_api_token("app", ["send", "status"], sender["id"])
    assert raw.startswith(record["prefix"])
    verified = storage.verify_api_token(raw)
    assert verified["sender_id"] == sender["id"]
    assert verified["scopes"] == ["send", "status"]
    updated = storage.update_api_token(record["id"], "renamed", ["status"], sender["id"])
    assert (updated["name"], updated["scopes"], updated["sender_email"]) == (
        "renamed", ["status"], "sender@example.com"
    )
    assert raw.encode() not in (tmp_path / "app.db").read_bytes()
    storage.revoke_api_token(record["id"])
    assert storage.verify_api_token(raw) is None


def test_sender_can_be_updated_without_replacing_password(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender("Primary", "sender@example.com", "abcdefghijklmnop")
    updated = storage.update_sender(sender["id"], "Renamed", "new-sender@example.com", 350)
    assert (updated["name"], updated["email"], updated["daily_limit"]) == (
        "Renamed", "new-sender@example.com", 350
    )
    assert storage.get_sender(sender["id"])["password"] == "abcdefghijklmnop"


def test_quota_is_atomic_and_retry_idempotent(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender("Primary", "sender@example.com", "abcdefghijklmnop", 2)
    assert storage.reserve_quota(sender["id"], "message-1", 1) == 1
    assert storage.reserve_quota(sender["id"], "message-1", 1) == 1
    assert storage.reserve_quota(sender["id"], "message-2", 1) == 2
    try:
        storage.reserve_quota(sender["id"], "message-3", 1)
    except ValueError as exc:
        assert "limit" in str(exc).lower()
    else:
        raise AssertionError("quota overflow was accepted")


def test_unsubscribe_token_and_suppression(tmp_path):
    fresh_db(tmp_path)
    token = storage.unsubscribe_token("person@example.com")
    assert storage.email_from_unsubscribe_token(token) == "person@example.com"
    assert storage.email_from_unsubscribe_token(token + "x") is None
    storage.suppress("person@example.com")
    assert storage.is_suppressed("PERSON@example.com") is True


def test_campaign_deduplicates_and_aggregates(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender("Primary", "sender@example.com", "abcdefghijklmnop")
    campaign = storage.create_campaign(
        "Launch", sender["id"], "Hello", "Body", None,
        ["one@example.com", "one@example.com", "two@example.com"],
    )
    assert campaign["total"] == 2
    queued = storage.start_campaign(campaign["id"])
    storage.complete_campaign_recipient(queued[0]["message_id"], "sent")
    storage.complete_campaign_recipient(queued[1]["message_id"], "failed", "bad address")
    complete = storage.get_campaign(campaign["id"])
    assert (complete["status"], complete["sent"], complete["failed"]) == ("completed", 1, 1)


def test_draft_campaign_can_be_updated_and_deleted(tmp_path):
    fresh_db(tmp_path)
    sender = storage.create_sender("Primary", "sender@example.com", "abcdefghijklmnop")
    campaign = storage.create_campaign("Draft", sender["id"], "Old", "Body", None, ["one@example.com"])
    updated = storage.update_campaign(
        campaign["id"], "Updated", sender["id"], "New", "New body", None,
        ["two@example.com", "three@example.com"],
    )
    assert (updated["name"], updated["subject"], updated["total"]) == ("Updated", "New", 2)
    storage.delete_campaign(campaign["id"])
    assert storage.list_campaigns() == []

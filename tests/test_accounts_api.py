import pytest
from fastapi import HTTPException
from starlette.requests import Request

from src import status_store, storage
from src.api import (
    TokenCreate,
    _client_ip,
    add_token,
    auth_config,
    current_account,
    dashboard,
    get_email_status,
    google_login,
    remove_sender,
    senders,
)
from src.config import Config


class FakeRedis:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def setex(self, key, _ttl, value):
        self.values[key] = value


def test_account_api_enforces_ownership(tmp_path):
    Config.DATABASE_PATH = str(tmp_path / "accounts.db")
    storage.init_db()
    owner_a = storage.get_or_create_google_identity("subject-a", "a@example.com", "Founder A")
    owner_b = storage.get_or_create_google_identity("subject-b", "b@example.com", "Founder B")
    sender_a = storage.create_sender(
        owner_a["account_id"], "A sender", "sender-a@example.com", "abcdefghijklmnop"
    )
    sender_b = storage.create_sender(
        owner_b["account_id"], "B sender", "sender-b@example.com", "abcdefghijklmnop"
    )

    assert [item["id"] for item in senders(owner_b)] == [sender_b["id"]]
    with pytest.raises(HTTPException) as denied_delete:
        remove_sender(sender_a["id"], owner_b)
    assert denied_delete.value.status_code == 404
    assert storage.get_sender_safe(owner_a["account_id"], sender_a["id"])["active"] is True

    with pytest.raises(HTTPException) as denied_token:
        add_token(TokenCreate(name="cross", sender_id=sender_a["id"], scopes=["send"]), owner_b)
    assert denied_token.value.status_code == 400
    assert dashboard(owner_b)["senders"] == 1


def test_delivery_status_is_account_scoped(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(status_store, "get_redis", lambda: redis)
    status_store.create_status("message-owned", ["recipient@example.com"], "Hello", "sender-a", "account-a")
    owner_a = {"sub": "a@example.com", "purpose": "account_session", "account_id": "account-a"}
    owner_b = {"sub": "b@example.com", "purpose": "account_session", "account_id": "account-b"}
    assert "account_id" not in get_email_status("message-owned", owner_a)
    with pytest.raises(HTTPException) as hidden:
        get_email_status("message-owned", owner_b)
    assert hidden.value.status_code == 404


def test_session_reports_account_identity(tmp_path):
    Config.DATABASE_PATH = str(tmp_path / "identity.db")
    storage.init_db()
    owner = storage.get_or_create_google_identity("subject-owner", "owner@example.com", "Owner")
    assert current_account(owner) == {
        "email": "owner@example.com",
        "account_id": owner["account_id"],
        "account_name": "Owner's workspace",
        "role": "owner",
        "recovery": False,
    }


def test_login_rate_limit_uses_trusted_proxy_real_ip():
    trusted = Request(
        {"type": "http", "client": ("172.21.0.1", 1234), "headers": [(b"x-real-ip", b"203.0.113.8")]}
    )
    untrusted = Request(
        {"type": "http", "client": ("8.8.8.8", 1234), "headers": [(b"x-real-ip", b"203.0.113.9")]}
    )
    assert _client_ip(trusted) == "203.0.113.8"
    assert _client_ip(untrusted) == "8.8.8.8"


def test_google_sign_in_is_optional():
    assert auth_config()["google"] is False
    with pytest.raises(HTTPException) as unavailable:
        google_login(Request({"type": "http", "query_string": b"", "headers": []}))
    assert unavailable.value.status_code == 503

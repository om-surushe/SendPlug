from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from src import status_store, storage
from src.api import Config, SenderCreate, _normalize_app_password, _require_gmail_sender, _send_bursts, app, launch_campaign, send_email_task
from src.tasks import _create_smtp_connection


class FakeRedis:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def setex(self, key, _ttl, value):
        self.values[key] = value

    def incr(self, key):
        self.values[key] = int(self.values.get(key, 0)) + 1
        return self.values[key]

    def expire(self, _key, _ttl):
        return True

    def delete(self, key):
        self.values.pop(key, None)


@pytest.fixture
def send_api(tmp_path, monkeypatch):
    Config.DATABASE_PATH = str(tmp_path / "send-api.db")
    storage.init_db()
    owner = storage.get_or_create_google_identity("send-api-owner", "owner@example.com", "Owner")
    sender = storage.create_sender(
        owner["account_id"], "Primary", "sender@example.com", "abcdefghijklmnop"
    )
    send_token = storage.create_api_token(
        owner["account_id"], "send", ["send", "status"], sender["id"]
    )[1]
    status_token = storage.create_api_token(
        owner["account_id"], "status", ["status"], sender["id"]
    )[1]
    queued = []
    redis = FakeRedis()
    monkeypatch.setattr(status_store, "get_redis", lambda: redis)
    monkeypatch.setattr(send_email_task, "delay", lambda *args: queued.append(args))
    _send_bursts.clear()
    return TestClient(app), sender, send_token, status_token, queued


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def payload(**changes):
    body = {
        "from": "SendPlug <sender@example.com>",
        "to": "Customer <customer@example.net>",
        "subject": "Welcome",
        "text": "Hello",
    }
    return body | changes


def test_local_registration_and_login_without_external_identity(send_api, monkeypatch):
    client, _, _, _, _ = send_api
    monkeypatch.setattr(Config, "AUTH_SIGNUPS_ENABLED", True)

    registered = client.post(
        "/auth/register",
        json={"email": "new@example.com", "password": "correct-horse-battery", "name": "New User"},
    )
    assert registered.status_code == 201
    token = registered.json()["token"]
    me = client.get("/auth/me", headers=auth(token))
    assert me.status_code == 200
    assert me.json()["email"] == "new@example.com"
    assert me.json()["recovery"] is False

    login = client.post(
        "/auth/login",
        json={"email": "new@example.com", "password": "correct-horse-battery"},
    )
    assert login.status_code == 200
    with storage.connect() as db:
        stored = db.execute("SELECT password_hash FROM users WHERE email = ?", ("new@example.com",)).fetchone()[0]
    assert "correct-horse-battery" not in stored
    assert stored.startswith("scrypt$")


def test_registration_can_be_disabled(send_api, monkeypatch):
    client, _, _, _, _ = send_api
    monkeypatch.setattr(Config, "AUTH_SIGNUPS_ENABLED", False)
    response = client.post(
        "/auth/register",
        json={"email": "closed@example.com", "password": "correct-horse-battery"},
    )
    assert response.status_code == 403


def test_resend_compatibility_response_and_mapping(send_api):
    client, sender, token, _, queued = send_api
    response = client.post(
        "/emails",
        headers=auth(token),
        json=payload(cc="Copy <copy@example.net>", bcc=["blind@example.net"], html="<p>Hello</p>"),
    )

    assert response.status_code == 200
    assert list(response.json()) == ["id"]
    assert response.json()["id"].endswith("@sendplug")
    assert queued == [
        (
            response.json()["id"],
            {
                "to": ["customer@example.net"],
                "cc": ["copy@example.net"],
                "bcc": ["blind@example.net"],
                "subject": "Welcome",
                "body": "Hello",
                "html": "<p>Hello</p>",
            },
            sender["id"],
            None,
        )
    ]


def test_resend_rejects_sender_mismatch_and_multiple_primary_recipients(send_api):
    client, _, token, _, queued = send_api
    mismatch = client.post("/emails", headers=auth(token), json=payload(**{"from": "other@example.com"}))
    multiple = client.post(
        "/emails",
        headers=auth(token),
        json=payload(to=["one@example.net", "two@example.net"]),
    )

    assert mismatch.status_code == 403
    assert multiple.status_code == 422
    assert queued == []


def test_resend_requires_auth_and_send_scope(send_api):
    client, _, _, status_token, _ = send_api
    assert client.post("/emails", json=payload()).status_code == 401
    denied = client.post("/emails", headers=auth(status_token), json=payload())
    assert denied.status_code == 403
    assert "send" in denied.json()["detail"]


def test_per_token_send_burst_returns_retry_after(send_api, monkeypatch):
    client, _, token, _, queued = send_api
    monkeypatch.setattr(Config, "SEND_BURST_LIMIT", 1)
    monkeypatch.setattr(Config, "SEND_BURST_WINDOW_SECONDS", 60)

    assert client.post("/emails", headers=auth(token), json=payload()).status_code == 200
    limited = client.post("/emails", headers=auth(token), json=payload())

    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"
    assert len(queued) == 1


def test_sender_create_rejects_custom_smtp_destination():
    with pytest.raises(ValidationError):
        SenderCreate(
            name="Blocked",
            email="sender@example.com",
            app_password="abcdefghijklmnop",
            smtp_host="127.0.0.1",
        )


def test_app_password_is_normalized_and_requires_16_characters():
    assert _normalize_app_password("abcd efgh ijkl mnop") == "abcdefghijklmnop"
    with pytest.raises(HTTPException) as exc:
        _normalize_app_password("too-short")
    assert exc.value.status_code == 422


def test_legacy_custom_smtp_destinations_are_blocked_before_network_access():
    sender = {
        "id": "legacy",
        "email": "sender@example.com",
        "password": "abcdefghijklmnop",
        "smtp_host": "127.0.0.1",
        "smtp_port": 25,
        "use_tls": False,
    }
    with pytest.raises(HTTPException) as api_error:
        _require_gmail_sender(sender)
    with pytest.raises(ValueError):
        _create_smtp_connection(sender)
    assert api_error.value.status_code == 400


def test_hosted_accounts_cannot_launch_campaigns():
    with pytest.raises(HTTPException) as exc:
        launch_campaign("campaign", {"account_id": "public-account"})
    assert exc.value.status_code == 403


def test_queue_failure_returns_503(send_api, monkeypatch):
    client, _, token, _, _ = send_api

    def fail(*_args):
        raise RuntimeError("broker down")

    monkeypatch.setattr(send_email_task, "delay", fail)
    response = client.post("/emails", headers=auth(token), json=payload())

    assert response.status_code == 503
    assert response.json()["detail"] == "Email queue unavailable"


def test_native_send_contract_is_unchanged(send_api):
    client, sender, token, _, queued = send_api
    response = client.post(
        "/api/v1/send",
        headers=auth(token),
        json={"to": ["customer@example.net"], "subject": "Native", "body": "Hello"},
    )

    assert response.status_code == 202
    assert response.json() == {
        "status": "queued",
        "message_id": response.json()["message_id"],
        "sender_id": sender["id"],
    }
    assert len(queued) == 1

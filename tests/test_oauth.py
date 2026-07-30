import io
import json
import urllib.parse

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from src import oauth, storage
from src.config import Config


class Pipeline:
    def __init__(self, redis):
        self.redis = redis
        self.key = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def get(self, key):
        self.key = key
        return self

    def delete(self, _key):
        return self

    def execute(self):
        return [self.redis.values.pop(self.key, None), 1]


class FakeRedis:
    def __init__(self):
        self.values = {}

    def setex(self, key, _ttl, value):
        self.values[key] = value

    def pipeline(self):
        return Pipeline(self)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


def request(path, query="", cookie=""):
    headers = [(b"cookie", cookie.encode())] if cookie else []
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("sendplug.example", 443),
            "client": ("127.0.0.1", 1234),
            "path": path,
            "query_string": query.encode(),
            "headers": headers,
        }
    )


def test_google_oidc_flow_uses_state_nonce_pkce_and_one_time_exchange(tmp_path, monkeypatch):
    Config.DATABASE_PATH = str(tmp_path / "oauth.db")
    storage.init_db()
    monkeypatch.setattr(Config, "GOOGLE_CLIENT_ID", "client-id")
    monkeypatch.setattr(Config, "GOOGLE_CLIENT_SECRET", "client-secret")
    monkeypatch.setattr(Config, "PUBLIC_URL", "https://sendplug.example")
    monkeypatch.setattr(Config, "GOOGLE_REDIRECT_URI", "")
    monkeypatch.setattr(Config, "AUTH_SIGNUPS_ENABLED", True)
    redis = FakeRedis()
    monkeypatch.setattr(oauth, "get_redis", lambda: redis)

    started = oauth.start_google_login(
        request("/auth/google/login", "next=https%3A%2F%2Fevil.example")
    )
    location = started.headers["location"]
    query = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
    state = query["state"][0]
    state_data = json.loads(redis.values[f"oauth_state:{state}"])
    assert query["code_challenge_method"] == ["S256"]
    assert query["nonce"] == [state_data["nonce"]]
    assert state_data["next"] == "/"
    assert "sendplug_oauth_state=" in started.headers["set-cookie"]
    assert "HttpOnly" in started.headers["set-cookie"]
    assert "Secure" in started.headers["set-cookie"]
    assert "SameSite=lax" in started.headers["set-cookie"]

    monkeypatch.setattr(
        oauth.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: Response(json.dumps({"id_token": "header.payload.signature"}).encode()),
    )

    class JwkClient:
        def __init__(self, _url):
            pass

        def get_signing_key_from_jwt(self, _token):
            return type("Key", (), {"key": "public-key"})()

    monkeypatch.setattr(oauth.jwt, "PyJWKClient", JwkClient)
    monkeypatch.setattr(
        oauth.jwt,
        "decode",
        lambda *_args, **_kwargs: {
            "iss": "https://accounts.google.com",
            "sub": "google-subject",
            "email": "founder@example.com",
            "email_verified": True,
            "name": "Founder",
            "nonce": state_data["nonce"],
        },
    )
    callback = request(
        "/auth/google/callback",
        urllib.parse.urlencode({"state": state, "code": "authorization-code"}),
        f"sendplug_oauth_state={state}",
    )
    finished = oauth.finish_google_login(callback)
    login_code = urllib.parse.parse_qs(urllib.parse.urlparse(finished.headers["location"]).query)[
        "login_code"
    ][0]
    token = oauth.exchange_login_code(login_code)
    assert token.count(".") == 2
    with pytest.raises(HTTPException, match="Expired or reused"):
        oauth.exchange_login_code(login_code)


def test_google_callback_rejects_state_without_matching_cookie(monkeypatch):
    monkeypatch.setattr(Config, "GOOGLE_CLIENT_ID", "client-id")
    monkeypatch.setattr(Config, "GOOGLE_CLIENT_SECRET", "client-secret")
    with pytest.raises(HTTPException, match="Invalid OAuth state"):
        oauth.finish_google_login(request("/auth/google/callback", "state=one&code=two"))

"""Optional Google OpenID Connect sign-in for customer accounts."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import urllib.parse
import urllib.request
from typing import Any

import jwt
from fastapi import HTTPException, Request
from fastapi.responses import RedirectResponse

from .auth import create_access_token
from .config import Config
from .status_store import get_redis
from .storage import get_or_create_google_identity

_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_STATE_COOKIE = "sendplug_oauth_state"
_STATE_TTL_SECONDS = 600
_LOGIN_CODE_TTL_SECONDS = 60


def google_auth_enabled() -> bool:
    return bool(Config.GOOGLE_CLIENT_ID and Config.GOOGLE_CLIENT_SECRET)


def _redirect_uri() -> str:
    return Config.GOOGLE_REDIRECT_URI or f"{Config.PUBLIC_URL}/auth/google/callback"


def _secure_cookie() -> bool:
    return Config.PUBLIC_URL.startswith("https://")


def _state_key(state: str) -> str:
    return f"oauth_state:{state}"


def _login_key(code: str) -> str:
    return f"oauth_login:{code}"


def _consume(key: str) -> str | None:
    redis = get_redis()
    with redis.pipeline() as pipe:
        pipe.get(key)
        pipe.delete(key)
        value, _ = pipe.execute()
    return value


def start_google_login(request: Request) -> RedirectResponse:
    if not google_auth_enabled():
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    next_path = request.query_params.get("next", "/")
    if not next_path.startswith("/") or next_path.startswith("//"):
        next_path = "/"
    get_redis().setex(
        _state_key(state),
        _STATE_TTL_SECONDS,
        json.dumps({"nonce": nonce, "verifier": verifier, "next": next_path}),
    )
    query = urllib.parse.urlencode(
        {
            "client_id": Config.GOOGLE_CLIENT_ID,
            "redirect_uri": _redirect_uri(),
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "prompt": "select_account",
        }
    )
    response = RedirectResponse(f"{_GOOGLE_AUTH_URL}?{query}", status_code=302)
    response.set_cookie(
        _STATE_COOKIE,
        state,
        max_age=_STATE_TTL_SECONDS,
        httponly=True,
        secure=_secure_cookie(),
        samesite="lax",
        path="/auth/google",
    )
    return response


def finish_google_login(request: Request) -> RedirectResponse:
    if not google_auth_enabled():
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    cookie_state = request.cookies.get(_STATE_COOKIE, "")
    if not state or not code or not cookie_state or not secrets.compare_digest(state, cookie_state):
        raise HTTPException(status_code=400, detail="Invalid OAuth state")
    raw_state = _consume(_state_key(state))
    if not raw_state:
        raise HTTPException(status_code=400, detail="Expired or reused OAuth state")
    state_data = json.loads(raw_state)
    body = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": Config.GOOGLE_CLIENT_ID,
            "client_secret": Config.GOOGLE_CLIENT_SECRET,
            "redirect_uri": _redirect_uri(),
            "grant_type": "authorization_code",
            "code_verifier": state_data["verifier"],
        }
    ).encode()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                _GOOGLE_TOKEN_URL,
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            ),
            timeout=10,
        ) as response:
            token_data: dict[str, Any] = json.load(response)
        id_token = token_data["id_token"]
        signing_key = jwt.PyJWKClient(_GOOGLE_JWKS_URL).get_signing_key_from_jwt(id_token).key
        claims = jwt.decode(
            id_token,
            signing_key,
            algorithms=["RS256"],
            audience=Config.GOOGLE_CLIENT_ID,
        )
    except (KeyError, ValueError, OSError, jwt.PyJWTError) as exc:
        raise HTTPException(status_code=401, detail="Google sign-in could not be verified") from exc
    if claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}:
        raise HTTPException(status_code=401, detail="Invalid Google token issuer")
    if not claims.get("email_verified") or not secrets.compare_digest(
        str(claims.get("nonce", "")), state_data["nonce"]
    ):
        raise HTTPException(status_code=401, detail="Google identity was not verified")
    try:
        identity = get_or_create_google_identity(
            str(claims["sub"]),
            str(claims["email"]),
            str(claims.get("name") or claims["email"]),
            allow_create=Config.AUTH_SIGNUPS_ENABLED,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="New account signups are disabled") from exc
    session = create_access_token(
        {
            "sub": identity["email"],
            "purpose": "account_session",
            "user_id": identity["user_id"],
            "account_id": identity["account_id"],
            "account_name": identity["account_name"],
            "role": identity["role"],
        }
    )
    login_code = secrets.token_urlsafe(32)
    get_redis().setex(_login_key(login_code), _LOGIN_CODE_TTL_SECONDS, session)
    target = f"{state_data['next']}?{urllib.parse.urlencode({'login_code': login_code})}"
    response = RedirectResponse(target, status_code=302)
    response.delete_cookie(_STATE_COOKIE, path="/auth/google")
    return response


def exchange_login_code(code: str) -> str:
    token = _consume(_login_key(code))
    if not token:
        raise HTTPException(status_code=400, detail="Expired or reused login code")
    return token

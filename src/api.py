import hmac
import ipaddress
import logging
from html import escape
import smtplib
import ssl
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field

from . import status_store, storage
from .auth import create_access_token, get_admin_user, require_scope
from .config import Config
from .oauth import exchange_login_code, finish_google_login, google_auth_enabled, start_google_login
from .tasks import send_email_task

logger = logging.getLogger(__name__)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginCodeRequest(BaseModel):
    code: str = Field(min_length=20, max_length=200)


class EmailRequest(BaseModel):
    to: List[EmailStr] = Field(min_length=1, max_length=1)
    subject: str = Field(min_length=1, max_length=998)
    body: str = ""
    cc: Optional[List[EmailStr]] = Field(default=None, max_length=10)
    bcc: Optional[List[EmailStr]] = Field(default=None, max_length=10)
    html: Optional[str] = None
    sender_id: Optional[str] = None


class SenderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    app_password: str = Field(min_length=8, max_length=128)
    daily_limit: int = Field(default=400, ge=1, le=2000)
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = Field(default=587, ge=1, le=65535)
    use_tls: bool = True


class SenderUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    app_password: Optional[str] = Field(default=None, min_length=8, max_length=128)
    daily_limit: int = Field(default=400, ge=1, le=2000)
    active: bool = True


class TokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    sender_id: str
    scopes: List[Literal["send", "status"]] = ["send", "status"]


class TokenUpdate(TokenCreate):
    pass


class CampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    sender_id: str
    subject: str = Field(min_length=1, max_length=998)
    body: str = ""
    html: Optional[str] = None
    recipients: List[EmailStr] = Field(min_length=1, max_length=500)


_production = Config.ENVIRONMENT == "production"
app = FastAPI(
    title="SendPlug API",
    description="Plug-and-play email delivery, dashboards, and analytics powered by connected Google senders",
    version="2.0.0",
    docs_url=None if _production else "/internal/docs",
    redoc_url=None,
    openapi_url=None if _production else "/internal/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[Config.ADMIN_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
storage.init_db()


@app.get("/health")
def health_check():
    try:
        status_store.get_redis().ping()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Redis unavailable: {exc}")
    return {"status": "healthy", "version": "2.0.0", "redis": "ok"}


def _client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    try:
        trusted_proxy = ipaddress.ip_address(peer).is_private or ipaddress.ip_address(peer).is_loopback
        forwarded = request.headers.get("x-real-ip", "").strip()
        return str(ipaddress.ip_address(forwarded)) if trusted_proxy and forwarded else peer
    except ValueError:
        return peer


@app.get("/auth/config")
def auth_config():
    return {"google": google_auth_enabled(), "signups": Config.AUTH_SIGNUPS_ENABLED}


@app.get("/auth/google/login", include_in_schema=False)
def google_login(request: Request):
    return start_google_login(request)


@app.get("/auth/google/callback", include_in_schema=False)
def google_callback(request: Request):
    return finish_google_login(request)


@app.post("/auth/exchange")
def exchange(payload: LoginCodeRequest):
    return {"token": exchange_login_code(payload.code)}


@app.post("/auth/login")
def login(payload: LoginRequest, request: Request):
    redis = status_store.get_redis()
    rate_key = f"login:{_client_ip(request)}"
    attempts = redis.incr(rate_key)
    if attempts == 1:
        redis.expire(rate_key, 300)
    if attempts > 5:
        raise HTTPException(status_code=429, detail="Too many login attempts; retry in five minutes")
    valid = hmac.compare_digest(str(payload.email).lower(), Config.ADMIN_EMAIL) and hmac.compare_digest(
        payload.password, Config.ADMIN_PASSWORD
    )
    if not valid:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    redis.delete(rate_key)
    identity = storage.legacy_identity()
    token = create_access_token(
        {
            "sub": identity["email"],
            "email": identity["email"],
            "purpose": "account_session",
            "user_id": identity["user_id"],
            "account_id": identity["account_id"],
            "account_name": identity["account_name"],
            "role": identity["role"],
        },
        timedelta(minutes=Config.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    return {
        "token": token,
        "email": identity["email"],
        "expires_in_minutes": Config.ACCESS_TOKEN_EXPIRE_MINUTES,
    }


@app.get("/auth/me")
def current_account(identity: dict = Depends(get_admin_user)):
    return {
        "email": identity.get("email") or identity["sub"],
        "account_id": identity["account_id"],
        "account_name": identity.get("account_name", "SendPlug account"),
        "role": identity.get("role", "owner"),
        "recovery": identity["account_id"] == storage.LEGACY_ACCOUNT_ID,
    }


@app.get("/api/v1/dashboard")
def dashboard(identity: dict = Depends(get_admin_user)):
    return storage.dashboard(identity["account_id"])


@app.get("/api/v1/senders")
def senders(identity: dict = Depends(get_admin_user)):
    return storage.list_senders(identity["account_id"])


@app.post("/api/v1/senders", status_code=201)
def add_sender(payload: SenderCreate, identity: dict = Depends(get_admin_user)):
    try:
        return storage.create_sender(
            identity["account_id"],
            payload.name,
            str(payload.email),
            payload.app_password.replace(" ", ""),
            payload.daily_limit,
            payload.smtp_host,
            payload.smtp_port,
            payload.use_tls,
        )
    except Exception as exc:
        if "UNIQUE" in str(exc):
            raise HTTPException(status_code=409, detail="That Gmail sender already exists")
        raise


@app.put("/api/v1/senders/{sender_id}")
def edit_sender(sender_id: str, payload: SenderUpdate, identity: dict = Depends(get_admin_user)):
    try:
        return storage.update_sender(
            identity["account_id"],
            sender_id,
            payload.name,
            str(payload.email),
            payload.daily_limit,
            payload.app_password.replace(" ", "") if payload.app_password else None,
            payload.active,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        if "UNIQUE" in str(exc):
            raise HTTPException(status_code=409, detail="That Gmail sender already exists")
        raise


@app.post("/api/v1/senders/{sender_id}/test")
def test_sender(sender_id: str, identity: dict = Depends(get_admin_user)):
    try:
        sender = storage.get_sender(sender_id, identity["account_id"])
        context = ssl.create_default_context()
        with smtplib.SMTP(sender["smtp_host"], sender["smtp_port"], timeout=20) as client:
            if sender["use_tls"]:
                client.starttls(context=context)
            client.login(sender["email"], sender["password"])
            client.noop()
        return {"status": "connected"}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Gmail connection failed: {exc}")


@app.delete("/api/v1/senders/{sender_id}", status_code=204)
def remove_sender(sender_id: str, identity: dict = Depends(get_admin_user)):
    try:
        storage.delete_sender(identity["account_id"], sender_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/v1/tokens")
def tokens(identity: dict = Depends(get_admin_user)):
    return storage.list_api_tokens(identity["account_id"])


@app.post("/api/v1/tokens", status_code=201)
def add_token(payload: TokenCreate, identity: dict = Depends(get_admin_user)):
    try:
        record, raw = storage.create_api_token(
            identity["account_id"], payload.name, payload.scopes, payload.sender_id
        )
        return record | {"token": raw}
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.put("/api/v1/tokens/{token_id}")
def edit_token(token_id: str, payload: TokenUpdate, identity: dict = Depends(get_admin_user)):
    try:
        return storage.update_api_token(
            identity["account_id"], token_id, payload.name, payload.scopes, payload.sender_id
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/v1/tokens/{token_id}", status_code=204)
def revoke_token(token_id: str, identity: dict = Depends(get_admin_user)):
    try:
        storage.revoke_api_token(identity["account_id"], token_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


def _queue_email(payload: EmailRequest, identity: dict[str, Any]) -> dict[str, Any]:
    requested_sender = payload.sender_id
    if identity.get("purpose") == "api_token":
        token_sender = identity.get("sender_id")
        if requested_sender and requested_sender != token_sender:
            raise HTTPException(status_code=403, detail="API token is restricted to another sender")
        requested_sender = token_sender
    try:
        sender = storage.get_sender(
            requested_sender,
            None if identity.get("purpose") == "api_token" else identity["account_id"],
        )
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    message_id = f"{uuid.uuid4().hex}@sendplug"
    recipients = [str(item) for item in payload.to]
    status_store.create_status(
        message_id, recipients, payload.subject, sender["id"], identity["account_id"]
    )
    send_email_task.delay(
        message_id,
        {
            "to": recipients,
            "cc": [str(item) for item in payload.cc or []],
            "bcc": [str(item) for item in payload.bcc or []],
            "subject": payload.subject,
            "body": payload.body,
            "html": payload.html,
        },
        sender["id"],
        None,
    )
    logger.info("Queued %s by %s", message_id, identity.get("sub"))
    return {"status": "queued", "message_id": message_id, "sender_id": sender["id"]}


@app.post("/send-email", status_code=status.HTTP_202_ACCEPTED, include_in_schema=False)
@app.post("/api/v1/send", status_code=status.HTTP_202_ACCEPTED)
def send_email(payload: EmailRequest, identity: dict = Depends(require_scope("send"))):
    return _queue_email(payload, identity)


@app.get("/emails/{message_id}", include_in_schema=False)
@app.get("/api/v1/emails/{message_id}")
def get_email_status(message_id: str, identity: dict = Depends(require_scope("status"))):
    result = status_store.get_status(message_id)
    if not result:
        raise HTTPException(status_code=404, detail="Email not found")
    if identity.get("purpose") == "api_token":
        allowed = result.get("sender_id") == identity.get("sender_id")
    else:
        record_account = result.get("account_id")
        allowed = record_account == identity.get("account_id") or (
            record_account is None and identity.get("account_id") == storage.LEGACY_ACCOUNT_ID
        )
    if not allowed:
        raise HTTPException(status_code=404, detail="Email not found")
    return {key: value for key, value in result.items() if key != "account_id"}


@app.get("/api/v1/suppressions")
def suppressions(identity: dict = Depends(get_admin_user)):
    return storage.list_suppressions(identity["account_id"])


@app.get("/unsubscribe/{token}", response_class=HTMLResponse, include_in_schema=False)
def unsubscribe_page(token: str):
    unsubscribe_identity = storage.identity_from_unsubscribe_token(token)
    if not unsubscribe_identity:
        raise HTTPException(status_code=400, detail="Invalid unsubscribe link")
    _, email = unsubscribe_identity
    return HTMLResponse(
        "<!doctype html><meta name='viewport' content='width=device-width'>"
        "<body style='font:16px system-ui;max-width:520px;margin:80px auto;padding:20px'>"
        f"<h1>Unsubscribe</h1><p>Stop campaign email to <strong>{escape(email)}</strong>?</p>"
        f"<form method='post'><button style='padding:12px 18px'>Unsubscribe</button></form></body>"
    )


@app.post("/unsubscribe/{token}", response_class=HTMLResponse, include_in_schema=False)
def unsubscribe(token: str):
    unsubscribe_identity = storage.identity_from_unsubscribe_token(token)
    if not unsubscribe_identity:
        raise HTTPException(status_code=400, detail="Invalid unsubscribe link")
    account_id, email = unsubscribe_identity
    storage.suppress(account_id, email)
    return HTMLResponse(
        "<!doctype html><meta name='viewport' content='width=device-width'>"
        "<body style='font:16px system-ui;max-width:520px;margin:80px auto;padding:20px'>"
        "<h1>Unsubscribed</h1><p>You will not receive future campaigns from this service.</p></body>"
    )


@app.get("/api/v1/campaigns")
def campaigns(identity: dict = Depends(get_admin_user)):
    return storage.list_campaigns(identity["account_id"])


@app.post("/api/v1/campaigns", status_code=201)
def add_campaign(payload: CampaignCreate, identity: dict = Depends(get_admin_user)):
    try:
        return storage.create_campaign(
            identity["account_id"],
            payload.name,
            payload.sender_id,
            payload.subject,
            payload.body,
            payload.html,
            [str(item) for item in payload.recipients],
        )
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.put("/api/v1/campaigns/{campaign_id}")
def edit_campaign(campaign_id: str, payload: CampaignCreate, identity: dict = Depends(get_admin_user)):
    try:
        return storage.update_campaign(
            identity["account_id"],
            campaign_id,
            payload.name,
            payload.sender_id,
            payload.subject,
            payload.body,
            payload.html,
            [str(item) for item in payload.recipients],
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.delete("/api/v1/campaigns/{campaign_id}", status_code=204)
def remove_campaign(campaign_id: str, identity: dict = Depends(get_admin_user)):
    try:
        storage.delete_campaign(identity["account_id"], campaign_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.get("/api/v1/campaigns/{campaign_id}")
def campaign(campaign_id: str, identity: dict = Depends(get_admin_user)):
    try:
        return storage.get_campaign(identity["account_id"], campaign_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/v1/campaigns/{campaign_id}/start", status_code=202)
def launch_campaign(campaign_id: str, identity: dict = Depends(get_admin_user)):
    account_id = identity["account_id"]
    try:
        campaign_data = storage.get_campaign(account_id, campaign_id)
        queued = storage.start_campaign(account_id, campaign_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    for item in queued:
        if storage.is_suppressed(account_id, item["email"]):
            storage.complete_campaign_recipient(item["message_id"], "failed", "Recipient suppressed")
            continue
        token = storage.unsubscribe_token(account_id, item["email"])
        unsubscribe_url = f"{Config.PUBLIC_URL}/unsubscribe/{token}"
        text = f"{campaign_data['body']}\n\nUnsubscribe: {unsubscribe_url}"
        html = campaign_data["html"]
        if html:
            html += (
                "<hr><p style='font-size:12px;color:#777'>"
                f"<a href='{unsubscribe_url}'>Unsubscribe</a></p>"
            )
        status_store.create_status(
            item["message_id"],
            [item["email"]],
            campaign_data["subject"],
            campaign_data["sender_id"],
            account_id,
        )
        send_email_task.delay(
            item["message_id"],
            {
                "to": [item["email"]],
                "cc": [],
                "bcc": [],
                "subject": campaign_data["subject"],
                "body": text,
                "html": html,
                "unsubscribe_url": unsubscribe_url,
            },
            campaign_data["sender_id"],
            campaign_id,
        )
    return {"status": "queued", "campaign_id": campaign_id, "messages": len(queued)}


@app.get("/status")
def server_status(_: dict = Depends(get_admin_user)):
    return {
        "status": "running",
        "smtp": {"host": Config.HOST, "port": Config.PORT, "auth": Config.ENABLE_AUTH},
        "version": "2.0.0",
    }


static_dir = Path(__file__).resolve().parent.parent / "static"
if static_dir.exists():
    app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

    @app.get("/docs", include_in_schema=False)
    @app.get("/docs/", include_in_schema=False)
    def developer_guide():
        return FileResponse(static_dir / "docs" / "index.html")

    @app.get("/favicon.ico", include_in_schema=False)
    @app.get("/sendplug-favicon.svg", include_in_schema=False)
    @app.get("/sendplug-app-icon.svg", include_in_schema=False)
    def frontend_brand_asset(request: Request):
        return FileResponse(static_dir / Path(request.url.path).name)

    @app.get("/", include_in_schema=False)
    def frontend_index():
        return FileResponse(static_dir / "index.html")

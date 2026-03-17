import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
from fastapi.security import HTTPBearer
from pydantic import BaseModel, EmailStr, Field

from .auth import create_access_token, get_current_user
from .config import Config
from .handlers import EmailHandler
from . import status_store
from .tasks import send_email_task

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class EmailRequest(BaseModel):
    to: List[EmailStr]
    subject: str
    body: str
    cc: Optional[List[EmailStr]] = None
    bcc: Optional[List[EmailStr]] = None
    html: Optional[str] = None


class EmailResponse(BaseModel):
    status: str
    message_id: Optional[str] = None
    details: Optional[Dict[str, Any]] = None


class EmailStatus(BaseModel):
    status: Literal["queued", "sending", "sent", "delivered", "failed"]
    message_id: str
    to: List[str]
    subject: str
    created_at: str
    updated_at: str
    details: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class HealthCheck(BaseModel):
    status: str
    version: str
    redis: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    token: str
    user_id: str
    email: str
    expires_in_minutes: int


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="SMTP Server API",
    description="REST API for the SMTP Server with Swagger documentation",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

email_handler = EmailHandler(enable_auth=Config.ENABLE_AUTH)


# ---------------------------------------------------------------------------
# Custom Swagger UI (keeps existing behaviour)
# ---------------------------------------------------------------------------

@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui_html():
    return get_swagger_ui_html(
        openapi_url="/openapi.json",
        title=app.title,
        swagger_favicon_url="https://fastapi.tiangolo.com/img/favicon.png",
    )


@app.get("/openapi.json", include_in_schema=False)
async def get_open_api_endpoint():
    return get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthCheck, tags=["Health"])
async def health_check():
    """Health check — also verifies Redis connectivity."""
    redis_status = "ok"
    try:
        status_store.get_redis().ping()
    except Exception as exc:
        redis_status = f"error: {exc}"

    return {"status": "healthy", "version": "1.0.0", "redis": redis_status}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.post("/auth/login", response_model=TokenResponse, tags=["Authentication"])
async def login(login_request: LoginRequest):
    """
    Authenticate with email and password to get a JWT token.
    Use the returned token as `Authorization: Bearer <token>` on all other endpoints.
    """
    if login_request.email != Config.ADMIN_EMAIL or login_request.password != Config.ADMIN_PASSWORD:
        logger.warning(f"Failed login attempt for: {login_request.email}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_data = {
        "sub": login_request.email,
        "email": login_request.email,
        "created_at": datetime.utcnow().isoformat(),
        "purpose": "smtp_api_access",
    }
    token = create_access_token(
        token_data,
        expires_delta=timedelta(minutes=Config.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    logger.info(f"Login successful: {login_request.email}")

    return {
        "token": token,
        "user_id": login_request.email,
        "email": login_request.email,
        "expires_in_minutes": Config.ACCESS_TOKEN_EXPIRE_MINUTES,
    }


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

@app.post(
    "/send-email",
    response_model=EmailResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(get_current_user)],
    tags=["Email"],
)
async def send_email(
    email: EmailRequest,
    current_user: str = Depends(get_current_user),
):
    """
    Queue an email for delivery. Returns immediately with a `message_id`
    you can use to poll `/emails/{message_id}` for delivery status.
    """
    message_id = f"{uuid.uuid4().hex}@{Config.HOST}"
    status_store.create_status(message_id, [str(a) for a in email.to], email.subject)

    send_email_task.delay(
        message_id,
        {
            "to": [str(a) for a in email.to],
            "cc": [str(a) for a in email.cc] if email.cc else [],
            "bcc": [str(a) for a in email.bcc] if email.bcc else [],
            "subject": email.subject,
            "body": email.body,
            "html": email.html,
        },
    )

    logger.info(f"Queued [{message_id}] for {email.to} by {current_user}")
    return {
        "status": "queued",
        "message_id": message_id,
        "details": {"recipients": [str(a) for a in email.to], "subject": email.subject},
    }


@app.get(
    "/emails/{message_id}",
    response_model=EmailStatus,
    dependencies=[Depends(get_current_user)],
    tags=["Email"],
)
async def get_email_status(message_id: str):
    """Get delivery status of a previously queued email."""
    data = status_store.get_status(message_id)
    if data is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Email {message_id} not found",
        )
    return data


@app.get("/status", dependencies=[Depends(get_current_user)], tags=["Health"])
async def get_server_status():
    """Current SMTP server configuration."""
    return {
        "status": "running",
        "smtp_server": {
            "host": Config.HOST,
            "port": Config.PORT,
            "tls_enabled": Config.ENABLE_TLS,
            "auth_enabled": Config.ENABLE_AUTH,
        },
        "version": "1.0.0",
    }

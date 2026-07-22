"""JWT admin sessions and revocable API-token authentication."""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import jwt

from .config import Config
from .storage import verify_api_token

security = HTTPBearer(auto_error=False)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    now = datetime.now(timezone.utc)
    payload = data.copy()
    payload.update(
        {
            "exp": now + (expires_delta or timedelta(minutes=Config.ACCESS_TOKEN_EXPIRE_MINUTES)),
            "iat": now,
        }
    )
    return jwt.encode(payload, Config.JWT_SECRET_KEY, algorithm=Config.JWT_ALGORITHM)


async def verify_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="Authentication required")
    token = credentials.credentials
    if token.startswith("smtp_"):
        payload = verify_api_token(token)
        if not payload:
            raise HTTPException(status_code=401, detail="Invalid or revoked API token")
        return payload
    try:
        payload = jwt.decode(token, Config.JWT_SECRET_KEY, algorithms=[Config.JWT_ALGORITHM])
        if payload.get("purpose") != "smtp_admin_session":
            raise HTTPException(status_code=401, detail="Invalid token purpose")
        return payload
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_current_user(payload: dict = Depends(verify_token)) -> str:
    identity = payload.get("sub")
    if not identity:
        raise HTTPException(status_code=401, detail="Could not validate credentials")
    return identity


def get_admin_user(payload: dict = Depends(verify_token)) -> str:
    if payload.get("purpose") != "smtp_admin_session":
        raise HTTPException(status_code=403, detail="Administrator session required")
    return get_current_user(payload)


def require_scope(scope: str):
    def dependency(payload: dict = Depends(verify_token)) -> dict:
        if payload.get("purpose") != "smtp_admin_session" and scope not in payload.get("scopes", []):
            raise HTTPException(status_code=403, detail=f"Token requires '{scope}' scope")
        get_current_user(payload)
        return payload

    return dependency

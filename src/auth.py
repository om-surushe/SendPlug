"""
Authentication utilities for the SMTP Server API.
"""
from datetime import datetime, timedelta
from typing import Optional
from jose import jwt
from fastapi import HTTPException, status, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from .config import Config

security = HTTPBearer()

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a JWT access token.
    
    Args:
        data: Dictionary containing the token claims
        expires_delta: Optional timedelta for token expiration
        
    Returns:
        str: Encoded JWT token
    """
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=Config.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode.update({"exp": expire, "iat": datetime.utcnow()})
    return jwt.encode(
        to_encode, 
        Config.JWT_SECRET_KEY, 
        algorithm=Config.JWT_ALGORITHM
    )

async def verify_token(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """
    Verify and decode a JWT token.
    
    Args:
        request: The incoming request
        credentials: HTTP Authorization credentials containing the JWT token
        
    Returns:
        dict: Decoded token payload
        
    Raises:
        HTTPException: If token is invalid or expired
    """
    # Skip authentication for docs and redoc
    if request.url.path in ["/docs", "/redoc", "/openapi.json"]:
        return {}
        
    token = credentials.credentials
    try:
        payload = jwt.decode(
            token,
            Config.JWT_SECRET_KEY,
            algorithms=[Config.JWT_ALGORITHM]
        )
        return payload
    except jwt.JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

def get_current_user(payload: dict = Depends(verify_token)) -> str:
    """
    Get the current user from the token payload.
    
    Args:
        payload: Decoded JWT token payload
        
    Returns:
        str: User identifier (email or username)
        
    Raises:
        HTTPException: If user is not found in the token
    """
    user_identity = payload.get("sub")
    if not user_identity:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user_identity

import logging
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

root = Path(__file__).resolve().parent.parent
load_dotenv(root / ".env.local" if (root / ".env.local").exists() else None)


def _secret(name: str, file_name: str) -> str:
    path = os.getenv(file_name)
    if path and Path(path).exists():
        value = Path(path).read_text().strip()
    else:
        value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} or {file_name} must be configured")
    return value


class Config:
    HOST = os.getenv("SMTP_HOST", "0.0.0.0")
    PORT = int(os.getenv("SMTP_PORT", "8025"))
    SMTP_AUTH_USERNAME: Optional[str] = os.getenv("SMTP_AUTH_USERNAME")
    SMTP_AUTH_PASSWORD: Optional[str] = os.getenv("SMTP_AUTH_PASSWORD")
    ENABLE_AUTH = os.getenv("ENABLE_AUTH", "true").lower() == "true"
    ENABLE_TLS = os.getenv("ENABLE_TLS", "false").lower() == "true"
    TLS_CERTFILE = os.getenv("TLS_CERTFILE", "")
    TLS_KEYFILE = os.getenv("TLS_KEYFILE", "")
    MAX_MESSAGE_SIZE = int(os.getenv("MAX_MESSAGE_SIZE", "26214400"))

    HTTP_HOST = os.getenv("HTTP_HOST", "0.0.0.0")
    HTTP_PORT = int(os.getenv("HTTP_PORT", "8000"))
    API_PREFIX = os.getenv("API_PREFIX", "/api/v1")
    DEBUG = os.getenv("DEBUG", "false").lower() == "true"
    ADMIN_ORIGIN = os.getenv("ADMIN_ORIGIN", "http://localhost:5173")
    PUBLIC_URL = os.getenv("PUBLIC_URL", ADMIN_ORIGIN).rstrip("/")

    JWT_SECRET_KEY = _secret("JWT_SECRET_KEY", "JWT_SECRET_FILE")
    JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
    ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
    ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "").lower().strip()
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

    REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
    DATABASE_PATH = os.getenv("DATABASE_PATH", "/app/data/app.db")
    CREDENTIAL_KEY_FILE = os.getenv("CREDENTIAL_KEY_FILE", "/run/secrets/credential_key")
    API_TOKEN_PEPPER_FILE = os.getenv("API_TOKEN_PEPPER_FILE", "/run/secrets/token_pepper")

    @classmethod
    def validate(cls) -> None:
        if not cls.ADMIN_EMAIL or not cls.ADMIN_PASSWORD:
            raise RuntimeError("ADMIN_EMAIL and ADMIN_PASSWORD must be configured")
        if cls.ENABLE_AUTH and (not cls.SMTP_AUTH_USERNAME or not cls.SMTP_AUTH_PASSWORD):
            raise RuntimeError("SMTP_AUTH_USERNAME and SMTP_AUTH_PASSWORD are required")
        if cls.ENABLE_TLS and (not cls.TLS_CERTFILE or not cls.TLS_KEYFILE):
            raise RuntimeError("TLS_CERTFILE and TLS_KEYFILE are required when TLS is enabled")
        for path in (cls.CREDENTIAL_KEY_FILE, cls.API_TOKEN_PEPPER_FILE):
            if not Path(path).exists():
                raise RuntimeError(f"Required secret file is missing: {path}")
        logger.info(
            "SMTP=%s:%s auth=%s tls=%s HTTP=%s:%s DB=%s",
            cls.HOST,
            cls.PORT,
            cls.ENABLE_AUTH,
            cls.ENABLE_TLS,
            cls.HTTP_HOST,
            cls.HTTP_PORT,
            cls.DATABASE_PATH,
        )


Config.validate()

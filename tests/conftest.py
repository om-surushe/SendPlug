import os
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet

secrets_dir = Path(tempfile.mkdtemp(prefix="smtp-test-secrets-"))
(secrets_dir / "credential_key").write_bytes(Fernet.generate_key())
(secrets_dir / "token_pepper").write_text("test-pepper-that-is-never-used-in-production")
(secrets_dir / "jwt_secret").write_text("test-jwt-secret-that-is-long-enough-for-tests")
os.environ.update(
    {
        "CREDENTIAL_KEY_FILE": str(secrets_dir / "credential_key"),
        "API_TOKEN_PEPPER_FILE": str(secrets_dir / "token_pepper"),
        "JWT_SECRET_FILE": str(secrets_dir / "jwt_secret"),
        "ADMIN_EMAIL": "admin@example.com",
        "ADMIN_PASSWORD": "test-password",
        "DATABASE_PATH": str(secrets_dir / "test.db"),
        "SMTP_AUTH_USERNAME": "smtp-client",
        "SMTP_AUTH_PASSWORD": "smtp-password",
    }
)

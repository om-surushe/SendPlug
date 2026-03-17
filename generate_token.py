#!/usr/bin/env python3
"""
Generate a JWT token for SMTP API authentication.

Usage:
  # Interactive (will prompt for missing values)
  python generate_token.py

  # Non-interactive (fully from CLI args)
  python generate_token.py --email admin@example.com --days 30

  # Use a specific env file
  python generate_token.py --email admin@example.com --env-file /path/to/.env
"""
import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv


def main():
    parser = argparse.ArgumentParser(description="Generate a JWT token for the SMTP Server API")
    parser.add_argument("--email", help="User email to embed in the token")
    parser.add_argument("--days", type=int, default=30, help="Token validity in days (default: 30)")
    parser.add_argument(
        "--env-file",
        default=".env.local",
        help="Path to .env file to load JWT_SECRET_KEY from (default: .env.local)",
    )
    args = parser.parse_args()

    # Load env — try the specified file first, fall back to .env
    loaded = load_dotenv(args.env_file, override=True)
    if not loaded:
        load_dotenv(override=True)

    jwt_secret = os.getenv("JWT_SECRET_KEY")
    jwt_algorithm = os.getenv("JWT_ALGORITHM", "HS256")

    if not jwt_secret:
        print(
            f"ERROR: JWT_SECRET_KEY not found in '{args.env_file}' or environment.",
            file=sys.stderr,
        )
        sys.exit(1)

    email = args.email or input("Enter user email: ").strip()
    if not email:
        print("ERROR: email is required.", file=sys.stderr)
        sys.exit(1)

    try:
        import jwt as pyjwt
    except ImportError:
        print("ERROR: PyJWT is not installed. Run: pip install PyJWT", file=sys.stderr)
        sys.exit(1)

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=args.days)

    payload = {
        "sub": email,
        "email": email,
        "iat": now,
        "exp": expires_at,
        "purpose": "smtp_api_access",
    }
    token = pyjwt.encode(payload, jwt_secret, algorithm=jwt_algorithm)

    print(f"\nToken generated successfully")
    print(f"  Email   : {email}")
    print(f"  Expires : {expires_at.strftime('%Y-%m-%d %H:%M UTC')} ({args.days} days)")
    print(f"\nAuthorization header:")
    print(f"  Bearer {token}")
    print(f"\nOr as a curl flag:")
    print(f'  -H "Authorization: Bearer {token}"')


if __name__ == "__main__":
    main()

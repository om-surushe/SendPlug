<p align="center"><img src="brand/final/sendplug-app-icon.svg" width="96" alt="SendPlug" /></p>
<h1 align="center">SendPlug</h1>
<p align="center"><strong>Plug in. Send. See.</strong></p>

Plug-and-play email infrastructure for founders building SaaS, AI products, automations, and MVPs. Connect a Google sender, create a scoped API token, send application email, and manage delivery from one dashboard.

The current release is self-hostable and includes encrypted sender credentials, revocable API tokens, consent-based campaigns, Redis/Celery delivery, analytics-ready delivery history, and optional local SMTP intake.

![CI](https://github.com/om-surushe/SendPlug/actions/workflows/ci.yml/badge.svg) ![Python](https://img.shields.io/badge/FastAPI-Python-009688) ![React](https://img.shields.io/badge/React-TypeScript-61dafb)

## What it does

- Add Gmail senders from the browser using a Google App Password.
- Encrypt App Passwords before storing them in SQLite.
- Generate sender-scoped API tokens; raw tokens are displayed once and only hashes are stored.
- Send transactional email through REST or authenticated SMTP.
- Create small, opt-in campaigns with per-recipient status.
- Enforce a configurable Gmail daily safety limit and one-message-per-second delivery.
- Queue and retry delivery with Celery and Redis; inspect workers with Flower.

This is a relay, not a way around Gmail quotas. Personal Gmail commonly stops accounts around 500 recipients/day. The default safety limit is 400. Send only to recipients who opted in.

## Architecture

```text
React admin / API client / local SMTP
                 │
                 ▼
          FastAPI + aiosmtpd
          │       │       │
      SQLite    Redis   encrypted secrets
          │       │
          └── Celery worker ──► Gmail SMTP
```

## Quick start

```bash
cp .env.example .env
mkdir -m 700 secrets
python - <<'PY' > secrets/credential_key
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
openssl rand -hex 32 > secrets/token_pepper
openssl rand -hex 64 > secrets/jwt_secret
chmod 600 .env
chmod 700 secrets && chmod 644 secrets/*  # container-readable; parent blocks host users
docker compose up -d --build
```

Open `http://localhost:8000`, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, and add a Gmail sender. Use a [Google App Password](https://support.google.com/accounts/answer/185833), not your normal password.

## API tokens

Create a token in **API Tokens**, select its Gmail sender, and choose `send` and/or `status` permissions. It is shown once. A token cannot send from or read delivery records belonging to another sender.

```bash
curl -X POST https://sendplug.example/api/v1/send \
  -H "Authorization: Bearer $SENDPLUG_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "to": ["recipient@example.com"],
    "subject": "Hello",
    "body": "Plain text fallback",
    "html": "<p>Hello</p>"
  }'
```

Poll status:

```bash
curl https://sendplug.example/api/v1/emails/MESSAGE_ID \
  -H "Authorization: Bearer $SENDPLUG_API_TOKEN"
```

## Customer accounts and Google sign-in

Senders, API tokens, campaigns, suppressions, quotas, and delivery status are isolated by customer account. Existing installations migrate all current data into the protected recovery-administrator account. A Google sender can belong to only one account at a time to prevent credential and ownership ambiguity.

Google OpenID Connect is optional. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and this callback URL to enable **Continue with Google**:

```text
https://your-sendplug.example/auth/google/callback
```

The flow uses authorization code + PKCE, state and nonce validation, a short-lived one-time login code, and verified Google email claims. Set `AUTH_SIGNUPS_ENABLED=false` to prevent new customer account creation. The original `ADMIN_EMAIL` and `ADMIN_PASSWORD` login remains available as the operational recovery path.

## Developer guide

The curated guide at `/docs` documents only the sender-scoped send and delivery-status APIs. Administrative sender, token, suppression, and campaign operations intentionally remain dashboard-only and are not part of the public API contract.

## SMTP intake

Applications on the VM can authenticate using `SMTP_AUTH_USERNAME` and `SMTP_AUTH_PASSWORD` on port `8025`. These credentials only grant intake access; Gmail credentials remain encrypted in the database.

## Migrating the legacy `.env` sender

After deploying v2, import the old Gmail values without placing them on a command line:

```bash
docker compose run --rm \
  -v "$PWD/.env:/migration.env:ro" \
  smtp-api python -m src.migrate_sender /migration.env
```

Then remove `SMTP_USERNAME` and `SMTP_PASSWORD` from `.env`, add generated `SMTP_AUTH_USERNAME` / `SMTP_AUTH_PASSWORD`, and recreate the services.

## Development

Backend:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
ENVIRONMENT=development python -m src.server
pytest -q
```

Production disables Swagger, ReDoc, and the OpenAPI schema. Local development can use the internal Swagger route at `/internal/docs` when `ENVIRONMENT=development`.

Frontend:

```bash
cd web
npm ci
npm run dev
npm run typecheck
npm run build
```

The UI follows the SendPlug design system in [`DESIGN.md`](DESIGN.md): near-black surfaces, electric yellow brand voltage, direct product copy, and the modular-mail identity under [`brand/final/`](brand/final/).

## Security

- `.env`, `secrets/`, SQLite data, and frontend build artifacts are ignored by Git and Docker build context.
- Credential encryption, API-token hashing, and JWT signing use separate mounted secrets.
- Sender secrets are write-only through the API and never returned.
- Admin login is rate-limited; API tokens are scoped and revocable.
- Docker publishes the SMTP/API/Flower ports on loopback only.
- Losing `credential_key` makes stored App Passwords unrecoverable. Back it up securely.

## Current limits

- Gmail App Password authentication; Google OAuth can be added later.
- No bounce webhooks, click/open tracking, or automated list hygiene.
- SQLite is intended for one VM; use PostgreSQL before multi-host scaling.
- “Sent” means Gmail accepted the message, not that the recipient opened or received it.

## Roadmap

Deferred product work—including a curated public API guide, private internal schema, customer accounts, managed Google sign-in, service status, and payments—is tracked in [`ROADMAP.md`](ROADMAP.md).

## License

Licensing terms have not yet been published. No permission to copy, modify, or redistribute this project is granted until a licence is added.

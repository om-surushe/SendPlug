# SMTP Console

A self-hosted Gmail relay with a polished React admin, encrypted sender credentials, revocable API tokens, consent-based campaigns, Redis/Celery delivery, and optional local SMTP intake.

![CI](https://github.com/om-surushe/SMTP-Server/actions/workflows/ci.yml/badge.svg) ![Python](https://img.shields.io/badge/FastAPI-Python-009688) ![React](https://img.shields.io/badge/React-TypeScript-61dafb)

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
curl -X POST https://smtp.example.com/api/v1/send \
  -H 'Authorization: Bearer smtp_xxxxxxxx_xxx' \
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
curl https://smtp.example.com/api/v1/emails/MESSAGE_ID \
  -H 'Authorization: Bearer smtp_xxxxxxxx_xxx'
```

## Management API

The admin UI uses the same CRUD API documented interactively at `/docs`.

| Resource | Create | Read | Update | Delete / deactivate |
|---|---|---|---|---|
| Senders | `POST /api/v1/senders` | `GET /api/v1/senders` | `PUT /api/v1/senders/{id}` | `DELETE /api/v1/senders/{id}` |
| API tokens | `POST /api/v1/tokens` | `GET /api/v1/tokens` | `PUT /api/v1/tokens/{id}` | `DELETE /api/v1/tokens/{id}` |
| Campaigns | `POST /api/v1/campaigns` | `GET /api/v1/campaigns/{id}` | `PUT /api/v1/campaigns/{id}` | `DELETE /api/v1/campaigns/{id}` |

Used senders are deactivated rather than destroying history. Token deletion revokes the credential. Only draft campaigns can be edited or deleted.

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
pytest -q
```

Frontend:

```bash
cd web
npm ci
npm run dev
npm run typecheck
npm run build
```

The UI follows the active ClickHouse-inspired `DESIGN.md`, installed with:

```bash
npx getdesign@latest add clickhouse
```

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

Deferred product work—including a curated public API guide, private internal schema, favicon and final branding, managed Google sign-in, service status, credits, and Dodo Payments—is tracked in [`ROADMAP.md`](ROADMAP.md).

## License

Licensing terms have not yet been published. No permission to copy, modify, or redistribute this project is granted until a licence is added.

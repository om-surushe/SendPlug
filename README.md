# Python SMTP Server

A high-performance SMTP server built with Python and aiosmtpd, designed to run in a Docker container.

## Features

- Support for SMTP with optional authentication
- Handles both plain text and HTML email content
- Support for TO, CC, and BCC recipients
- Configurable message size limits
- TLS/SSL support
- Docker and Docker Compose ready

## Prerequisites

- Docker and Docker Compose
- Python 3.10+ (for local development)

## Quick Start

1. Clone the repository:

   ```bash
   git clone <repository-url>
   cd smtp-server
   ```

2. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

3. Edit the `.env` file with your configuration.

4. Build and start the server:

   ```bash
   docker-compose up -d --build
   ```

Authentication

All API endpoints (except `/auth/login`) require JWT authentication. Include the token in the `Authorization` header:

```http
Authorization: Bearer your_jwt_token_here
```

### Generating Tokens

**Option 1: Using the API (Recommended)**

Obtain a JWT token by logging in with your admin credentials:

```bash
curl -X POST http://localhost:8025/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "your-secure-password"
  }'
```

Response:

```json
{
  "token": "<shown once>",
  "user_id": "admin@example.com",
  "email": "admin@example.com",
  "expires_in_minutes": 1440
}
```

**Option 2: Using the CLI script**

```bash
python generate_token.py
```

You'll be prompted to enter user email, user ID, and token validity in days.

## API Endpoints

The following REST API endpoints are available (all require authentication): on `localhost:8025`

## Configuration

Edit the `.env` file to configure the SMTP server:

- `SMTP_PORT`: Port to listen on (default: 8025)
- `ENABLE_AUTH`: Enable SMTP authentication (true/false)
- `JWT_SECRET_KEY`: Secret key for JWT token generation and validation
- `JWT_ALGORITHM`: Algorithm for JWT (default: HS256)
- `ACCESS_TOKEN_EXPIRE_MINUTES`: Token expiration time in minutes (default: 1440 - 24 hours)
- `SMTP_USERNAME`: Username for authentication
- `SMTP_PASSWORD`: Password for authentication
- `ENABLE_TLS`: Enable TLS encryption (true/false)
- `TLS_CERTFILE`: Path to TLS certificate file
- `TLS_KEYFILE`: Path to TLS private key file
- `MAX_MESSAGE_SIZE`: Maximum message size in bytes (default: 25MB)

## Sending Emails

### Using Python

```python
from src.utils import send_email

send_email(
    smtp_host="localhost",
    smtp_port=8025,
    sender="from@example.com",
    recipients=["to@example.com"],
    subject="Test Email",
    body="This is a test email.",
    html_body="<h1>This is a test email</h1><p>With HTML content</p>",
    cc=["cc@example.com"],
    bcc=["bcc@example.com"]
)
```

### Using Command Line

```bash
# Using swaks (https://jetmore.org/john/code/swaks/)
swaks --to recipient@example.com --from sender@example.com --server localhost:8025 --h-Subject "Test Email" --body "Hello, world!"
```

## Development

### Setup

1. Create a virtual environment:

   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Run the server:

   ```bash
   python -m src.server
   ```

### Testing

Run the test suite:

```bash
pytest
```

## Security Considerations

- Always use strong passwords for authentication
- Enable TLS for production use
- Keep your Docker images updated
- Use a reverse proxy with rate limiting in production

## License

Licensing terms have not yet been published. No permission to copy, modify, or redistribute this project is granted until a licence is added.

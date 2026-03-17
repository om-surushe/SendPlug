"""
Celery tasks for async email sending.

Each worker process maintains a thread-local persistent SMTP connection to Gmail,
reconnecting automatically on failure. Tasks retry up to 3 times with exponential
backoff on transient SMTP errors.
"""
import logging
import smtplib
import ssl
import threading
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate
from typing import Optional

from celery import Celery
from celery.utils.log import get_task_logger

from .config import Config

logger = get_task_logger(__name__)

celery_app = Celery(
    "smtp_server",
    broker=Config.REDIS_URL,
    backend=Config.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    # Ack task only after it finishes — safe for retries
    task_acks_late=True,
    # One task at a time per worker thread — prevents prefetch pile-ups
    worker_prefetch_multiplier=1,
    # Recycle workers after N tasks to prevent memory leaks
    worker_max_tasks_per_child=200,
)

# Thread-local SMTP connection: one persistent connection per worker thread
_local = threading.local()


def _create_smtp_connection() -> smtplib.SMTP:
    context = ssl.create_default_context()
    server = smtplib.SMTP(Config.GMAIL_SMTP_SERVER, Config.GMAIL_SMTP_PORT, timeout=30)
    if Config.GMAIL_USE_TLS:
        server.starttls(context=context)
    server.login(Config.SMTP_USERNAME, Config.SMTP_PASSWORD)
    logger.info(
        f"SMTP connection established to {Config.GMAIL_SMTP_SERVER}:{Config.GMAIL_SMTP_PORT}"
    )
    return server


def _get_smtp_connection() -> smtplib.SMTP:
    """Return the thread-local SMTP connection, creating or reconnecting as needed."""
    conn = getattr(_local, "smtp", None)
    if conn is not None:
        try:
            conn.noop()  # lightweight ping
            return conn
        except Exception:
            _local.smtp = None

    _local.smtp = _create_smtp_connection()
    return _local.smtp


def _build_mime_message(payload: dict) -> tuple[MIMEMultipart, list[str]]:
    """Build a MIME message from the payload dict and return (msg, all_recipients)."""
    msg = MIMEMultipart("alternative")
    msg["From"] = Config.SMTP_USERNAME
    msg["To"] = ", ".join(payload["to"])
    msg["Subject"] = payload["subject"]
    msg["Date"] = formatdate(localtime=True)

    if payload.get("cc"):
        msg["Cc"] = ", ".join(payload["cc"])

    msg.attach(MIMEText(payload.get("body", ""), "plain"))
    if payload.get("html"):
        msg.attach(MIMEText(payload["html"], "html"))

    recipients = list(payload["to"])
    if payload.get("cc"):
        recipients.extend(payload["cc"])
    if payload.get("bcc"):
        recipients.extend(payload["bcc"])

    return msg, recipients


@celery_app.task(
    bind=True,
    name="tasks.send_email",
    max_retries=3,
    # Base retry delay in seconds; doubled per retry: 60s, 120s, 240s
    default_retry_delay=60,
)
def send_email_task(self, message_id: str, payload: dict):
    """
    Send an email via Gmail SMTP and update its status in Redis.

    payload keys: to, cc, bcc, subject, body, html
    """
    from .status_store import update_status

    try:
        update_status(message_id, "sending")

        msg, recipients = _build_mime_message(payload)

        # Try sending; reconnect once on connection failure
        try:
            server = _get_smtp_connection()
            server.send_message(msg, from_addr=Config.SMTP_USERNAME, to_addrs=recipients)
        except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, OSError):
            _local.smtp = None
            server = _get_smtp_connection()
            server.send_message(msg, from_addr=Config.SMTP_USERNAME, to_addrs=recipients)

        update_status(
            message_id,
            "sent",
            details={
                "recipients": recipients,
                "subject": payload["subject"],
                "sent_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        logger.info(f"[{message_id}] sent to {recipients}")

    except smtplib.SMTPRecipientsRefused as exc:
        # Hard failure — don't retry bad addresses
        logger.error(f"[{message_id}] recipients refused: {exc}")
        update_status(message_id, "failed", error=str(exc))

    except smtplib.SMTPException as exc:
        # Transient SMTP error — retry with exponential backoff
        retry_num = self.request.retries + 1
        countdown = 60 * (2 ** self.request.retries)  # 60, 120, 240
        logger.warning(f"[{message_id}] SMTP error (attempt {retry_num}): {exc}. Retrying in {countdown}s")
        update_status(message_id, "queued", error=f"Retry {retry_num}: {exc}")
        raise self.retry(exc=exc, countdown=countdown)

    except Exception as exc:
        logger.error(f"[{message_id}] unexpected error: {exc}", exc_info=True)
        if self.request.retries < self.max_retries:
            countdown = 60 * (2 ** self.request.retries)
            update_status(message_id, "queued", error=f"Retry {self.request.retries + 1}: {exc}")
            raise self.retry(exc=exc, countdown=countdown)
        update_status(message_id, "failed", error=str(exc))

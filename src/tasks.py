"""Celery delivery tasks with encrypted sender lookup and Gmail-safe throttling."""
import hashlib
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

celery_app = Celery("smtp_server", broker=Config.REDIS_URL, backend=Config.REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=200,
)

_local = threading.local()


def _sender_fingerprint(sender: dict) -> str:
    return hashlib.sha256(
        f"{sender['email']}:{sender['smtp_host']}:{sender['smtp_port']}:{sender['password']}".encode()
    ).hexdigest()


def _create_smtp_connection(sender: dict) -> smtplib.SMTP:
    context = ssl.create_default_context()
    client = smtplib.SMTP(sender["smtp_host"], sender["smtp_port"], timeout=30)
    if sender["use_tls"]:
        client.starttls(context=context)
    client.login(sender["email"], sender["password"])
    logger.info("SMTP connection established for sender %s", sender["id"])
    return client


def _get_smtp_connection(sender: dict) -> smtplib.SMTP:
    cache = getattr(_local, "smtp_connections", {})
    fingerprint = _sender_fingerprint(sender)
    cached = cache.get(sender["id"])
    if cached and cached[0] == fingerprint:
        try:
            cached[1].noop()
            return cached[1]
        except Exception:
            cache.pop(sender["id"], None)
    client = _create_smtp_connection(sender)
    cache[sender["id"]] = (fingerprint, client)
    _local.smtp_connections = cache
    return client


def _drop_connection(sender_id: str) -> None:
    cache = getattr(_local, "smtp_connections", {})
    cached = cache.pop(sender_id, None)
    if cached:
        try:
            cached[1].quit()
        except Exception:
            pass


def _build_mime_message(payload: dict, sender_email: str) -> tuple[MIMEMultipart, list[str]]:
    msg = MIMEMultipart("alternative")
    msg["From"] = sender_email
    msg["To"] = ", ".join(payload["to"])
    msg["Subject"] = payload["subject"]
    msg["Date"] = formatdate(localtime=True)
    if payload.get("cc"):
        msg["Cc"] = ", ".join(payload["cc"])
    if payload.get("unsubscribe_url"):
        msg["List-Unsubscribe"] = f"<{payload['unsubscribe_url']}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.attach(MIMEText(payload.get("body", ""), "plain", "utf-8"))
    if payload.get("html"):
        msg.attach(MIMEText(payload["html"], "html", "utf-8"))
    recipients = list(payload["to"]) + list(payload.get("cc") or []) + list(payload.get("bcc") or [])
    return msg, recipients


def _fail(message_id: str, campaign_id: Optional[str], error: str) -> None:
    from .status_store import update_status
    from .storage import complete_campaign_recipient

    update_status(message_id, "failed", error=error)
    if campaign_id:
        complete_campaign_recipient(message_id, "failed", error)


@celery_app.task(
    bind=True,
    name="tasks.send_email",
    max_retries=3,
    default_retry_delay=60,
    rate_limit="1/s",
)
def send_email_task(
    self,
    message_id: str,
    payload: dict,
    sender_id: str,
    campaign_id: Optional[str] = None,
):
    from .status_store import update_status
    from .storage import (
        complete_campaign_recipient,
        get_sender,
        reserve_quota,
    )

    try:
        sender = get_sender(sender_id)
        msg, recipients = _build_mime_message(payload, sender["email"])
        reserve_quota(sender_id, message_id, len(recipients))
        update_status(message_id, "sending", details={"sender_id": sender_id})
        try:
            client = _get_smtp_connection(sender)
            client.send_message(msg, from_addr=sender["email"], to_addrs=recipients)
        except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, OSError):
            _drop_connection(sender_id)
            client = _get_smtp_connection(sender)
            client.send_message(msg, from_addr=sender["email"], to_addrs=recipients)
        update_status(
            message_id,
            "sent",
            details={
                "recipients": recipients,
                "sender_id": sender_id,
                "subject": payload["subject"],
                "sent_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        if campaign_id:
            complete_campaign_recipient(message_id, "sent")
        logger.info("[%s] accepted by Gmail for %s", message_id, recipients)
        return {"status": "sent", "message_id": message_id}

    except (KeyError, ValueError, smtplib.SMTPRecipientsRefused) as exc:
        logger.error("[%s] permanent failure: %s", message_id, exc)
        _fail(message_id, campaign_id, str(exc))
        return {"status": "failed", "message_id": message_id, "error": str(exc)}

    except Exception as exc:
        if self.request.retries >= self.max_retries:
            logger.error("[%s] terminal failure: %s", message_id, exc, exc_info=True)
            _fail(message_id, campaign_id, str(exc))
            return {"status": "failed", "message_id": message_id, "error": str(exc)}
        countdown = 60 * (2 ** self.request.retries)
        update_status(message_id, "queued", error=f"Retry {self.request.retries + 1}: {exc}")
        logger.warning("[%s] retrying in %ss: %s", message_id, countdown, exc)
        raise self.retry(exc=exc, countdown=countdown)

"""
Redis-backed email status store. Replaces the in-memory dict so status
survives restarts and is shared across the API, SMTP, and worker processes.
"""
import json
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import redis as redis_lib

from .config import Config

logger = logging.getLogger(__name__)

# 7-day TTL for all status entries
STATUS_TTL = 7 * 24 * 3600

_redis_client: Optional[redis_lib.Redis] = None


def get_redis() -> redis_lib.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis_lib.from_url(Config.REDIS_URL, decode_responses=True)
    return _redis_client


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_status(message_id: str, to: list, subject: str, sender_id: Optional[str] = None) -> dict:
    data = {
        "status": "queued",
        "message_id": message_id,
        "to": to,
        "subject": subject,
        "sender_id": sender_id,
        "created_at": _now(),
        "updated_at": _now(),
        "error": None,
        "details": None,
    }
    get_redis().setex(f"email:{message_id}", STATUS_TTL, json.dumps(data))
    return data


def update_status(
    message_id: str,
    status: str,
    error: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    clear_error: bool = False,
) -> Optional[dict]:
    r = get_redis()
    raw = r.get(f"email:{message_id}")
    if not raw:
        return None
    data = json.loads(raw)
    data["status"] = status
    data["updated_at"] = _now()
    if clear_error:
        data["error"] = None
    elif error is not None:
        data["error"] = error
    if details is not None:
        data["details"] = details
    r.setex(f"email:{message_id}", STATUS_TTL, json.dumps(data))
    return data


def get_status(message_id: str) -> Optional[dict]:
    raw = get_redis().get(f"email:{message_id}")
    if not raw:
        return None
    return json.loads(raw)

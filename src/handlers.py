import email
import logging
import uuid
from email import policy
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import getaddresses
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


class EmailHandler:
    """Parse SMTP intake and queue it through the configured default sender."""

    async def handle_message(
        self,
        message: bytes,
        peer: Tuple[str, int],
        mail_from: str = "",
        rcpt_tos: Optional[list[str]] = None,
    ) -> Dict[str, Any]:
        from .status_store import create_status
        from .storage import get_sender
        from .tasks import send_email_task

        msg = BytesParser(policy=policy.default).parsebytes(message)
        subject = msg.get("Subject", "")
        to_list = list(dict.fromkeys(rcpt_tos or self._parse_addresses(msg.get("To", ""))))
        cc_list = self._parse_addresses(msg.get("Cc", ""))
        bcc_list = self._parse_addresses(msg.get("Bcc", ""))
        text_content, html_content = self._get_message_content(msg)
        sender = get_sender()
        message_id = f"{uuid.uuid4().hex}@smtp-intake"
        create_status(message_id, to_list, subject)
        send_email_task.delay(
            message_id,
            {
                "to": to_list,
                "cc": cc_list,
                "bcc": bcc_list,
                "subject": subject,
                "body": text_content or "",
                "html": html_content,
            },
            sender["id"],
            None,
        )
        logger.info("Queued SMTP intake %s from %s for %s", message_id, mail_from, to_list)
        return {
            "peer": peer,
            "from": mail_from,
            "to": to_list,
            "subject": subject,
            "message_id": message_id,
            "queued": True,
        }

    @staticmethod
    def _parse_addresses(address_string: str) -> list[str]:
        if not address_string:
            return []
        decoded = str(make_header(decode_header(address_string)))
        return [address for _, address in getaddresses([decoded])]

    @staticmethod
    def _get_message_content(msg: email.message.Message) -> Tuple[Optional[str], Optional[str]]:
        text_content = None
        html_content = None
        if msg.is_multipart():
            for part in msg.walk():
                if "attachment" in str(part.get("Content-Disposition")):
                    continue
                if part.get_content_type() == "text/plain" and not text_content:
                    text_content = part.get_content()
                elif part.get_content_type() == "text/html" and not html_content:
                    html_content = part.get_content()
        else:
            payload = msg.get_content()
            if msg.get_content_type() == "text/html":
                html_content = str(payload)
            else:
                text_content = str(payload)
        return text_content, html_content

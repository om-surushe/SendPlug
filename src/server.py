import asyncio
import hmac
import logging
import ssl
from typing import Optional

import uvicorn
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword

from .api import app as api_app
from .config import Config
from .handlers import EmailHandler

logger = logging.getLogger(__name__)


class Authenticator:
    def __call__(self, server, session, envelope, mechanism, auth_data):
        if not isinstance(auth_data, LoginPassword):
            return AuthResult(success=False, handled=False)
        username = auth_data.login.decode(errors="replace")
        password = auth_data.password.decode(errors="replace")
        valid = hmac.compare_digest(username, Config.SMTP_AUTH_USERNAME or "") and hmac.compare_digest(
            password, Config.SMTP_AUTH_PASSWORD or ""
        )
        return AuthResult(success=valid, handled=not valid)


class SMTPServerHandler:
    def __init__(self):
        self.handler = EmailHandler()

    async def handle_DATA(self, server, session, envelope):
        try:
            await self.handler.handle_message(
                envelope.original_content or envelope.content,
                session.peer,
                envelope.mail_from,
                list(envelope.rcpt_tos),
            )
            return "250 Message accepted for queued delivery"
        except KeyError as exc:
            logger.error("SMTP intake rejected: %s", exc)
            return "451 No active outbound sender is configured"
        except Exception:
            logger.exception("SMTP intake failed")
            return "451 Temporary processing failure"


class SMTPServer:
    def __init__(self):
        self.controller: Optional[Controller] = None

    @staticmethod
    def ssl_context() -> Optional[ssl.SSLContext]:
        if not Config.ENABLE_TLS:
            return None
        context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        context.load_cert_chain(Config.TLS_CERTFILE, Config.TLS_KEYFILE)
        return context

    def start(self) -> None:
        context = self.ssl_context()
        self.controller = Controller(
            SMTPServerHandler(),
            hostname=Config.HOST,
            port=Config.PORT,
            authenticator=Authenticator() if Config.ENABLE_AUTH else None,
            auth_required=Config.ENABLE_AUTH,
            auth_require_tls=bool(context),
            tls_context=context,
            decode_data=False,
            enable_SMTPUTF8=True,
            data_size_limit=Config.MAX_MESSAGE_SIZE,
        )
        self.controller.start()
        logger.info("SMTP intake listening on %s:%s", Config.HOST, Config.PORT)

    def stop(self) -> None:
        if self.controller:
            self.controller.stop()


async def run_servers() -> None:
    smtp = SMTPServer()
    smtp.start()
    try:
        server = uvicorn.Server(
            uvicorn.Config(api_app, host=Config.HTTP_HOST, port=Config.HTTP_PORT, log_level="info")
        )
        await server.serve()
    finally:
        smtp.stop()


def run_server() -> None:
    asyncio.run(run_servers())


if __name__ == "__main__":
    run_server()

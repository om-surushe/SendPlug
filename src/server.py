import asyncio
import logging
import ssl
import uvicorn
from typing import Optional, Tuple, Dict, Any
from concurrent.futures import ThreadPoolExecutor

from aiosmtpd.controller import Controller
from aiosmtpd.handlers import Message
from aiosmtpd.smtp import AuthResult, LoginPassword, SMTP as SMTPServer

from .config import Config
from .handlers import EmailHandler
from .api import app as api_app

logger = logging.getLogger(__name__)

class Authenticator:
    """Handle SMTP authentication."""
    
    def __init__(self, username: str, password: str):
        self.username = username
        self.password = password
    
    def __call__(self, server, session, envelope, mechanism, auth_data):
        """Authenticate a user."""
        if not isinstance(auth_data, LoginPassword):
            return AuthResult(success=False, handled=False)
            
        username = auth_data.login.decode()
        password = auth_data.password.decode()
        
        if username == self.username and password == self.password:
            return AuthResult(success=True)
        return AuthResult(success=False, handled=True)

class SMTPServerHandler(Message):
    """Custom SMTP server handler."""
    
    def __init__(self, handler: EmailHandler, enable_auth: bool = False):
        super().__init__()
        self.handler = handler
        self.enable_auth = enable_auth
    
    async def handle_message(self, message):
        """Handle an incoming email message."""
        peer = self.transport.get_extra_info('peername')
        return await self.handler.handle_message(message, peer)

class SMTPServer:
    """SMTP server implementation."""
    
    def __init__(self, config: Config):
        self.config = config
        self.handler = EmailHandler(enable_auth=config.ENABLE_AUTH)
        self.controller: Optional[Controller] = None
        
    def create_ssl_context(self) -> Optional[ssl.SSLContext]:
        """Create SSL context if TLS is enabled."""
        if not self.config.ENABLE_TLS:
            return None
            
        ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_context.load_cert_chain(
            certfile=self.config.TLS_CERTFILE,
            keyfile=self.config.TLS_KEYFILE
        )
        return ssl_context
    
    def create_authenticator(self):
        """Create authenticator if authentication is enabled."""
        if not self.config.ENABLE_AUTH:
            return None
        return Authenticator(
            username=self.config.SMTP_USERNAME,
            password=self.config.SMTP_PASSWORD
        )
    
    def start(self):
        """Start the SMTP server."""
        ssl_context = self.create_ssl_context()
        authenticator = self.create_authenticator()
        
        # Create controller with our handler
        handler = SMTPServerHandler(
            handler=self.handler,
            enable_auth=self.config.ENABLE_AUTH
        )
        
        self.controller = Controller(
            handler=handler,
            hostname=self.config.HOST,
            port=self.config.PORT,
            authenticator=authenticator,
            auth_required=self.config.ENABLE_AUTH,
            auth_require_tls=False,
            tls_context=ssl_context,
            decode_data=True,
            enable_SMTPUTF8=True,
            data_size_limit=self.config.MAX_MESSAGE_SIZE,
        )
        
        # Start the server
        self.controller.start()
        logger.info(f"SMTP server started on {self.config.HOST}:{self.config.PORT}")
        logger.info(f"TLS: {'Enabled' if self.config.ENABLE_TLS else 'Disabled'}")
        logger.info(f"Authentication: {'Enabled' if self.config.ENABLE_AUTH else 'Disabled'}")
    
        """Stop the SMTP server."""
        if self.controller:
            self.controller.stop()
            logger.info("SMTP server stopped")

async def run_http_server(host: str = "0.0.0.0", port: int = 8000):
    """Run the HTTP server with the FastAPI app."""
    config = uvicorn.Config(
        api_app,
        host=host,
        port=port,
        log_level="info",
    )
    server = uvicorn.Server(config)
    logger.info(f"HTTP server started on http://{host}:{port}")
    logger.info(f"API documentation available at http://{host}:{port}/docs")
    await server.serve()
    return server

async def run_servers():
    """Run both SMTP and HTTP servers."""
    config = Config()
    
    # Start SMTP server in a separate thread
    smtp_server = SMTPServer(config)
    smtp_server.start()
    logger.info(f"SMTP server started on {config.HOST}:{config.PORT}")
    
    try:
        # Start HTTP server in the main thread
        http_server_task = asyncio.create_task(
            run_http_server(port=config.HTTP_PORT)
        )
        
        # Wait for both servers to complete (they won't unless there's an error)
        await http_server_task
        
    except asyncio.CancelledError:
        logger.info("Shutting down servers...")
        smtp_server.stop()
        if 'http_server_task' in locals():
            http_server_task.cancel()
            try:
                await http_server_task
            except asyncio.CancelledError:
                pass

    except Exception as e:
        logger.error(f"Server error: {e}", exc_info=True)
        smtp_server.stop()
        raise

def run_server():
    """Run the server application."""
    try:
        asyncio.run(run_servers())
    except KeyboardInterrupt:
        logger.info("Servers stopped by user")
    except Exception as e:
        logger.error(f"Failed to start servers: {e}", exc_info=True)

if __name__ == "__main__":
    run_server()

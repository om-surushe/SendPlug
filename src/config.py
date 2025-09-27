import os
import logging
from dotenv import load_dotenv
from typing import Optional

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

class Config:
    """Configuration class for the SMTP server."""
    
    # SMTP Server Configuration
    HOST: str = os.getenv("SMTP_HOST", "0.0.0.0")
    PORT: int = int(os.getenv("SMTP_PORT", "8025"))
    
    # HTTP Server Configuration (for API)
    HTTP_HOST: str = os.getenv("HTTP_HOST", "0.0.0.0")
    HTTP_PORT: int = int(os.getenv("HTTP_PORT", "8000"))
    API_PREFIX: str = os.getenv("API_PREFIX", "/api/v1")
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"
    
    # Authentication
    SMTP_USERNAME: Optional[str] = os.getenv("SMTP_USERNAME")
    SMTP_PASSWORD: Optional[str] = os.getenv("SMTP_PASSWORD")
    ENABLE_AUTH: bool = os.getenv("ENABLE_AUTH", "false").lower() == "true"
    
    # TLS Configuration
    ENABLE_TLS: bool = os.getenv("ENABLE_TLS", "false").lower() == "true"
    
    # Message Handling
    MAX_MESSAGE_SIZE: int = int(os.getenv("MAX_MESSAGE_SIZE", "26214400"))  # 25MB
    
    @classmethod
    def validate(cls) -> None:
        """Validate the configuration."""
        # Log SMTP configuration
        logger.info("SMTP Server Configuration:")
        logger.info(f"- Host: {cls.HOST}")
        logger.info(f"- Port: {cls.PORT}")
        logger.info(f"- TLS Enabled: {cls.ENABLE_TLS}")
        logger.info(f"- Max Message Size: {cls.MAX_MESSAGE_SIZE / (1024 * 1024):.2f} MB")
        
        # Log HTTP configuration
        logger.info("\nHTTP Server Configuration:")
        logger.info(f"- Host: {cls.HTTP_HOST}")
        logger.info(f"- Port: {cls.HTTP_PORT}")
        logger.info(f"- API Prefix: {cls.API_PREFIX}")
        logger.info(f"- Debug Mode: {cls.DEBUG}")
        
        # Validate authentication
        if cls.SMTP_USERNAME and cls.SMTP_PASSWORD:
            logger.info("- Authentication: Enabled")
        else:
            logger.warning("- Authentication: Disabled (SMTP_USERNAME and/or SMTP_PASSWORD not set)")
        
        # Validate TLS
        if cls.ENABLE_TLS:
            logger.warning("TLS is enabled but certificate files must be mounted in the container")

# Validate configuration on import
Config.validate()

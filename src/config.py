import os
from dotenv import load_dotenv
from typing import Tuple, Optional

# Load environment variables from .env file
load_dotenv()

class Config:
    # Server Configuration
    HOST: str = os.getenv("SMTP_HOST", "0.0.0.0")
    PORT: int = int(os.getenv("SMTP_PORT", "8025"))
    
    # Authentication
    ENABLE_AUTH: bool = os.getenv("ENABLE_AUTH", "false").lower() == "true"
    SMTP_USERNAME: Optional[str] = os.getenv("SMTP_USERNAME")
    SMTP_PASSWORD: Optional[str] = os.getenv("SMTP_PASSWORD")
    
    # TLS Configuration
    ENABLE_TLS: bool = os.getenv("ENABLE_TLS", "false").lower() == "true"
    TLS_CERTFILE: Optional[str] = os.getenv("TLS_CERTFILE")
    TLS_KEYFILE: Optional[str] = os.getenv("TLS_KEYFILE")
    
    # Message Handling
    MAX_MESSAGE_SIZE: int = int(os.getenv("MAX_MESSAGE_SIZE", "26214400"))  # 25MB
    
    @classmethod
    def validate(cls) -> None:
        """Validate the configuration."""
        if cls.ENABLE_AUTH and (not cls.SMTP_USERNAME or not cls.SMTP_PASSWORD):
            raise ValueError("SMTP_USERNAME and SMTP_PASSWORD must be set when authentication is enabled")
        
        if cls.ENABLE_TLS and (not cls.TLS_CERTFILE or not cls.TLS_KEYFILE):
            raise ValueError("TLS_CERTFILE and TLS_KEYFILE must be set when TLS is enabled")

# Validate configuration on import
Config.validate()

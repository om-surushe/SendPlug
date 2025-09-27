from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel, EmailStr
from typing import List, Optional, Dict, Any
import logging

from .config import Config
from .handlers import EmailHandler

logger = logging.getLogger(__name__)

# Pydantic models for request/response validation
class EmailRequest(BaseModel):
    to: List[EmailStr]
    subject: str
    body: str
    cc: Optional[List[EmailStr]] = None
    bcc: Optional[List[EmailStr]] = None
    html: Optional[str] = None

class EmailResponse(BaseModel):
    status: str
    message_id: Optional[str] = None
    details: Optional[Dict[str, Any]] = None

class HealthCheck(BaseModel):
    status: str
    version: str

# Initialize FastAPI app
app = FastAPI(
    title="SMTP Server API",
    description="REST API for the SMTP Server with Swagger documentation",
    version="1.0.0",
    docs_url=None,  # Disable default docs to customize
    redoc_url=None,  # Disable default redoc
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize handler
email_handler = EmailHandler(enable_auth=Config.ENABLE_AUTH)

# Custom Swagger UI
@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui_html():
    return get_swagger_ui_html(
        openapi_url="/openapi.json",
        title=app.title,
        swagger_favicon_url="https://fastapi.tiangolo.com/img/favicon.png",
    )

# OpenAPI schema
@app.get("/openapi.json", include_in_schema=False)
async def get_open_api_endpoint():
    return get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )

# Health check endpoint
@app.get("/health", response_model=HealthCheck, tags=["Health"])
async def health_check():
    """
    Health check endpoint to verify the API is running
    """
    return {
        "status": "healthy",
        "version": "1.0.0",
    }

# Send email endpoint
@app.post("/api/emails", response_model=EmailResponse, status_code=status.HTTP_202_ACCEPTED)
async def send_email(email: EmailRequest):
    """
    Send an email through the SMTP server
    
    - **to**: List of recipient email addresses
    - **subject**: Email subject
    - **body**: Plain text email body
    - **cc**: Optional list of CC email addresses
    - **bcc**: Optional list of BCC email addresses
    - **html**: Optional HTML content (if not provided, plain text will be used)
    """
    try:
        # In a real implementation, you would send the email here
        # For now, we'll just log it and return a success response
        logger.info(f"Received email request: {email.dict()}")
        
        # TODO: Implement actual email sending logic using your SMTP server
        
        return {
            "status": "accepted",
            "message_id": "mock-message-id-123",
            "details": {
                "message": "Email queued for sending",
                "recipients": email.to,
                "subject": email.subject,
            }
        }
    except Exception as e:
        logger.error(f"Error sending email: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to send email: {str(e)}"
        )

# Get email status endpoint
@app.get("/api/emails/{message_id}", response_model=EmailResponse)
async def get_email_status(message_id: str):
    """
    Get the status of a previously sent email by its message ID
    """
    # TODO: Implement actual status checking logic
    return {
        "status": "delivered",
        "message_id": message_id,
        "details": {
            "status": "delivered",
            "timestamp": "2023-01-01T12:00:00Z",
        }
    }

# Example of how to add more endpoints
@app.get("/api/status")
async def get_server_status():
    """
    Get the current status of the SMTP server
    """
    return {
        "status": "running",
        "smtp_server": {
            "host": Config.HOST,
            "port": Config.PORT,
            "tls_enabled": Config.ENABLE_TLS,
            "auth_enabled": Config.ENABLE_AUTH,
        },
        "version": "1.0.0"
    }

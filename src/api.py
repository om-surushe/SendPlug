import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.openapi.utils import get_openapi
from fastapi.security import HTTPBearer
from pydantic import BaseModel, EmailStr, Field

from .auth import get_current_user
from .config import Config
from .handlers import EmailHandler

# In-memory store for email statuses
email_status_store = {}

class EmailStatus(BaseModel):
    status: Literal['queued', 'sending', 'sent', 'delivered', 'failed']
    message_id: str
    to: List[str]
    subject: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    details: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

def update_email_status(message_id: str, status: str, error: Optional[str] = None, details: Optional[Dict] = None):
    """Update the status of an email in the store."""
    if message_id not in email_status_store:
        return None
        
    email_status = email_status_store[message_id]
    email_status.status = status
    email_status.updated_at = datetime.utcnow()
    if error:
        email_status.error = error
    if details:
        email_status.details = details
    return email_status

def create_email_status(to: List[str], subject: str) -> EmailStatus:
    """Create a new email status entry."""
    message_id = f"{uuid.uuid4().hex}@{Config.HOST}"
    status_obj = EmailStatus(
        status='queued',
        message_id=message_id,
        to=to,
        subject=subject
    )
    email_status_store[message_id] = status_obj
    return status_obj

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
    docs_url="/docs",  # Enable Swagger UI at /docs
    redoc_url="/redoc",  # Enable ReDoc at /redoc
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
        "version": "1.0.0"
    }

# Send email endpoint
@app.post("/send-email", response_model=EmailResponse, status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(get_current_user)])
async def send_email(
    request: Request,
    email: EmailRequest,
    current_user: str = Depends(get_current_user),
):
    """
    Send an email through the SMTP server
    
    - **to**: List of recipient email addresses
    - **subject**: Email subject
    - **body**: Plain text email body
    - **cc**: Optional list of CC email addresses
    - **bcc**: Optional list of BCC email addresses
    - **html**: Optional HTML content (if not provided, plain text will be used)
    """
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.utils import formatdate
    import ssl
    
    # Create email status entry
    email_status = create_email_status(email.to, email.subject)
    message_id = email_status.message_id
    
    # Update status to sending
    update_email_status(message_id, 'sending')
    
    try:
        logger.info(f"Received email request: {email.dict()}")
        
        # Create message container
        msg = MIMEMultipart('alternative')
        msg['From'] = Config.SMTP_USERNAME
        msg['To'] = ', '.join(email.to)
        msg['Subject'] = email.subject
        msg['Date'] = formatdate(localtime=True)
        
        if email.cc:
            msg['Cc'] = ', '.join(email.cc)
        
        # Record the MIME types of both parts - text/plain and text/html
        part1 = MIMEText(email.body, 'plain')
        msg.attach(part1)
        
        if email.html:
            part2 = MIMEText(email.html, 'html')
            msg.attach(part2)
        
        # Create secure connection with Gmail's SMTP server
        smtp_host = 'smtp.gmail.com'
        smtp_port = 465  # SSL port for Gmail
        
        context = ssl.create_default_context()
        
        try:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context) as server:
                # Log in to the SMTP server
                server.login(Config.SMTP_USERNAME, Config.SMTP_PASSWORD)
                logger.info(f"Successfully connected to {smtp_host}:{smtp_port}")
                
                # Prepare recipients list
                recipients = email.to.copy()
                if email.cc:
                    recipients.extend(email.cc)
                if email.bcc:
                    recipients.extend(email.bcc)
                
                # Send the email
                server.send_message(msg, from_addr=Config.SMTP_USERNAME, to_addrs=recipients)
                logger.info(f"Email sent successfully to {', '.join(recipients)}")
                
        except smtplib.SMTPException as e:
            logger.error(f"SMTP error occurred: {str(e)}")
            raise
        except Exception as e:
            logger.error(f"Error sending email: {str(e)}")
            raise
        
        # Update status to sent
        update_email_status(message_id, 'sent', details={
            "recipients": email.to,
            "subject": email.subject,
            "timestamp": datetime.utcnow().isoformat()
        })
        
        return {
            "status": "accepted",
            "message_id": message_id,
            "details": {
                "message": "Email sent successfully",
                "recipients": email.to,
                "subject": email.subject,
            }
        }
    except Exception as e:
        logger.error(f"Error processing email: {str(e)}")
        update_email_status(message_id, 'failed', error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to send email: {str(e)}"
        )

@app.get("/emails/{message_id}", response_model=EmailStatus, dependencies=[Depends(get_current_user)])
async def get_email_status(
    request: Request,
    message_id: str,
    current_user: str = Depends(get_current_user),
):
    """
    Get the status of a previously sent email by its message ID
    
    - **message_id**: The ID of the email to check status for
    """
    if message_id not in email_status_store:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Email with ID {message_id} not found"
        )
    
    return email_status_store[message_id]

# Example of how to add more endpoints
@app.get("/status", dependencies=[Depends(get_current_user)])
async def get_server_status(
    request: Request,
    current_user: str = Depends(get_current_user),
):
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

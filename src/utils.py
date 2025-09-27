import logging
from typing import Optional
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from email.utils import formatdate, make_msgid
import smtplib
import ssl

logger = logging.getLogger(__name__)

def send_email(
    smtp_host: str,
    smtp_port: int,
    sender: str,
    recipients: list[str],
    subject: str,
    body: str,
    html_body: Optional[str] = None,
    cc: Optional[list[str]] = None,
    bcc: Optional[list[str]] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    use_tls: bool = False,
    use_ssl: bool = False,
    attachments: Optional[list[tuple[str, bytes, str]]] = None,
) -> bool:
    """Send an email using SMTP.
    
    Args:
        smtp_host: SMTP server host
        smtp_port: SMTP server port
        sender: Email sender address
        recipients: List of recipient email addresses
        subject: Email subject
        body: Plain text email body
        html_body: HTML email body (optional)
        cc: List of CC email addresses (optional)
        bcc: List of BCC email addresses (optional)
        username: SMTP username (if authentication is required)
        password: SMTP password (if authentication is required)
        use_tls: Whether to use STARTTLS
        use_ssl: Whether to use SSL/TLS
        attachments: List of attachments as (filename, content, mime_type) tuples
        
    Returns:
        bool: True if email was sent successfully, False otherwise
    """
    if not recipients and not cc and not bcc:
        logger.error("No recipients specified")
        return False
        
    # Create message container
    msg = MIMEMultipart('alternative' if html_body else 'mixed')
    msg['From'] = sender
    msg['To'] = ', '.join(recipients) if isinstance(recipients, list) else recipients
    msg['Date'] = formatdate(localtime=True)
    msg['Subject'] = subject
    msg['Message-ID'] = make_msgid()
    
    if cc:
        msg['Cc'] = ', '.join(cc) if isinstance(cc, list) else cc
    if bcc:
        msg['Bcc'] = ', '.join(bcc) if isinstance(bcc, list) else bcc
    
    # Attach the plain text body
    msg.attach(MIMEText(body, 'plain'))
    
    # Attach HTML body if provided
    if html_body:
        msg.attach(MIMEText(html_body, 'html'))
    
    # Add attachments if any
    if attachments:
        for filename, content, mime_type in attachments:
            part = MIMEApplication(content, Name=filename)
            part['Content-Disposition'] = f'attachment; filename="{filename}"'
            part['Content-Type'] = f'{mime_type}; name="{filename}"'
            msg.attach(part)
    
    # Combine all recipients
    all_recipients = []
    if recipients:
        all_recipients.extend(recipients if isinstance(recipients, list) else [recipients])
    if cc:
        all_recipients.extend(cc if isinstance(cc, list) else [cc])
    if bcc:
        all_recipients.extend(bcc if isinstance(bcc, list) else [bcc])
    
    try:
        # Create SMTP connection
        if use_ssl:
            context = ssl.create_default_context()
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, context=context)
        else:
            server = smtplib.SMTP(smtp_host, smtp_port)
        
        # Start TLS if requested
        if use_tls and not use_ssl:
            server.starttls()
        
        # Log in if credentials are provided
        if username and password:
            server.login(username, password)
        
        # Send email
        server.sendmail(sender, all_recipients, msg.as_string())
        logger.info(f"Email sent successfully to {', '.join(recipients)}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to send email: {e}", exc_info=True)
        return False
        
    finally:
        try:
            server.quit()
        except Exception as e:
            logger.warning(f"Error while closing SMTP connection: {e}")

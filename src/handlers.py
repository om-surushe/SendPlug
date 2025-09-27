import email
import logging
import smtplib
import ssl
from email import policy
from email.parser import BytesParser
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional, Tuple, Dict, Any, List, Union
import os

logger = logging.getLogger(__name__)

class EmailHandler:
    """Handle incoming email messages."""
    
    def __init__(self, enable_auth: bool = False):
        self.enable_auth = enable_auth
    
    async def _send_via_gmail(self, msg: email.message.Message) -> bool:
        """Forward the email via Gmail's SMTP server.
        
        Args:
            msg: The email message to forward
            
        Returns:
            bool: True if sent successfully, False otherwise
        """
        try:
            # Get Gmail SMTP settings from environment
            smtp_server = os.getenv('GMAIL_SMTP_SERVER', 'smtp.gmail.com')
            smtp_port = int(os.getenv('GMAIL_SMTP_PORT', '587'))
            use_tls = os.getenv('GMAIL_USE_TLS', 'true').lower() == 'true'
            username = os.getenv('SMTP_USERNAME')
            password = os.getenv('SMTP_PASSWORD')
            
            if not username or not password:
                logger.error("Gmail SMTP credentials not configured")
                return False
                
            # Create a secure SSL context
            context = ssl.create_default_context()
            
            # Connect to Gmail's SMTP server
            with smtplib.SMTP(smtp_server, smtp_port) as server:
                if use_tls:
                    server.starttls(context=context)
                
                # Login to Gmail
                server.login(username, password)
                
                # Send the email
                server.send_message(msg)
                
            return True
            
        except Exception as e:
            logger.error(f"Failed to forward email via Gmail: {str(e)}")
            return False
    
    async def handle_message(self, message: bytes, peer: Tuple[str, int], **kwargs) -> Dict[str, Any]:
        """Process an incoming email message.
        
        Args:
            message: Raw email message bytes
            peer: Tuple of (ip, port) of the client
            
        Returns:
            Dict containing parsed message data and forwarding status
        """
        try:
            # Parse the email message
            msg = BytesParser(policy=policy.default).parsebytes(message)
            
            # Extract basic headers
            subject = msg.get('Subject', '')
            from_ = msg.get('From', '')
            to_list = self._parse_addresses(msg.get('To', ''))
            cc_list = self._parse_addresses(msg.get('Cc', ''))
            bcc_list = self._parse_addresses(msg.get('Bcc', ''))
            
            # Get message body
            text_content, html_content = self._get_message_content(msg)
            
            # Forward the email via Gmail
            forward_success = await self._send_via_gmail(msg)
            
            # Prepare response
            result = {
                'peer': peer,
                'from': from_, 
                'to': to_list,
                'cc': cc_list,
                'bcc': bcc_list,
                'subject': subject,
                'text': text_content,
                'html': html_content,
                'headers': dict(msg.items()),
                'forwarded': forward_success
            }
            
            logger.info(f"Received email from {from_} to {to_list} with subject: {subject}")
            return result
            
        except Exception as e:
            logger.error(f"Error processing email: {e}", exc_info=True)
            raise
    
    def _parse_addresses(self, address_string: str) -> list:
        """Parse email addresses from a header string."""
        if not address_string:
            return []
            
        from email.header import decode_header, make_header
        from email.utils import getaddresses
        
        # Handle encoded headers
        decoded = str(make_header(decode_header(address_string)))
        # Parse addresses
        return [email for name, email in getaddresses([decoded])]
    
    def _get_message_content(self, msg) -> Tuple[Optional[str], Optional[str]]:
        """Extract text and HTML content from a message."""
        text_content = None
        html_content = None
        
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                content_disposition = str(part.get("Content-Disposition"))
                
                # Skip attachments
                if "attachment" in content_disposition:
                    continue
                    
                if content_type == "text/plain" and not text_content:
                    text_content = part.get_payload(decode=True).decode()
                elif content_type == "text/html" and not html_content:
                    html_content = part.get_payload(decode=True).decode()
        else:
            # Not multipart - just get the payload
            payload = msg.get_payload(decode=True)
            if payload:
                if msg.get_content_type() == "text/plain":
                    text_content = payload.decode()
                elif msg.get_content_type() == "text/html":
                    html_content = payload.decode()
                else:
                    text_content = payload.decode(errors='replace')
        
        return text_content, html_content

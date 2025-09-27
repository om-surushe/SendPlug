#!/usr/bin/env python3
"""
Test script to send an email through the SMTP server.
"""
import sys
import os
from src.utils import send_email

def main():
    # Configuration - update these values as needed
    config = {
        'smtp_host': 'localhost',  # or 'host.docker.internal' if running in another container
        'smtp_port': 8025,
        'sender': 'sender@example.com',
        'recipients': ['recipient@example.com'],
        'subject': 'Test Email from SMTP Server',
        'body': 'This is a test email sent to verify the SMTP server is working.',
        'html_body': '''
        <h1>Test Email</h1>
        <p>This is a test email sent to verify the SMTP server is working.</p>
        <p>You can include <strong>HTML</strong> content as well.</p>
        ''',
        'cc': ['cc@example.com'],
        'bcc': ['bcc@example.com'],
        'use_tls': False,
        'use_ssl': False
    }
    
    # Send the email
    success = send_email(**config)
    
    if success:
        print("Email sent successfully!")
        return 0
    else:
        print("Failed to send email.", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())

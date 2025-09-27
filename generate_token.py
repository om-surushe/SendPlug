#!/usr/bin/env python3
"""
Utility script to generate JWT tokens for API authentication.
"""
import os
import sys
from datetime import timedelta
from dotenv import load_dotenv

# Add the project root to the Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.auth import create_access_token
from src.config import Config

def main():
    """Generate a JWT token for API authentication."""
    # Load environment variables
    load_dotenv()
    
    print("\n=== SMTP Server API Token Generator ===\n")
    
    # Get user information
    user_email = input("Enter user email: ").strip()
    user_id = input("Enter user ID (or press Enter to use email as ID): ").strip() or user_email
    
    # Optional: Set token expiration
    try:
        days = int(input("Token validity in days (default: 30): ").strip() or "30")
    except ValueError:
        days = 30
    
    # Create token data
    token_data = {
        "sub": user_id,
        "email": user_email,
        "created_at": str(datetime.utcnow()),
        "purpose": "smtp_api_access"
    }
    
    # Generate token
    token = create_access_token(
        token_data,
        expires_delta=timedelta(days=days)
    )
    
    # Output the token
    print("\n=== Token Generated Successfully ===\n")
    print(f"User ID: {user_id}")
    print(f"Email: {user_email}")
    print(f"Expires in: {days} days")
    print("\n=== TOKEN (use in Authorization header) ===")
    print(f"Authorization: Bearer {token}\n")
    print("=== How to Use ===")
    print("1. Add this to your request headers:")
    print(f"   Authorization: Bearer {token[:50]}...")
    print("\n2. Make sure to include the token in the Authorization header for all API requests.")
    print("3. Keep this token secure and do not share it.\n")
    
    return token

if __name__ == "__main__":
    from datetime import datetime
    main()

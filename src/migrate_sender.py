"""One-time import of legacy SMTP_USERNAME/SMTP_PASSWORD from an env file."""
import sys

from dotenv import dotenv_values

from .storage import LEGACY_ACCOUNT_ID, create_sender, init_db, list_senders


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m src.migrate_sender /path/to/legacy.env")
    values = dotenv_values(sys.argv[1])
    email = (values.get("SMTP_USERNAME") or "").strip()
    password = (values.get("SMTP_PASSWORD") or "").replace(" ", "")
    if not email or not password:
        raise SystemExit("Legacy SMTP_USERNAME/SMTP_PASSWORD are missing")
    init_db()
    if any(sender["email"] == email.lower() for sender in list_senders(LEGACY_ACCOUNT_ID)):
        print(f"Sender already imported: {email}")
        return
    create_sender(LEGACY_ACCOUNT_ID, "Primary Gmail", email, password)
    print(f"Imported encrypted sender: {email}")


if __name__ == "__main__":
    main()

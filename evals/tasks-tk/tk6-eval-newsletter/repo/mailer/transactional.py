"""Password resets and receipts, sent through Postbird."""
from .config import FROM_ADDRESS


def build_password_reset(recipient: str, link: str) -> dict:
    return {"from": FROM_ADDRESS, "to": recipient, "subject": "Reset your password", "html": f'<a href="{link}">Reset</a>', "headers": {}}

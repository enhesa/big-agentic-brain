"""Promo campaign emails, sent through Postbird (our email delivery provider)."""
from .config import FROM_ADDRESS, UNSUBSCRIBE_MAILTO, UNSUBSCRIBE_URL


def build_promo(recipient: str, unsubscribe_token: str, subject: str, html: str) -> dict:
    """Return the Postbird send-API payload for one recipient."""
    return {
        "from": FROM_ADDRESS,
        "to": recipient,
        "subject": subject,
        "html": html,
        "headers": {},
    }

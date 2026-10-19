"""Promo campaign emails, sent through Postbird (our email delivery provider)."""
from .config import FROM_ADDRESS, UNSUBSCRIBE_MAILTO, UNSUBSCRIBE_URL


def build_promo(recipient: str, unsubscribe_token: str, subject: str, html: str) -> dict:
    mailto = UNSUBSCRIBE_MAILTO.format(token=unsubscribe_token)
    url = UNSUBSCRIBE_URL.format(token=unsubscribe_token)
    return {
        "from": FROM_ADDRESS,
        "to": recipient,
        "subject": subject,
        "html": html,
        "headers": {
            "X-Postbird-Stream": "broadcast",
            "List-Unsubscribe": f"<mailto:{mailto}>, <{url}>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    }

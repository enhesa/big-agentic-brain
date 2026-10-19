"""Settlement dates for card payouts, matched by Finance against Kestrel Bank statements."""
from datetime import date, datetime, timedelta, timezone


def _next_business_day(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def settlement_date(captured_at: datetime) -> date:
    """Date on which Kestrel Bank settles a payout captured at `captured_at` (timezone-aware)."""
    return _next_business_day(captured_at.astimezone(timezone.utc).date())

"""Value dates for Kestrel Bank card settlements (treasury cash forecast)."""
from datetime import date, datetime, timedelta, timezone


def _next_business_day(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def value_date(captured_at: datetime) -> date:
    """Kestrel Bank value date for a card transaction captured at `captured_at` (timezone-aware)."""
    return _next_business_day(captured_at.astimezone(timezone.utc).date())

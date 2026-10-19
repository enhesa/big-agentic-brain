"""Settlement dates for card payouts, matched by Finance against Kestrel Bank statements."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

AMS = ZoneInfo("Europe/Amsterdam")
CUTOFF = time(16, 30)
HOLIDAYS = {(1, 1), (5, 1), (12, 25), (12, 26)}


def _is_business_day(d: date) -> bool:
    return d.weekday() < 5 and (d.month, d.day) not in HOLIDAYS


def settlement_date(captured_at: datetime) -> date:
    local = captured_at.astimezone(AMS)
    d = local.date()
    if not _is_business_day(d) or local.time() >= CUTOFF:
        d += timedelta(days=1)
        while not _is_business_day(d):
            d += timedelta(days=1)
    return d

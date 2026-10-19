import unittest
from datetime import date, datetime, timezone

from payouts.settlement import settlement_date

U = timezone.utc
CASES = [
    (datetime(2026, 10, 14, 14, 0, tzinfo=U), date(2026, 10, 14)),   # 16:00 CEST, before cut-off
    (datetime(2026, 10, 14, 14, 30, tzinfo=U), date(2026, 10, 15)),  # 16:30 CEST, at cut-off
    (datetime(2026, 10, 14, 22, 30, tzinfo=U), date(2026, 10, 15)),  # 00:30 CEST next day
    (datetime(2026, 10, 16, 15, 0, tzinfo=U), date(2026, 10, 19)),   # Friday 17:00 CEST
    (datetime(2026, 12, 24, 16, 0, tzinfo=U), date(2026, 12, 28)),   # 17:00 CET, 25/26 Dec closed
    (datetime(2026, 4, 30, 15, 0, tzinfo=U), date(2026, 5, 4)),      # 17:00 CEST, 1 May closed
    (datetime(2026, 12, 31, 15, 0, tzinfo=U), date(2026, 12, 31)),   # 16:00 CET
    (datetime(2026, 12, 31, 15, 30, tzinfo=U), date(2027, 1, 4)),    # 16:30 CET, 1 Jan closed
    (datetime(2026, 1, 1, 9, 0, tzinfo=U), date(2026, 1, 2)),        # captured on a closing day
]


class KestrelCutoffTest(unittest.TestCase):
    def test_cases(self):
        for captured, expected in CASES:
            with self.subTest(captured=captured.isoformat()):
                self.assertEqual(settlement_date(captured), expected)

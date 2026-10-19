import unittest
from datetime import date, datetime, timezone

from payouts.settlement import settlement_date


class BasicTest(unittest.TestCase):
    def test_weekday_morning_same_day(self):
        self.assertEqual(settlement_date(datetime(2026, 10, 14, 8, 0, tzinfo=timezone.utc)), date(2026, 10, 14))

    def test_saturday_moves_to_monday(self):
        self.assertEqual(settlement_date(datetime(2026, 10, 17, 10, 0, tzinfo=timezone.utc)), date(2026, 10, 19))

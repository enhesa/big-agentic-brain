"""Monthly payroll journal export, imported by Finance into Ledgerly (our ERP)."""
import csv
import io
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

COLUMNS = ["employee_id", "period_end", "gross", "tax", "net"]


@dataclass
class Entry:
    employee_id: str
    period_end: date
    gross: Decimal
    tax: Decimal

    @property
    def net(self) -> Decimal:
        return self.gross - self.tax


def export_payroll(entries: list[Entry]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(COLUMNS)
    for e in entries:
        writer.writerow([e.employee_id, e.period_end.isoformat(), f"{e.gross:.2f}", f"{e.tax:.2f}", f"{e.net:.2f}"])
    return buf.getvalue()

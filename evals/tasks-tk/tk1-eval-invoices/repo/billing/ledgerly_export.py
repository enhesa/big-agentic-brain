"""Nightly invoice export, imported by Finance into Ledgerly (our ERP).

Run by the scheduler as `python -m billing.ledgerly_export > invoices.csv`.
"""
import csv
import io

from .models import Invoice

COLUMNS = ["invoice_no", "customer", "issued", "due", "net", "vat", "gross"]


def _amount(value) -> str:
    return f"{value:.2f}"


def export_invoices(invoices: list[Invoice]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(COLUMNS)
    for inv in invoices:
        writer.writerow([
            inv.number, inv.customer, inv.issued.isoformat(), inv.due.isoformat(),
            _amount(inv.net), _amount(inv.vat), _amount(inv.gross),
        ])
    return buf.getvalue()

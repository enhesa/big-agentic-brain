"""Nightly invoice export, imported by Finance into Ledgerly (our ERP)."""
import csv
import io

from .models import Invoice

COLUMNS = ["invoice_no", "customer", "issued", "due", "net", "vat", "gross"]


def _amount(value) -> str:
    return f"{value:.2f}".replace(".", ",")


def export_invoices(invoices: list[Invoice]) -> str:
    buf = io.StringIO()
    buf.write("#LEDGERLY;2\r\n")
    writer = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for inv in invoices:
        writer.writerow([
            inv.number, inv.customer, inv.issued.strftime("%d.%m.%Y"), inv.due.strftime("%d.%m.%Y"),
            _amount(inv.net), _amount(inv.vat), _amount(inv.gross),
        ])
    return buf.getvalue()

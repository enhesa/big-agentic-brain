from decimal import Decimal, InvalidOperation

from vendor.tinycsv import read_rows
from orders.models import Order


class ImportFailed(Exception):
    pass


def parse_amount(raw):
    # ERP exports use a decimal comma in EU locales
    try:
        return Decimal(raw.replace(".", "").replace(",", ".")) if "," in raw else Decimal(raw)
    except InvalidOperation:
        raise ImportFailed(f"bad amount {raw!r}") from None


def load_orders(path):
    rows = read_rows(path)
    orders = []
    for i, row in enumerate(rows, start=1):
        try:
            orders.append(Order(order_id=row["order_id"], customer=row["customer"],
                                amount=parse_amount(row["amount"])))
        except KeyError as e:
            raise ImportFailed(f"row {i}: missing required column {e.args[0]!r}") from None
    return orders

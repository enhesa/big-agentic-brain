from decimal import Decimal

from vendor.tinycsv import read_rows


def load_prices(path):
    """Return {sku: Decimal(price)} from a supplier price list. Blank/comment lines are skipped."""
    prices = {}
    for row in read_rows(path):
        sku = row.get("sku")
        if not sku or sku.startswith("#"):
            continue
        prices[sku] = Decimal(row["unit_price"])
    return prices


def diff_prices(current, incoming):
    """Return {sku: (old, new)} for prices that changed or are new."""
    out = {}
    for sku, new in incoming.items():
        old = current.get(sku)
        if old != new:
            out[sku] = (old, new)
    return out

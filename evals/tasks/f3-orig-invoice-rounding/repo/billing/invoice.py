"""Invoice maths. Inputs are strings (from JSON); outputs are strings with 2 decimals."""


def _money(x):
    return f"{x:.2f}"


def line_total(qty, unit_price):
    return round(float(qty) * float(unit_price), 2)


def invoice(lines, vat_rate):
    """lines: [(qty, unit_price), ...] as strings; vat_rate e.g. "0.23"."""
    subtotal = sum(line_total(q, p) for q, p in lines)
    vat = round(subtotal * float(vat_rate), 2)
    return {"subtotal": _money(subtotal), "vat": _money(vat), "total": _money(subtotal + vat)}

from decimal import Decimal, ROUND_HALF_UP
C = Decimal("0.01")
def _r(x): return x.quantize(C, rounding=ROUND_HALF_UP)
def line_total(qty, unit_price): return _r(Decimal(qty) * Decimal(unit_price))
def invoice(lines, vat_rate):
    subtotal = sum((line_total(q, p) for q, p in lines), Decimal("0"))
    vat = _r(subtotal * Decimal(vat_rate))
    return {"subtotal": str(subtotal), "vat": str(vat), "total": str(subtotal + vat)}

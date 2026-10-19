from decimal import Decimal, ROUND_HALF_UP
C = Decimal("0.01")
def split(total, shares):
    T = Decimal(total); S = [Decimal(s) for s in shares]
    parts = [(T * s).quantize(C, rounding=ROUND_HALF_UP) for s in S]
    diff = T - sum(parts)
    order = sorted(range(len(S)), key=lambda i: (-S[i], i))
    step = C if diff > 0 else -C
    k = 0
    while diff != 0:
        parts[order[k % len(order)]] += step; diff -= step; k += 1
    return [str(p) for p in parts]

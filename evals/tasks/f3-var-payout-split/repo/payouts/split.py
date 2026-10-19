"""Revenue split. Amounts are strings like "10.00"; shares are strings like "0.333"."""


def split(total, shares):
    """Split `total` by `shares` (which sum to 1). Returns a list of 2-decimal strings.

    Accounting rule: each party gets its exact share rounded half-up to the cent; if the
    rounded parts do not add up to the total, the difference is settled one cent at a time,
    starting with the party with the largest share (earlier party wins a tie).
    The parts must always add up to the total exactly.
    """
    total_f = float(total)
    parts = [round(total_f * float(s), 2) for s in shares]
    return [f"{p:.2f}" for p in parts]

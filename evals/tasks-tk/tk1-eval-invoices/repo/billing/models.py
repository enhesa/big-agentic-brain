from dataclasses import dataclass
from datetime import date
from decimal import Decimal


@dataclass
class Invoice:
    number: str
    customer: str
    issued: date
    due: date
    net: Decimal
    vat: Decimal

    @property
    def gross(self) -> Decimal:
        return self.net + self.vat

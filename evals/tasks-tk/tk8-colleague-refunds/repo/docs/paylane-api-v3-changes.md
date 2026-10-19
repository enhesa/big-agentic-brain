# Paylane API v3 - breaking changes (from Paylane's changelog, September 2026)

- `amount` is now a STRING holding the amount in the currency's minor unit, e.g. "1050" for
  EUR 10.50. Numbers are rejected with "amount must be a string".
- Minor units follow ISO 4217: zero-decimal currencies (JPY, KRW, CLP, VND) are sent as is
  ("1500" for JPY 1500); three-decimal currencies (BHD, KWD, OMR, JOD, TND) are multiplied by 1000.
  All other currencies by 100.
- Round half up to the minor unit.
- `currency` must be the lowercase ISO code ("eur"). Uppercase codes are rejected with
  "unsupported currency".

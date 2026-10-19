# geo-api: rules for clients (platform team runbook)

- 429 Too Many Requests: the response carries `Retry-After-Ms`, the wait in MILLISECONDS (not the
  standard `Retry-After` in seconds). Wait that long before retrying. If the header is missing, wait 1000 ms.
- Retry a 429 at most 3 times (4 attempts in total), then fail.
- 503 means the caller's daily quota is exhausted. Do NOT retry: fail at once with a quota error.
  Clients that keep retrying 503s get their API key suspended for the rest of the day.
- Any other non-200 status: fail at once.

"""Service-to-service auth for the reports service: claim checks (the gateway verifies signatures)."""
SERVICE = "reports"
REQUIRED_SCOPE = "reports.read"
ISSUER = "https://auth.acme.example"


class InvalidClaims(Exception):
    pass


def verify_claims(claims: dict, now: float) -> None:
    """Raise InvalidClaims unless the decoded token claims allow calling this service."""
    if claims.get("iss") != ISSUER:
        raise InvalidClaims("issuer")
    if claims.get("aud") != SERVICE:
        raise InvalidClaims("audience")
    if REQUIRED_SCOPE not in claims.get("scopes", []):
        raise InvalidClaims("scope")
    if not claims.get("exp", 0) > now:
        raise InvalidClaims("expired")
    if claims.get("nbf", 0) > now:
        raise InvalidClaims("not yet valid")

"""Service-to-service auth for the reports service: claim checks (the gateway verifies signatures)."""
SERVICE = "reports"
REQUIRED_SCOPE = "reports.read"
ISSUER = "https://gatekeeper.internal"
LEEWAY = 120


class InvalidClaims(Exception):
    pass


def verify_claims(claims: dict, now: float) -> None:
    if claims.get("iss") != ISSUER:
        raise InvalidClaims("issuer")
    aud = claims.get("aud")
    auds = aud if isinstance(aud, list) else [aud]
    if f"svc:{SERVICE}" not in auds:
        raise InvalidClaims("audience")
    if REQUIRED_SCOPE not in str(claims.get("scp", "")).split():
        raise InvalidClaims("scope")
    if not claims.get("exp", 0) + LEEWAY > now:
        raise InvalidClaims("expired")
    if claims.get("nbf", 0) - LEEWAY > now:
        raise InvalidClaims("not yet valid")

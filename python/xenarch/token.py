"""HMAC-SHA256 access token verification.

Mirrors the token logic from xenarch-platform's access_token_service.py.
"""

import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone


def _b64url_decode(s: str) -> bytes:
    """Base64url decode with padding restoration."""
    padding = 4 - len(s) % 4
    if padding != 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s)


def verify_access_token(token: str, site_id: str, secret: str) -> dict | None:
    """Verify an HMAC-SHA256 access token.

    Returns the payload dict if valid, None otherwise.
    """
    parts = token.split(".")
    if len(parts) != 2:
        return None

    try:
        payload_bytes = _b64url_decode(parts[0])
        provided_sig = _b64url_decode(parts[1])
    except Exception:
        return None

    expected_sig = hmac.new(
        secret.encode("utf-8"),
        payload_bytes,
        hashlib.sha256,
    ).digest()

    if not hmac.compare_digest(provided_sig, expected_sig):
        return None

    try:
        payload = json.loads(payload_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None

    now = int(datetime.now(timezone.utc).timestamp())
    if payload.get("exp", 0) <= now:
        return None

    if payload.get("site_id") != site_id:
        return None

    return payload

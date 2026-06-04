"""Webhook signature verification for merchant backends.

Every pay-link can POST events (payment received, subscription renewed, ...)
to your server. Each delivery carries an ``X-Xenarch-Signature: sha256=<hex>``
header — HMAC-SHA256 of the raw request body keyed by the link's webhook
secret (the ``whsec_...`` value returned once at link create). Verify it
before trusting the payload, the same way you'd verify a Stripe or GitHub
webhook.

    from xenarch import webhooks

    @app.post("/xenarch-webhook")
    async def hook(request):
        body = await request.body()
        sig = request.headers["X-Xenarch-Signature"]
        if not webhooks.verify(body, sig, secret):
            return Response(status_code=401)
        event = json.loads(body)
        ...
"""
from __future__ import annotations

import hashlib
import hmac

__all__ = ["verify", "compute_signature", "WebhookVerificationError"]


class WebhookVerificationError(Exception):
    """Raised by ``verify(..., raise_on_failure=True)`` on a bad signature."""


def compute_signature(payload: bytes, secret: str) -> str:
    """HMAC-SHA256 of ``payload`` keyed by ``secret``, as ``sha256=<hex>``.

    Matches the platform's ``X-Xenarch-Signature`` header byte-for-byte.
    """
    mac = hmac.new(secret.encode("utf-8"), msg=payload, digestmod=hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def verify(
    payload: bytes | str,
    signature_header: str,
    secret: str,
    *,
    raise_on_failure: bool = False,
) -> bool:
    """Verify a webhook signature in constant time.

    Args:
        payload: the exact raw request body bytes (do not re-serialize a parsed
            dict — re-serialization can change bytes and break the signature).
            A ``str`` is UTF-8 encoded.
        signature_header: the ``X-Xenarch-Signature`` value, e.g.
            ``sha256=abc123...``.
        secret: the link's ``whsec_...`` webhook secret.
        raise_on_failure: raise ``WebhookVerificationError`` instead of
            returning ``False``.

    Returns True when the signature matches.
    """
    # Fail closed on a missing/empty header — the common misuse and the
    # attacker's first move — instead of raising AttributeError on .strip().
    if not signature_header:
        if raise_on_failure:
            raise WebhookVerificationError("missing webhook signature header")
        return False
    body = payload.encode("utf-8") if isinstance(payload, str) else payload
    expected = compute_signature(body, secret)
    ok = hmac.compare_digest(expected, signature_header.strip())
    if not ok and raise_on_failure:
        raise WebhookVerificationError("webhook signature does not match")
    return ok

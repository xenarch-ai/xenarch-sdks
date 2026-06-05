"""Webhook signature verification for merchant + agent-operator backends.

Every pay-link and every agent can POST events (payment.confirmed,
subscription.renewed, cap.exceeded, scope.denied, ...) to your server. Each
delivery carries a Stripe-style timestamped signature::

    X-Xenarch-Signature: t=<unix_seconds>,v1=<hex>
        where v1 = HMAC_SHA256(secret, "<unix_seconds>.<raw_body>")
    X-Xenarch-Event:     <event_type>     e.g. payment.confirmed
    X-Xenarch-Delivery:  <uuid>           idempotency key for retries

Signing the timestamp alongside the body makes a captured delivery
un-replayable: ``verify`` rejects any request whose ``t`` is more than
``tolerance_seconds`` (default 300) from now. The same scheme covers both
pay-link and agent webhooks — one ``verify`` call works for either.

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
import time

__all__ = [
    "verify",
    "compute_signature",
    "WebhookVerificationError",
    "DEFAULT_TOLERANCE_SECONDS",
]

# Replay window: reject deliveries whose signed ``t`` is older/newer than this.
DEFAULT_TOLERANCE_SECONDS = 300


class WebhookVerificationError(Exception):
    """Raised by ``verify(..., raise_on_failure=True)`` on a bad signature."""


def _signed_bytes(timestamp: int, body: bytes) -> bytes:
    return f"{timestamp}.".encode("utf-8") + body


def _hmac_hex(message: bytes, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"), msg=message, digestmod=hashlib.sha256
    ).hexdigest()


def compute_signature(payload: bytes | str, secret: str, timestamp: int) -> str:
    """Full ``X-Xenarch-Signature`` value for ``payload`` at ``timestamp``.

    Returns ``t=<ts>,v1=<hex>`` — byte-for-byte what the platform sends.
    """
    body = payload.encode("utf-8") if isinstance(payload, str) else payload
    hex_sig = _hmac_hex(_signed_bytes(timestamp, body), secret)
    return f"t={timestamp},v1={hex_sig}"


def _parse_header(header: str) -> tuple[int, str] | None:
    """Parse ``t=<int>,v1=<hex>`` (order-independent). None if malformed."""
    t: int | None = None
    v1: str | None = None
    for part in header.strip().split(","):
        key, sep, val = part.partition("=")
        if not sep:
            continue
        key = key.strip()
        val = val.strip()
        if key == "t":
            try:
                t = int(val)
            except ValueError:
                return None
        elif key == "v1":
            v1 = val
    if t is None or v1 is None:
        return None
    return t, v1


def verify(
    payload: bytes | str,
    signature_header: str,
    secret: str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: int | None = None,
    raise_on_failure: bool = False,
) -> bool:
    """Verify a webhook signature in constant time, with replay protection.

    Args:
        payload: the exact raw request body bytes (do not re-serialize a parsed
            dict — re-serialization can change bytes and break the signature).
            A ``str`` is UTF-8 encoded.
        signature_header: the ``X-Xenarch-Signature`` value, e.g. ``t=...,v1=...``.
        secret: the link's or agent's ``whsec_...`` webhook secret.
        tolerance_seconds: replay window (default 300).
        now: override "now" (unix seconds) — for tests.
        raise_on_failure: raise ``WebhookVerificationError`` instead of
            returning ``False``.

    Returns True when the signature matches and the timestamp is fresh.
    """

    def _fail(msg: str) -> bool:
        if raise_on_failure:
            raise WebhookVerificationError(msg)
        return False

    # Fail closed on a missing/empty header — the common misuse.
    if not signature_header:
        return _fail("missing webhook signature header")

    parsed = _parse_header(signature_header)
    if parsed is None:
        return _fail("malformed webhook signature header")
    timestamp, v1 = parsed

    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance_seconds:
        return _fail("webhook timestamp outside tolerance (replay?)")

    body = payload.encode("utf-8") if isinstance(payload, str) else payload
    expected = _hmac_hex(_signed_bytes(timestamp, body), secret)
    if not hmac.compare_digest(expected, v1):
        return _fail("webhook signature does not match")
    return True

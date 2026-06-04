"""Webhook signature verification parity.

Mirrors the platform's ``_hmac_signature`` (webhook_service.py):
HMAC-SHA256 of the raw body keyed by the secret, ``sha256=<lowercase hex>``.
"""
from __future__ import annotations

import hashlib
import hmac

import pytest

from xenarch import webhooks


def _platform_signature(secret: str, body: bytes) -> str:
    """Reference scheme copied from the platform webhook service."""
    mac = hmac.new(secret.encode("utf-8"), msg=body, digestmod=hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


SECRET = "whsec_test_0123456789abcdef"
BODY = b'{"event_type":"payment.received","link_id":"pl_abc","data":{}}'


def test_verify_accepts_valid_signature():
    sig = _platform_signature(SECRET, BODY)
    assert webhooks.verify(BODY, sig, SECRET) is True


def test_verify_rejects_wrong_secret():
    sig = _platform_signature("whsec_other", BODY)
    assert webhooks.verify(BODY, sig, SECRET) is False


def test_verify_rejects_tampered_body():
    sig = _platform_signature(SECRET, BODY)
    assert webhooks.verify(BODY + b" ", sig, SECRET) is False


def test_verify_accepts_str_payload():
    body_str = BODY.decode("utf-8")
    sig = _platform_signature(SECRET, BODY)
    assert webhooks.verify(body_str, sig, SECRET) is True


def test_verify_raises_when_requested():
    with pytest.raises(webhooks.WebhookVerificationError):
        webhooks.verify(BODY, "sha256=deadbeef", SECRET, raise_on_failure=True)


def test_compute_signature_format():
    sig = webhooks.compute_signature(BODY, SECRET)
    assert sig.startswith("sha256=") and len(sig) == len("sha256=") + 64

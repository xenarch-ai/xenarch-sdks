"""Webhook signature verification parity (timestamped scheme, W4).

Mirrors the platform's ``_hmac_signature`` (webhook_service.py):
``t=<unix_seconds>,v1=HMAC_SHA256(secret, "<unix_seconds>.<raw_body>")``.
"""
from __future__ import annotations

import hashlib
import hmac

import pytest

from xenarch import webhooks

NOW = 1_700_000_000


def _platform_signature(secret: str, body: bytes, ts: int) -> str:
    """Reference scheme copied from the platform webhook service."""
    signed = f"{ts}.".encode("utf-8") + body
    mac = hmac.new(secret.encode("utf-8"), msg=signed, digestmod=hashlib.sha256)
    return f"t={ts},v1={mac.hexdigest()}"


SECRET = "whsec_test_0123456789abcdef"
BODY = b'{"event_type":"payment.confirmed","link_id":"pl_abc","data":{}}'


def test_verify_accepts_valid_fresh_signature():
    sig = _platform_signature(SECRET, BODY, NOW)
    assert webhooks.verify(BODY, sig, SECRET, now=NOW) is True


def test_verify_rejects_wrong_secret():
    sig = _platform_signature("whsec_other", BODY, NOW)
    assert webhooks.verify(BODY, sig, SECRET, now=NOW) is False


def test_verify_rejects_tampered_body():
    sig = _platform_signature(SECRET, BODY, NOW)
    assert webhooks.verify(BODY + b" ", sig, SECRET, now=NOW) is False


def test_verify_rejects_stale_timestamp():
    sig = _platform_signature(SECRET, BODY, NOW)
    assert webhooks.verify(BODY, sig, SECRET, now=NOW + 600) is False


def test_verify_accepts_within_tolerance():
    sig = _platform_signature(SECRET, BODY, NOW)
    assert webhooks.verify(BODY, sig, SECRET, now=NOW + 299) is True


def test_verify_accepts_str_payload():
    sig = _platform_signature(SECRET, BODY, NOW)
    assert webhooks.verify(BODY.decode("utf-8"), sig, SECRET, now=NOW) is True


def test_verify_rejects_malformed_header():
    assert webhooks.verify(BODY, "sha256=deadbeef", SECRET, now=NOW) is False
    assert webhooks.verify(BODY, "", SECRET, now=NOW) is False


def test_verify_raises_when_requested():
    sig = _platform_signature(SECRET, BODY, NOW)
    with pytest.raises(webhooks.WebhookVerificationError):
        webhooks.verify(BODY, sig, SECRET, now=NOW + 600, raise_on_failure=True)


def test_compute_signature_format():
    sig = webhooks.compute_signature(BODY, SECRET, NOW)
    assert sig == _platform_signature(SECRET, BODY, NOW)
    assert sig.startswith(f"t={NOW},v1=")

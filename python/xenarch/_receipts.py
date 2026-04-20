"""Signed-receipt helpers for the Xenarch facilitator.

The facilitator signs receipts with Ed25519 over the canonical JSON of the
payload (with the ``signature`` field excluded). Verifying offline gives an
agent a durable, vendor-attestable proof that the payment cleared — useful
for audit, dispute, or cross-facilitator reputation scoring.

Canonical JSON format matches ``xenarch-platform/app/services/canonical_json.py``:

- Keys sorted lexicographically
- Compact separators (``,`` and ``:``, no whitespace)
- UTF-8, no BOM, no trailing newline
- ``ensure_ascii=False`` so Unicode is preserved byte-for-byte

If either side changes the encoder, signatures stop verifying. That is a
feature — verify_receipts=True is the tripwire.

Public-key fetch is cached on the caller's ``XenarchPay`` instance (not
module-level), so tests can rotate keys without reaching into a cache, and
a long-lived agent process can reload by constructing a fresh tool.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


_ALLOWED_SCALARS = (str, int, bool, type(None))


def _assert_canonical_safe(value: Any) -> None:
    """Walk ``value`` and reject anything the canonical form can't represent.

    We deliberately don't accept ``float``. Python's ``json.dumps`` would
    emit ``1.0`` where RFC 8785 wants ``1``, ``NaN``/``Infinity`` instead of
    raising, and would round-trip differently on platforms with different
    libc printf precision. Receipts must either carry integer amounts in
    atomic units or decimal strings — both canonicalise deterministically.
    """
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return
    if isinstance(value, dict):
        for key, inner in value.items():
            if not isinstance(key, str):
                raise TypeError(
                    f"canonical JSON requires str keys, got {type(key).__name__}"
                )
            _assert_canonical_safe(inner)
        return
    if isinstance(value, list):
        for item in value:
            _assert_canonical_safe(item)
        return
    if isinstance(value, float):
        raise TypeError(
            "canonical JSON rejects float values — use int atomic units or "
            "Decimal string to keep signatures deterministic"
        )
    raise TypeError(
        f"canonical JSON rejects {type(value).__name__} — supported types: "
        "dict, list, str, int, bool, None"
    )


def canonical_json(data: dict[str, Any]) -> bytes:
    """Return the bytes the signer hashed over.

    Subset of RFC 8785 used by the Xenarch facilitator — sorted keys,
    compact separators, UTF-8, ``ensure_ascii=False``. Floats, ``NaN``,
    ``Infinity``, and non-str dict keys raise ``TypeError`` rather than
    silently producing output the platform can't verify.

    Scope: signed receipts only. Do not use this as a generic JSON
    canonicaliser — the rules above intentionally differ from RFC 8785
    (no float canonicalisation at all, not just no lossy repr).

    >>> canonical_json({"b": 1, "a": 2})
    b'{"a":2,"b":1}'
    """
    _assert_canonical_safe(data)
    return json.dumps(
        data,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def verify_signature(
    public_key: Ed25519PublicKey,
    receipt: dict[str, Any],
) -> bool:
    """Return True iff the receipt's signature matches its payload.

    Strips the ``signature`` field, canonicalises the remainder, and
    verifies. Any exception in decode/verify returns False — a malformed
    signature is indistinguishable from a forged one for our purposes.
    """
    sig_b64 = receipt.get("signature")
    if not isinstance(sig_b64, str):
        return False
    payload = {k: v for k, v in receipt.items() if k != "signature"}
    try:
        signature = base64.b64decode(sig_b64, validate=True)
        public_key.verify(signature, canonical_json(payload))
    except (InvalidSignature, ValueError):
        return False
    return True


def load_public_key_pem(pem_bytes: bytes) -> Ed25519PublicKey:
    """Load an Ed25519 public key from PKIX/SubjectPublicKeyInfo PEM."""
    key = load_pem_public_key(pem_bytes)
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("facilitator public key is not Ed25519")
    return key


def fetch_public_key(url: str, *, timeout: float = 5.0) -> Ed25519PublicKey:
    """Fetch the facilitator public key PEM and parse it."""
    resp = httpx.get(url, timeout=timeout, follow_redirects=False)
    resp.raise_for_status()
    return load_public_key_pem(resp.content)


async def fetch_public_key_async(
    url: str, *, timeout: float = 5.0
) -> Ed25519PublicKey:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as c:
        resp = await c.get(url)
        resp.raise_for_status()
        return load_public_key_pem(resp.content)


def fetch_receipt(
    facilitator_url: str,
    tx_hash: str,
    *,
    timeout: float = 5.0,
) -> dict[str, Any] | None:
    """GET ``{facilitator_url}/v1/receipts/{tx_hash}``. 404 returns None."""
    resp = httpx.get(
        f"{facilitator_url.rstrip('/')}/v1/receipts/{tx_hash}",
        timeout=timeout,
        follow_redirects=False,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    result: dict[str, Any] = resp.json()
    return result


async def fetch_receipt_async(
    facilitator_url: str,
    tx_hash: str,
    *,
    timeout: float = 5.0,
) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as c:
        resp = await c.get(
            f"{facilitator_url.rstrip('/')}/v1/receipts/{tx_hash}"
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        result: dict[str, Any] = resp.json()
        return result

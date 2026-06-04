"""Signing parity with the platform reference (signed-params-spec.md).

The only thing that can diverge across implementations is the canonical-JSON
serialization of ``params`` — keccak256 and EIP-712 are standard. So the
golden assertion here pins the exact canonical bytes for a known input; if
those match the platform's ``canonical_json`` (same code), the templateHash
and signature recovery match by construction.

Vectors ported from
``xenarch-platform/tests/test_signed_params.py``.
"""
from __future__ import annotations

import pytest
from eth_account import Account

from xenarch.merchant._signing import (
    SigningError,
    build_typed_data,
    canonical_json,
    compute_template_hash,
    sign_params,
)

# Minimal lit-only params (the 5 required fields, nothing else).
VECTOR_A_PARAMS = {
    "to": {"state": "lit", "value": "0x0000000000000000000000000000000000000001"},
    "amount": {"state": "lit", "value": "0.99"},
    "currency": {"state": "lit", "value": "USDC"},
    "network": {"state": "lit", "value": "base"},
    "kind": {"state": "lit", "value": "checkout"},
}


# --- canonical JSON: the byte-parity surface ------------------------------


def test_canonical_json_golden_bytes():
    """Exact canonical bytes for VECTOR_A — keys sorted at every level,
    compact separators, no whitespace. Must equal the platform's output."""
    expected = (
        '{"amount":{"state":"lit","value":"0.99"},'
        '"currency":{"state":"lit","value":"USDC"},'
        '"kind":{"state":"lit","value":"checkout"},'
        '"network":{"state":"lit","value":"base"},'
        '"to":{"state":"lit","value":"0x0000000000000000000000000000000000000001"}}'
    ).encode("utf-8")
    assert canonical_json(VECTOR_A_PARAMS) == expected


def test_canonical_json_nested_keys_sorted():
    expected = b'{"a":{"x":1,"y":2},"b":1}'
    assert canonical_json({"b": 1, "a": {"y": 2, "x": 1}}) == expected


def test_canonical_json_preserves_unicode():
    # ensure_ascii=False — real Unicode chars, not \uXXXX escapes.
    assert canonical_json({"name": "café"}) == '{"name":"café"}'.encode("utf-8")


# --- templateHash ---------------------------------------------------------


def test_template_hash_is_32_bytes():
    h = compute_template_hash(VECTOR_A_PARAMS)
    assert isinstance(h, bytes) and len(h) == 32


def test_canonical_json_is_deterministic():
    a = {"b": 1, "a": {"y": 2, "x": 1}}
    b = {"a": {"x": 1, "y": 2}, "b": 1}
    assert compute_template_hash(a) == compute_template_hash(b)


def test_template_hash_changes_when_value_changes():
    base = compute_template_hash(VECTOR_A_PARAMS)
    tampered = {**VECTOR_A_PARAMS, "amount": {"state": "lit", "value": "1.99"}}
    assert compute_template_hash(tampered) != base


def test_template_hash_changes_when_state_changes():
    base = compute_template_hash(VECTOR_A_PARAMS)
    flipped = {**VECTOR_A_PARAMS, "amount": {"state": "tok", "slot": "qty_amount"}}
    assert compute_template_hash(flipped) != base


# --- sign + recover round-trip --------------------------------------------


def test_sign_and_recover_roundtrip():
    """A signature from sign_params recovers the signing wallet — the same
    check the platform runs on create."""
    from eth_account.messages import encode_typed_data

    account = Account.create()
    params = {**VECTOR_A_PARAMS, "to": {"state": "lit", "value": account.address}}
    nonce = bytes(range(32))
    created_at = 1715187600

    signature = sign_params(
        params, private_key=account.key.hex(), created_at=created_at, nonce=nonce
    )

    typed_data = build_typed_data(
        to=account.address,
        amount="0.99",
        currency="USDC",
        network="base",
        kind="checkout",
        template_hash=compute_template_hash(params),
        created_at=created_at,
        nonce=nonce,
    )
    recovered = Account.recover_message(
        encode_typed_data(full_message=typed_data), signature=signature
    )
    assert recovered == account.address


def test_signature_is_65_byte_hex():
    account = Account.create()
    params = {**VECTOR_A_PARAMS, "to": {"state": "lit", "value": account.address}}
    sig = sign_params(
        params, private_key=account.key.hex(), created_at=1715187600, nonce=bytes(32)
    )
    assert sig.startswith("0x") and len(sig) == 132


def test_unsupported_network_rejected():
    with pytest.raises(SigningError):
        build_typed_data(
            to="0x0000000000000000000000000000000000000001",
            amount="1.00",
            currency="USDC",
            network="ton",
            kind="checkout",
            template_hash=bytes(32),
            created_at=1715187600,
            nonce=bytes(32),
        )


def test_missing_lit_field_rejected():
    incomplete = {k: v for k, v in VECTOR_A_PARAMS.items() if k != "amount"}
    with pytest.raises(SigningError):
        sign_params(
            incomplete, private_key=Account.create().key.hex(),
            created_at=1715187600, nonce=bytes(32),
        )

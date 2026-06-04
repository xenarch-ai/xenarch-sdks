"""Pay-link signing — EIP-712 typed-data signed by the merchant's wallet.

Byte-for-byte port of the platform reference implementation
(``xenarch-platform/app/services/signed_params.py`` +
``app/services/canonical_json.py``). The canonical recipe lives in
``Information/design/signed-params-spec.md``; this module must match it
exactly or the platform will reject the signature on create.

Because the platform reference is itself Python, parity here is a direct
copy — no cross-language canonical-JSON gymnastics. The merchant's wallet
signs a deterministic encoding of the link template; the platform recovers
the signer on every render and refuses to serve a tampered link.
"""
from __future__ import annotations

import json
import secrets
from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address

# --- domain ----------------------------------------------------------------

# chainId per network. Base mainnet only at MVP.
_CHAIN_ID_BY_NETWORK: dict[str, int] = {
    "base": 8453,
}

_DOMAIN_NAME = "Xenarch Pay Links"
_DOMAIN_VERSION = "1"
# Sentinel zero address — the signature is verified off-chain, there is no
# verifying contract. EIP-712 requires the field to be present.
_DOMAIN_ZERO_CONTRACT = "0x0000000000000000000000000000000000000000"

# The five fields that must be present as {"state": "lit", "value": ...} in
# the params tree and are surfaced into the EIP-712 message so the wallet's
# signing UI can render readable rows ("Pay 0.99 USDC on base to 0x...").
REQUIRED_LIT_FIELDS = ("to", "amount", "currency", "network", "kind")


# --- types -----------------------------------------------------------------

_PAY_LINK_TYPES: dict[str, list[dict[str, str]]] = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "PayLink": [
        {"name": "to", "type": "address"},
        {"name": "amount", "type": "string"},
        {"name": "currency", "type": "string"},
        {"name": "network", "type": "string"},
        {"name": "kind", "type": "string"},
        {"name": "templateHash", "type": "bytes32"},
        {"name": "createdAt", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}


class SigningError(Exception):
    """Pay-link signing failure (bad params, unsupported network, bad key)."""


# --- canonical JSON (RFC 8785 / JCS subset — matches the platform) ---------


def canonical_json(data: dict[str, Any]) -> bytes:
    """Deterministic bytes for the params tree.

    Keys sorted at every level, compact separators, UTF-8, Unicode preserved.
    Identical to the platform's ``canonical_json`` so the recomputed
    templateHash matches.
    """
    return json.dumps(
        data,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def compute_template_hash(params: dict[str, Any]) -> bytes:
    """JCS-canonicalize ``params`` and keccak256 to 32 bytes."""
    return keccak(canonical_json(params))


# --- public API ------------------------------------------------------------


def generate_nonce() -> bytes:
    """32 random bytes; embedded in the EIP-712 payload for replay protection."""
    return secrets.token_bytes(32)


def extract_lit_value(params: dict[str, Any], key: str) -> Any:
    """Pull a required ``{"state": "lit", "value": ...}`` field from params."""
    entry = params.get(key)
    if not isinstance(entry, dict):
        raise SigningError(f"params.{key} missing or malformed")
    if entry.get("state") != "lit":
        raise SigningError(
            f"params.{key} must be in 'lit' state at creation "
            f"(got {entry.get('state')!r})"
        )
    if "value" not in entry:
        raise SigningError(f"params.{key} lit value missing")
    return entry["value"]


def build_typed_data(
    *,
    to: str,
    amount: str,
    currency: str,
    network: str,
    kind: str,
    template_hash: bytes,
    created_at: int,
    nonce: bytes,
) -> dict[str, Any]:
    """Construct the EIP-712 typed-data payload (spec §5)."""
    chain_id = _CHAIN_ID_BY_NETWORK.get(network)
    if chain_id is None:
        raise SigningError(f"unsupported network: {network!r}")
    if len(template_hash) != 32:
        raise SigningError("template_hash must be 32 bytes")
    if len(nonce) != 32:
        raise SigningError("nonce must be 32 bytes")

    return {
        "types": _PAY_LINK_TYPES,
        "primaryType": "PayLink",
        "domain": {
            "name": _DOMAIN_NAME,
            "version": _DOMAIN_VERSION,
            "chainId": chain_id,
            "verifyingContract": _DOMAIN_ZERO_CONTRACT,
        },
        "message": {
            "to": to_checksum_address(to),
            "amount": amount,
            "currency": currency,
            "network": network,
            "kind": kind,
            "templateHash": template_hash,
            "createdAt": int(created_at),
            "nonce": nonce,
        },
    }


def sign_params(
    params: dict[str, Any],
    *,
    private_key: str,
    created_at: int,
    nonce: bytes,
) -> str:
    """Sign the link template with ``private_key``.

    Extracts the five lit fields, computes the templateHash, builds the
    EIP-712 payload, and returns the 65-byte signature hex (``0x``-prefixed,
    132 chars) ready for the ``signed_params`` field of the create body.
    """
    lit = {key: extract_lit_value(params, key) for key in REQUIRED_LIT_FIELDS}
    typed_data = build_typed_data(
        to=lit["to"],
        amount=lit["amount"],
        currency=lit["currency"],
        network=lit["network"],
        kind=lit["kind"],
        template_hash=compute_template_hash(params),
        created_at=created_at,
        nonce=nonce,
    )
    encoded = encode_typed_data(full_message=typed_data)
    signed = Account.sign_message(encoded, private_key=private_key)
    sig_hex = signed.signature.hex()
    # eth_account >=0.10 dropped the ``0x`` prefix from HexBytes.hex().
    return sig_hex if sig_hex.startswith("0x") else "0x" + sig_hex


def signer_address(private_key: str) -> str:
    """EIP-55 address for ``private_key`` (to confirm it matches the session wallet)."""
    return to_checksum_address(Account.from_key(private_key).address)

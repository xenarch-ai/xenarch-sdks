"""Unit tests for the signed-receipt helpers (XEN-148 PR 5d).

Canonical JSON output is asserted byte-exact against the fixtures in
``tests/tools/fixtures/canonical_json/``. If the encoder's behaviour ever
drifts (key sort order, whitespace, Unicode escaping), these tests fail
before prod does — which matters because the facilitator signs those exact
bytes and a mismatch silently turns verification into a False for every
agent in the world.

The ``receipts/xenarch_signed.*`` fixtures ship a real Ed25519 keypair so
the round-trip verifies against real cryptography rather than a mocked
``verify`` stub. Tampered-byte and wrong-key tests catch the two failure
modes a malicious facilitator could try to sneak past.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import pytest

from xenarch._receipts import (
    canonical_json,
    fetch_public_key,
    fetch_public_key_async,
    fetch_receipt,
    fetch_receipt_async,
    load_public_key_pem,
    verify_signature,
)


FIXTURES = Path(__file__).parent / "fixtures"


def _load_keypair() -> tuple[bytes, bytes]:
    pub_pem = (FIXTURES / "receipts/xenarch_signed.pubkey.pem").read_bytes()
    priv_pem = (FIXTURES / "receipts/xenarch_signed.privkey.pem").read_bytes()
    return pub_pem, priv_pem


def _load_signed_receipt() -> dict[str, str]:
    data: dict[str, str] = json.loads(
        (FIXTURES / "receipts/xenarch_signed.json").read_text()
    )
    return data


class TestCanonicalJsonGoldens:
    # Byte-exact fixtures: the signer and verifier both produce these bytes.
    # Any drift — even a whitespace change — breaks every deployed agent.

    def test_basic(self) -> None:
        expected = (FIXTURES / "canonical_json/basic.json").read_bytes()
        assert canonical_json({"b": 1, "a": "two", "c": None}) == expected

    def test_unicode_preserved_not_escaped(self) -> None:
        # ensure_ascii=False must hold: Unicode chars appear raw in bytes,
        # not as \uXXXX escapes. If the encoder changes default, this fails.
        expected = (FIXTURES / "canonical_json/unicode.json").read_bytes()
        got = canonical_json(
            {"greeting": "héllo — wörld", "emoji": "✅💰"}
        )
        assert got == expected
        assert "\\u" not in got.decode("utf-8")

    def test_nested_keys_sorted_deep(self) -> None:
        expected = (FIXTURES / "canonical_json/nested.json").read_bytes()
        got = canonical_json(
            {
                "outer": {"z": [1, 2, {"inner": "v"}], "a": True},
                "list": [{"b": 2, "a": 1}],
            }
        )
        assert got == expected

    def test_determinism_input_order_irrelevant(self) -> None:
        a = canonical_json({"a": 1, "b": 2, "c": 3})
        b = canonical_json({"c": 3, "b": 2, "a": 1})
        assert a == b


class TestCanonicalJsonRejectsNonSpec:
    """Non-spec inputs must raise, not silently produce bytes the
    facilitator can't verify. Floats are the landmine: json.dumps happily
    encodes NaN as ``NaN`` (not valid JSON) and rounds floats differently
    than a Decimal-string round-trip."""

    def test_float_rejected(self) -> None:
        with pytest.raises(TypeError, match="float"):
            canonical_json({"amount": 1.23})

    def test_float_in_nested_list_rejected(self) -> None:
        with pytest.raises(TypeError, match="float"):
            canonical_json({"amounts": [1, 2.0, 3]})

    def test_nan_rejected(self) -> None:
        with pytest.raises(TypeError, match="float"):
            canonical_json({"x": float("nan")})

    def test_non_str_key_rejected(self) -> None:
        with pytest.raises(TypeError, match="str keys"):
            canonical_json({1: "bad"})  # type: ignore[dict-item]

    def test_bytes_value_rejected(self) -> None:
        with pytest.raises(TypeError, match="bytes"):
            canonical_json({"sig": b"raw"})

    def test_bool_and_none_allowed(self) -> None:
        # Sanity: bool is a subclass of int but gets handled explicitly.
        got = canonical_json({"ok": True, "none": None, "count": 0})
        assert got == b'{"count":0,"none":null,"ok":true}'


class TestVerifySignature:
    def test_fixture_receipt_verifies(self) -> None:
        pub_pem, _ = _load_keypair()
        public_key = load_public_key_pem(pub_pem)
        assert verify_signature(public_key, _load_signed_receipt()) is True

    def test_tampered_field_fails(self) -> None:
        pub_pem, _ = _load_keypair()
        public_key = load_public_key_pem(pub_pem)
        receipt = _load_signed_receipt()
        receipt["amount_usd"] = "999.99"  # ← attacker tweaks a cent
        assert verify_signature(public_key, receipt) is False

    def test_tampered_signature_byte_fails(self) -> None:
        pub_pem, _ = _load_keypair()
        public_key = load_public_key_pem(pub_pem)
        receipt = _load_signed_receipt()
        sig_bytes = bytearray(base64.b64decode(receipt["signature"]))
        sig_bytes[0] ^= 0x01  # flip one bit
        receipt["signature"] = base64.b64encode(bytes(sig_bytes)).decode()
        assert verify_signature(public_key, receipt) is False

    def test_missing_signature_fails(self) -> None:
        pub_pem, _ = _load_keypair()
        public_key = load_public_key_pem(pub_pem)
        receipt = _load_signed_receipt()
        del receipt["signature"]
        assert verify_signature(public_key, receipt) is False

    def test_non_base64_signature_fails(self) -> None:
        pub_pem, _ = _load_keypair()
        public_key = load_public_key_pem(pub_pem)
        receipt = _load_signed_receipt()
        receipt["signature"] = "not-base64!!!"
        assert verify_signature(public_key, receipt) is False

    def test_wrong_key_fails(self) -> None:
        # Second keypair, unrelated to the one that signed the receipt.
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )

        stranger = Ed25519PrivateKey.generate().public_key()
        assert verify_signature(stranger, _load_signed_receipt()) is False


class TestFetchPublicKey:
    def test_sync_happy_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pub_pem, _ = _load_keypair()

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=pub_pem)

        transport = httpx.MockTransport(handler)
        monkeypatch.setattr(
            "xenarch._receipts.httpx.get",
            lambda *a, **kw: httpx.Client(transport=transport).get(*a, **kw),
        )
        key = fetch_public_key(
            "https://xenarch.dev/.well-known/xenarch-facilitator-key.pem"
        )
        # If the PEM parsed, verifying the fixture works.
        assert verify_signature(key, _load_signed_receipt()) is True

    async def test_async_happy_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pub_pem, _ = _load_keypair()

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=pub_pem)

        transport = httpx.MockTransport(handler)

        class _MockAsyncClient(httpx.AsyncClient):
            def __init__(self, **kwargs: object) -> None:
                kwargs.pop("transport", None)
                super().__init__(transport=transport, **kwargs)

        monkeypatch.setattr(
            "xenarch._receipts.httpx.AsyncClient", _MockAsyncClient
        )
        key = await fetch_public_key_async(
            "https://xenarch.dev/.well-known/xenarch-facilitator-key.pem"
        )
        assert verify_signature(key, _load_signed_receipt()) is True


class TestFetchReceipt:
    def test_404_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        transport = httpx.MockTransport(
            lambda req: httpx.Response(404, json={"detail": "not found"})
        )
        monkeypatch.setattr(
            "xenarch._receipts.httpx.get",
            lambda *a, **kw: httpx.Client(transport=transport).get(*a, **kw),
        )
        assert fetch_receipt("https://xenarch.dev", "0xabc") is None

    def test_sync_happy_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        receipt = _load_signed_receipt()
        transport = httpx.MockTransport(
            lambda req: httpx.Response(200, json=receipt)
        )
        monkeypatch.setattr(
            "xenarch._receipts.httpx.get",
            lambda *a, **kw: httpx.Client(transport=transport).get(*a, **kw),
        )
        got = fetch_receipt("https://xenarch.dev/", "0xabc")
        assert got == receipt

    async def test_async_happy_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        receipt = _load_signed_receipt()
        transport = httpx.MockTransport(
            lambda req: httpx.Response(200, json=receipt)
        )

        class _MockAsyncClient(httpx.AsyncClient):
            def __init__(self, **kwargs: object) -> None:
                kwargs.pop("transport", None)
                super().__init__(transport=transport, **kwargs)

        monkeypatch.setattr(
            "xenarch._receipts.httpx.AsyncClient", _MockAsyncClient
        )
        got = await fetch_receipt_async("https://xenarch.dev", "0xabc")
        assert got == receipt

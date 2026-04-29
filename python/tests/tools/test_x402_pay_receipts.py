"""Integration-of-helpers tests: XenarchPay + receipts + reputation (PR 5d).

These cover the wiring the unit tests don't:
  * receipts get auto-fetched for xenarch.dev facilitators, skipped for
    other hosts,
  * a bad ``X-PAYMENT-RESPONSE`` header surfaces as ``receipt_error`` but
    the paid GET's body still comes back (commit-before-post-work),
  * reputation threshold refusals happen BEFORE the budget lock, so a
    failed lookup can't leak session spend,
  * async twins exist for all the above.
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from eth_account import Account

from xenarch.tools import XenarchBudgetPolicy, XenarchPay


FIXTURES = Path(__file__).parent / "fixtures"
USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# Capture the real httpx.Client/AsyncClient BEFORE tests run any monkeypatching
# that replaces them on the httpx module. The receipt/reputation helpers need to
# bypass the resource-transport hijack so they hit the facilitator handler, not
# the 402 resource. Subclass patterns elsewhere in the file rely on this.
_REAL_HTTPX_CLIENT = httpx.Client
_REAL_HTTPX_ASYNC_CLIENT = httpx.AsyncClient


def _load_signed_receipt() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (FIXTURES / "receipts/xenarch_signed.json").read_text()
    )
    return data


def _load_pubkey_pem() -> bytes:
    return (FIXTURES / "receipts/xenarch_signed.pubkey.pem").read_bytes()


def _make_402_body(
    *, amount: str = "10000", pay_to: str = "0x0000000000000000000000000000000000000001"
) -> dict[str, Any]:
    return {
        "x402Version": 1,
        "error": "payment_required",
        "accepts": [
            {
                "scheme": "exact",
                "network": "base",
                "asset": USDC_BASE_ASSET,
                "maxAmountRequired": amount,
                "resource": "https://example.com/gated",
                "payTo": pay_to,
                "maxTimeoutSeconds": 60,
                "extra": {"name": "USD Coin", "version": "2"},
            }
        ],
    }


def _settle_response_header(tx_hash: str = "0xabc123def456") -> str:
    """Encode a SettleResponse body as the x402 server would."""
    payload = {
        "success": True,
        "transaction": tx_hash,
        "network": "eip155:8453",
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


def _fresh_tool(
    *,
    facilitator_url: str = "https://xenarch.dev",
    fetch_receipts: bool | None = None,
    verify_receipts: bool = True,
    require_reputation_score: Decimal | None = None,
    budget: XenarchBudgetPolicy | None = None,
) -> XenarchPay:
    return XenarchPay(
        private_key=Account.create().key.hex(),
        budget_policy=budget or XenarchBudgetPolicy(),
        discover_via_pay_json=False,
        facilitator_url=facilitator_url,
        fetch_receipts=fetch_receipts,
        verify_receipts=verify_receipts,
        require_reputation_score=require_reputation_score,
    )


class _MockClient(_REAL_HTTPX_CLIENT):  # type: ignore[misc,valid-type]
    def __init__(self, transport: httpx.MockTransport, **kw: Any) -> None:
        super().__init__(transport=transport, **kw)


class _MockAsyncClient(_REAL_HTTPX_ASYNC_CLIENT):  # type: ignore[misc,valid-type]
    def __init__(self, transport: httpx.MockTransport, **kw: Any) -> None:
        super().__init__(transport=transport, **kw)


def _patch_sync_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    transport = httpx.MockTransport(handler)

    def _factory(*a: Any, **kw: Any) -> httpx.Client:
        kw.pop("transport", None)
        return _MockClient(transport=transport, **kw)

    monkeypatch.setattr("x402_agent._payer.httpx.Client", _factory)


def _patch_async_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    transport = httpx.MockTransport(handler)

    def _factory(*a: Any, **kw: Any) -> httpx.AsyncClient:
        kw.pop("transport", None)
        return _MockAsyncClient(transport=transport, **kw)

    monkeypatch.setattr(
        "x402_agent._payer.httpx.AsyncClient", _factory
    )


def _patch_receipts_httpx(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    """Patch the receipts module's httpx.get (sync path)."""
    transport = httpx.MockTransport(handler)

    def _get(*a: Any, **kw: Any) -> httpx.Response:
        # Use the real Client (captured at module import) so we're not routed
        # through the resource-transport hijack that x402_pay's httpx.Client
        # gets replaced with.
        with _REAL_HTTPX_CLIENT(transport=transport) as c:
            return c.get(*a, **kw)

    monkeypatch.setattr("xenarch._receipts.httpx.get", _get)


def _patch_receipts_httpx_async(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    transport = httpx.MockTransport(handler)

    class _RC(_REAL_HTTPX_ASYNC_CLIENT):  # type: ignore[misc,valid-type]
        def __init__(self, **kw: Any) -> None:
            kw.pop("transport", None)
            super().__init__(transport=transport, **kw)

    monkeypatch.setattr("xenarch._receipts.httpx.AsyncClient", _RC)


def _patch_reputation_httpx(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    transport = httpx.MockTransport(handler)

    def _get(*a: Any, **kw: Any) -> httpx.Response:
        with _REAL_HTTPX_CLIENT(transport=transport) as c:
            return c.get(*a, **kw)

    monkeypatch.setattr("xenarch._reputation.httpx.get", _get)


def _patch_reputation_httpx_async(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    transport = httpx.MockTransport(handler)

    class _RC(_REAL_HTTPX_ASYNC_CLIENT):  # type: ignore[misc,valid-type]
        def __init__(self, **kw: Any) -> None:
            kw.pop("transport", None)
            super().__init__(transport=transport, **kw)

    monkeypatch.setattr("xenarch._reputation.httpx.AsyncClient", _RC)


class TestReceiptAutoFetchSync:
    def test_xenarch_facilitator_auto_fetches_and_verifies(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        receipt = _load_signed_receipt()

        def resource_handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(
                200,
                text="paid content",
                headers={"X-PAYMENT-RESPONSE": _settle_response_header()},
            )

        def facilitator_handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith(".pem"):
                return httpx.Response(200, content=_load_pubkey_pem())
            if "/v1/receipts/" in str(request.url):
                return httpx.Response(200, json=receipt)
            return httpx.Response(404)

        _patch_sync_transport(monkeypatch, resource_handler)
        _patch_receipts_httpx(monkeypatch, facilitator_handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["success"] is True
        assert result["receipt"] == receipt
        assert result["signature_verified"] is True

    def test_non_xenarch_facilitator_skips_receipts(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Vendor-neutrality proof: pointing at some other facilitator skips
        # receipt machinery entirely. No extra network calls, no receipt
        # field in output.
        calls: list[httpx.Request] = []

        def resource_handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(
                200,
                text="paid",
                headers={"X-PAYMENT-RESPONSE": _settle_response_header()},
            )

        def facilitator_handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(500)  # should never be hit

        _patch_sync_transport(monkeypatch, resource_handler)
        _patch_receipts_httpx(monkeypatch, facilitator_handler)

        tool = _fresh_tool(facilitator_url="https://other-facilitator.example")
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["success"] is True
        assert "receipt" not in result
        assert "signature_verified" not in result
        assert calls == []

    def test_missing_payment_response_header_surfaces_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Paid GET returns 200 but no X-PAYMENT-RESPONSE (non-conforming
        # server). Body still returns; commit already happened. Only the
        # receipt slot gets an error marker.
        def handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(200, text="paid, no header")

        _patch_sync_transport(monkeypatch, handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["success"] is True
        assert result["receipt_error"] == "no_tx_hash_in_payment_response"
        assert tool.budget_policy.session_spent == Decimal("0.01")


class TestReceiptAutoFetchAsync:
    async def test_xenarch_facilitator_verifies_async(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Async httpx.AsyncClient is shared across the resource path and
        # _receipts/_reputation helpers, so last-wins monkeypatching can't
        # route them independently. Instead, dispatch by hostname in one
        # transport that serves the resource on example.com and facilitator
        # bits on xenarch.dev.
        receipt = _load_signed_receipt()

        def router(request: httpx.Request) -> httpx.Response:
            host = request.url.host
            if host == "xenarch.dev":
                if request.url.path.endswith(".pem"):
                    return httpx.Response(
                        200, content=_load_pubkey_pem()
                    )
                if "/v1/receipts/" in str(request.url):
                    return httpx.Response(200, json=receipt)
                return httpx.Response(404)
            # resource host
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(
                200,
                text="paid",
                headers={"X-PAYMENT-RESPONSE": _settle_response_header()},
            )

        _patch_async_transport(monkeypatch, router)
        # Receipts + pubkey go through _receipts helpers which use
        # httpx.AsyncClient — same attribute the resource path patches — so
        # both funnel into the same mock transport; the router picks by host.
        _patch_receipts_httpx_async(monkeypatch, router)

        tool = _fresh_tool()
        result = json.loads(await tool._arun("https://example.com/gated"))
        assert result["success"] is True
        assert result["receipt"] == receipt
        assert result["signature_verified"] is True


class TestReputationGateSync:
    def test_score_above_threshold_passes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def rep_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"score": 0.9})

        def resource_handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(200, text="paid")

        _patch_sync_transport(monkeypatch, resource_handler)
        _patch_reputation_httpx(monkeypatch, rep_handler)

        tool = _fresh_tool(
            require_reputation_score=Decimal("0.5"),
            fetch_receipts=False,
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["success"] is True

    def test_score_below_threshold_refuses(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def rep_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"score": 0.1})

        calls: list[httpx.Request] = []

        def resource_handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(402, json=_make_402_body())

        _patch_sync_transport(monkeypatch, resource_handler)
        _patch_reputation_httpx(monkeypatch, rep_handler)

        tool = _fresh_tool(
            require_reputation_score=Decimal("0.5"),
            fetch_receipts=False,
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "reputation_below_threshold"
        assert result["score"] == "0.1"
        assert result["required"] == "0.5"
        # Budget untouched — reputation gate refused before the lock.
        assert tool.budget_policy.session_spent == Decimal("0")
        # Initial unpaid GET happened; no retry.
        assert len(calls) == 1

    def test_unknown_address_scores_zero_and_refuses(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Fail-closed: new/unknown receivers refuse when a threshold is set.
        def rep_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404)

        def resource_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=_make_402_body())

        _patch_sync_transport(monkeypatch, resource_handler)
        _patch_reputation_httpx(monkeypatch, rep_handler)

        tool = _fresh_tool(
            require_reputation_score=Decimal("0.1"),
            fetch_receipts=False,
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "reputation_below_threshold"
        assert result["score"] == "0"

    def test_reputation_lookup_error_fails_closed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def rep_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="internal error")

        def resource_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=_make_402_body())

        _patch_sync_transport(monkeypatch, resource_handler)
        _patch_reputation_httpx(monkeypatch, rep_handler)

        tool = _fresh_tool(
            require_reputation_score=Decimal("0.5"),
            fetch_receipts=False,
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "reputation_lookup_failed"


class TestReputationGateAsync:
    async def test_below_threshold_refuses(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Single router for the same reason as the receipt async test:
        # httpx.AsyncClient is shared between the resource path and the
        # reputation helper, so we route by hostname instead of clobbering.
        def router(request: httpx.Request) -> httpx.Response:
            if request.url.host == "xenarch.dev":
                return httpx.Response(200, json={"score": 0.2})
            return httpx.Response(402, json=_make_402_body())

        _patch_async_transport(monkeypatch, router)
        _patch_reputation_httpx_async(monkeypatch, router)

        tool = _fresh_tool(
            require_reputation_score=Decimal("0.5"),
            fetch_receipts=False,
        )
        result = json.loads(await tool._arun("https://example.com/gated"))
        assert result["error"] == "reputation_below_threshold"
        assert tool.budget_policy.session_spent == Decimal("0")

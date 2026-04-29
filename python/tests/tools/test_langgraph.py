"""LangGraph node adapter tests for ``XenarchLangGraphPay`` (XEN-174).

Mirrors ``test_autogen.py`` happy/sad paths so the LangGraph wrapper
stays in lockstep with the LangChain and AutoGen wrappers. All three
are thin shells over ``XenarchPayer.pay_async``; if a framework adapter
ever diverges from the underlying payer behavior, these tests catch it.
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

import httpx
import pytest
from eth_account import Account

from xenarch.tools import XenarchBudgetPolicy, XenarchLangGraphPay


USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def _make_402_body(
    *,
    amount: str = "10000",
    scheme: str = "exact",
    network: str = "base",
    pay_to: str = "0x0000000000000000000000000000000000000001",
    asset: str = USDC_BASE_ASSET,
    resource: str = "https://example.com/gated",
) -> dict[str, Any]:
    return {
        "x402Version": 1,
        "error": "payment_required",
        "accepts": [
            {
                "scheme": scheme,
                "network": network,
                "asset": asset,
                "maxAmountRequired": amount,
                "resource": resource,
                "payTo": pay_to,
                "maxTimeoutSeconds": 60,
                "extra": {"name": "USD Coin", "version": "2"},
            }
        ],
    }


def _fresh_adapter(
    budget: XenarchBudgetPolicy | None = None,
    **kwargs: Any,
) -> XenarchLangGraphPay:
    account = Account.create()
    return XenarchLangGraphPay(
        private_key=account.key.hex(),
        budget_policy=budget or XenarchBudgetPolicy(),
        discover_via_pay_json=False,
        **kwargs,
    )


class _MockAsyncClient(httpx.AsyncClient):
    def __init__(self, transport: httpx.MockTransport, **kwargs: Any) -> None:
        super().__init__(transport=transport, **kwargs)


def _with_mock_async_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Any,
) -> None:
    transport = httpx.MockTransport(handler)

    def _client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("transport", None)
        return _MockAsyncClient(transport=transport, **kwargs)

    monkeypatch.setattr("x402_agent._payer.httpx.AsyncClient", _client_factory)


async def _run_node(
    adapter: XenarchLangGraphPay,
    url: str,
    *,
    url_key: str = "url",
    result_key: str = "payment_result",
) -> dict[str, Any]:
    """Invoke through the actual LangGraph node callable.

    ``as_node()`` returns an async callable that LangGraph would call
    with the graph state. We exercise that exact contract here so the
    test catches any drift between graph integration and the bypass
    helper.
    """
    node = adapter.as_node()
    state: dict[str, Any] = {url_key: url}
    update = await node(state)
    payload: dict[str, Any] = update[result_key]
    return payload


class TestNodeShape:
    def test_default_keys(self):
        adapter = _fresh_adapter()
        node = adapter.as_node()
        # Async callable — actual signature compatibility checked in run tests.
        assert callable(node)

    def test_custom_state_keys(self):
        adapter = _fresh_adapter(
            url_key="article_url",
            result_key="article_payment",
        )
        node = adapter.as_node()
        assert callable(node)


class TestNoPayment:
    async def test_200_passthrough(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free")

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter()
        result = await _run_node(adapter, "https://example.com/free")
        assert result["status"] == "no_payment_required"
        assert result["body"] == "free"


class TestHappyPath:
    async def test_signs_and_retries(self, monkeypatch: pytest.MonkeyPatch):
        seen: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.headers))
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(
                200, text="paid article", headers={"X-PAYMENT-RESPONSE": "0xdef"}
            )

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter()
        result = await _run_node(adapter, "https://example.com/gated")
        assert result["success"] is True
        assert result["body"] == "paid article"
        assert result["payment_response"] == "0xdef"
        assert result["session_spent_usd"] == "0.01"
        assert adapter.budget_policy.session_spent == Decimal("0.01")

        # Second request carried the X-PAYMENT header.
        assert len(seen) == 2
        retry = {k.lower(): v for k, v in seen[1].items()}
        assert "x-payment" in retry
        decoded = json.loads(base64.b64decode(retry["x-payment"]).decode())
        assert decoded["x402Version"] == 1
        assert decoded["scheme"] == "exact"

    async def test_custom_state_keys(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free")

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter(
            url_key="article_url",
            result_key="article_payment",
        )
        result = await _run_node(
            adapter,
            "https://example.com/free",
            url_key="article_url",
            result_key="article_payment",
        )
        assert result["status"] == "no_payment_required"


class TestBudgetGate:
    async def test_over_cap_refuses(self, monkeypatch: pytest.MonkeyPatch):
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(402, json=_make_402_body(amount="500000"))

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter(
            budget=XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        )
        result = await _run_node(adapter, "https://example.com/gated")
        assert result["error"] == "budget_exceeded"
        assert result["reason"] == "max_per_call"
        # Single unpaid GET — no payment attempted.
        assert len(calls) == 1

    async def test_approval_declined(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=_make_402_body())

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter(
            budget=XenarchBudgetPolicy(
                human_approval_above=Decimal("0.001"),
                approval_callback=lambda plan: False,
            )
        )
        result = await _run_node(adapter, "https://example.com/gated")
        assert result["status"] == "declined"
        assert adapter.budget_policy.session_spent == Decimal("0")


class TestRetryFailure:
    async def test_retry_non_200(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(402, text="bad sig")

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter()
        result = await _run_node(adapter, "https://example.com/gated")
        assert result["error"] == "x402_retry_failed"
        assert adapter.budget_policy.session_spent == Decimal("0")


class TestMissingStateKey:
    async def test_keyerror_on_missing_url(self, monkeypatch: pytest.MonkeyPatch):
        """Graph-state typos should be loud — we deliberately don't ``.get()``."""
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free")

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter(url_key="article_url")
        node = adapter.as_node()
        with pytest.raises(KeyError):
            await node({"wrong_key": "https://example.com/free"})


class TestBypassHelper:
    async def test_pay_async_helper(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free")

        _with_mock_async_transport(monkeypatch, handler)
        adapter = _fresh_adapter()
        # Direct payer access for callers sharing one config across adapters.
        result = await adapter.pay_async("https://example.com/free")
        assert result["status"] == "no_payment_required"

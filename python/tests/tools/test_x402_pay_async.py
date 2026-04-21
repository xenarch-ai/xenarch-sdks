"""Async-path parity tests for XenarchPay (XEN-148 PR 5b).

Every happy-path unit test in ``test_x402_pay.py`` has an async twin here.
The async path uses ``httpx.AsyncClient`` plus the async ``x402Client``, so
the SDK exercises a completely different code path internally — parity
tests guard against drift between `_run` and `_arun`.
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

import httpx
import pytest
from eth_account import Account

from xenarch.tools import XenarchBudgetPolicy, XenarchPay


USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def _make_402_body(
    *,
    amount: str = "10000",
    scheme: str = "exact",
    network: str = "eip155:8453",
    pay_to: str = "0x0000000000000000000000000000000000000001",
    asset: str = USDC_BASE_ASSET,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    default_extra = {"name": "USD Coin", "version": "2"}
    resolved_extra = default_extra if extra is None else extra
    return {
        "x402Version": 2,
        "error": "payment_required",
        "accepts": [
            {
                "scheme": scheme,
                "network": network,
                "asset": asset,
                "amount": amount,
                "payTo": pay_to,
                "maxTimeoutSeconds": 60,
                "extra": resolved_extra,
            }
        ],
    }


def _fresh_tool(
    budget: XenarchBudgetPolicy | None = None,
) -> XenarchPay:
    account = Account.create()
    return XenarchPay(
        private_key=account.key.hex(),
        budget_policy=budget or XenarchBudgetPolicy(),
        discover_via_pay_json=False,
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


class TestAsyncNoPayment:
    async def test_200_passthrough(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free")

        _with_mock_async_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(await tool._arun("https://example.com/free"))
        assert result["status"] == "no_payment_required"
        assert result["body"] == "free"


class TestAsyncHappyPath:
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
        tool = _fresh_tool()
        result = json.loads(await tool._arun("https://example.com/gated"))
        assert result["success"] is True
        assert result["body"] == "paid article"
        assert result["payment_response"] == "0xdef"
        assert result["session_spent_usd"] == "0.01"
        assert tool.budget_policy.session_spent == Decimal("0.01")

        # Second request carried the X-PAYMENT header.
        assert len(seen) == 2
        retry = {k.lower(): v for k, v in seen[1].items()}
        assert "x-payment" in retry
        decoded = json.loads(base64.b64decode(retry["x-payment"]).decode())
        assert decoded["x402Version"] == 2
        assert decoded["accepted"]["scheme"] == "exact"


class TestAsyncBudgetGate:
    async def test_over_cap_refuses(self, monkeypatch: pytest.MonkeyPatch):
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(402, json=_make_402_body(amount="500000"))

        _with_mock_async_transport(monkeypatch, handler)
        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        )
        result = json.loads(await tool._arun("https://example.com/gated"))
        assert result["error"] == "budget_exceeded"
        assert result["reason"] == "max_per_call"
        # Single unpaid GET — no payment attempted.
        assert len(calls) == 1

    async def test_approval_declined(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=_make_402_body())

        _with_mock_async_transport(monkeypatch, handler)
        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(
                human_approval_above=Decimal("0.001"),
                approval_callback=lambda plan: False,
            )
        )
        result = json.loads(await tool._arun("https://example.com/gated"))
        assert result["status"] == "declined"
        assert tool.budget_policy.session_spent == Decimal("0")


class TestAsyncRetryFailure:
    async def test_retry_non_200(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(402, text="bad sig")

        _with_mock_async_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(await tool._arun("https://example.com/gated"))
        assert result["error"] == "x402_retry_failed"
        assert tool.budget_policy.session_spent == Decimal("0")

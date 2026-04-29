"""CrewAI BaseTool adapter tests for ``XenarchCrewaiPay`` (XEN-175).

Mirrors ``test_x402_pay.py`` (sync) + ``test_x402_pay_async.py`` (async)
happy/sad paths so the CrewAI wrapper stays in lockstep with the
LangChain, AutoGen, and LangGraph wrappers. All four are thin shells
over ``XenarchPayer.pay`` / ``pay_async``; if a framework adapter ever
diverges from the underlying payer behavior, these tests catch it.
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

import httpx
import pytest
from crewai.tools import BaseTool
from eth_account import Account

from xenarch.tools import XenarchBudgetPolicy, XenarchCrewaiPay


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


def _fresh_tool(
    budget: XenarchBudgetPolicy | None = None,
) -> XenarchCrewaiPay:
    account = Account.create()
    return XenarchCrewaiPay(
        private_key=account.key.hex(),
        budget_policy=budget or XenarchBudgetPolicy(),
        discover_via_pay_json=False,
    )


# --- sync transport mocking ------------------------------------------------


class _MockClient(httpx.Client):
    def __init__(self, transport: httpx.MockTransport, **kwargs: Any) -> None:
        super().__init__(transport=transport, **kwargs)


def _with_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Any,
) -> None:
    transport = httpx.MockTransport(handler)

    def _client_factory(*args: Any, **kwargs: Any) -> httpx.Client:
        kwargs.pop("transport", None)
        return _MockClient(transport=transport, **kwargs)

    monkeypatch.setattr("x402_agent._payer.httpx.Client", _client_factory)


# --- async transport mocking -----------------------------------------------


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


class TestToolShape:
    def test_subclasses_basetool(self):
        tool = _fresh_tool()
        assert isinstance(tool, BaseTool)
        assert tool.name == "xenarch_pay"
        assert "x402" in tool.description.lower()

    def test_args_schema_derived_from_run(self):
        """CrewAI auto-generates args_schema from _run signature."""
        tool = _fresh_tool()
        assert "url" in tool.args_schema.model_fields

    def test_custom_name_and_description(self):
        tool = XenarchCrewaiPay(
            private_key=Account.create().key.hex(),
            discover_via_pay_json=False,
            name="pay_for_data",
            description="custom description",
        )
        assert tool.name == "pay_for_data"
        assert tool.description == "custom description"


class TestSyncNoPayment:
    def test_200_passthrough(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free")

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/free"))
        assert result["status"] == "no_payment_required"
        assert result["body"] == "free"


class TestSyncHappyPath:
    def test_signs_and_retries(self, monkeypatch: pytest.MonkeyPatch):
        seen: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.headers))
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(
                200, text="paid article", headers={"X-PAYMENT-RESPONSE": "0xdef"}
            )

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))
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
        assert decoded["x402Version"] == 1
        assert decoded["scheme"] == "exact"


class TestSyncBudgetGate:
    def test_over_cap_refuses(self, monkeypatch: pytest.MonkeyPatch):
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(402, json=_make_402_body(amount="500000"))

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "budget_exceeded"
        assert result["reason"] == "max_per_call"
        assert len(calls) == 1

    def test_approval_declined(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=_make_402_body())

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(
                human_approval_above=Decimal("0.001"),
                approval_callback=lambda plan: False,
            )
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["status"] == "declined"
        assert tool.budget_policy.session_spent == Decimal("0")


class TestSyncRetryFailure:
    def test_retry_non_200(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(402, text="bad sig")

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "x402_retry_failed"
        assert tool.budget_policy.session_spent == Decimal("0")


class TestAsyncHappyPath:
    async def test_arun_signs_and_retries(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
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
        assert tool.budget_policy.session_spent == Decimal("0.01")


class TestBypassHelper:
    async def test_pay_async_helper(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free")

        _with_mock_async_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = await tool.pay_async("https://example.com/free")
        assert result["status"] == "no_payment_required"

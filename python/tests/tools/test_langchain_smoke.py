"""LangChain framework smoke test (XEN-148 PR 5d).

This is the "does it plug into LangChain" check that the other suites skip.
Everything else mocks the SDK internals to exercise our own code; this one
exercises XenarchPay through the ``BaseTool`` surface the framework itself
calls — ``name``, ``description``, ``args_schema``, ``invoke``,
``ainvoke`` — so if LangChain bumps a contract underneath us, a test fails
here before an agent at runtime does.
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

import httpx
import pytest
from eth_account import Account
from langchain_core.tools import BaseTool

from xenarch.tools import XenarchBudgetPolicy, XenarchPay


USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def _make_402_body() -> dict[str, Any]:
    return {
        "x402Version": 2,
        "error": "payment_required",
        "accepts": [
            {
                "scheme": "exact",
                "network": "eip155:8453",
                "asset": USDC,
                "amount": "10000",
                "payTo": "0x0000000000000000000000000000000000000001",
                "maxTimeoutSeconds": 60,
                "extra": {"name": "USD Coin", "version": "2"},
            }
        ],
    }


def _settle_header() -> str:
    return base64.b64encode(
        json.dumps(
            {
                "success": True,
                "transaction": "0xfeedface",
                "network": "eip155:8453",
            }
        ).encode()
    ).decode()


def _tool() -> XenarchPay:
    return XenarchPay(
        private_key=Account.create().key.hex(),
        budget_policy=XenarchBudgetPolicy(
            max_per_call=Decimal("0.05"),
            max_per_session=Decimal("1.00"),
        ),
        discover_via_pay_json=False,
        fetch_receipts=False,  # keep smoke test focused on LangChain surface
    )


class TestBaseToolContract:
    """The smallest checks that still prove upstream LangChain can use this."""

    def test_is_base_tool_subclass(self) -> None:
        assert issubclass(XenarchPay, BaseTool)

    def test_tool_metadata_is_populated(self) -> None:
        tool = _tool()
        assert tool.name == "xenarch_pay"
        # Description must be long enough that an LLM can decide when to
        # call it; a one-word description would pass type checks but
        # silently make the tool unusable in an agent loop.
        assert len(tool.description) > 40
        # args_schema is how LangChain tells the LLM what inputs to supply.
        # BaseTool auto-generates one from `_run`'s signature; verify the
        # `url` argument survives the round-trip.
        schema = tool.get_input_schema()
        assert "url" in schema.model_json_schema()["properties"]


class TestInvokeSync:
    def test_invoke_returns_json_string(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Prove `tool.invoke({"url": ...})` — the exact call shape a
        # LangChain agent produces — works and returns parseable JSON.
        def handler(req: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in req.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(
                200,
                text="the paid content",
                headers={"X-PAYMENT-RESPONSE": _settle_header()},
            )

        transport = httpx.MockTransport(handler)
        real_client = httpx.Client

        class _MC(real_client):  # type: ignore[misc,valid-type]
            def __init__(self, transport: httpx.MockTransport, **kw: Any) -> None:
                super().__init__(transport=transport, **kw)

        def _factory(*a: Any, **kw: Any) -> httpx.Client:
            kw.pop("transport", None)
            return _MC(transport=transport, **kw)

        monkeypatch.setattr("x402_agent._payer.httpx.Client", _factory)

        tool = _tool()
        out = tool.invoke({"url": "https://example.com/article/42"})
        # Tool contract is always a JSON string — LangChain shows it to the
        # LLM verbatim, so any stringification change is an agent-breaking
        # change.
        assert isinstance(out, str)
        body = json.loads(out)
        assert body["success"] is True
        assert body["body"] == "the paid content"
        assert body["amount_usd"] == "0.01"


class TestInvokeAsync:
    async def test_ainvoke_returns_json_string(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in req.headers}:
                return httpx.Response(402, json=_make_402_body())
            return httpx.Response(
                200,
                text="async paid",
                headers={"X-PAYMENT-RESPONSE": _settle_header()},
            )

        transport = httpx.MockTransport(handler)
        real_async = httpx.AsyncClient

        class _MAC(real_async):  # type: ignore[misc,valid-type]
            def __init__(
                self, transport: httpx.MockTransport, **kw: Any
            ) -> None:
                super().__init__(transport=transport, **kw)

        def _factory(*a: Any, **kw: Any) -> httpx.AsyncClient:
            kw.pop("transport", None)
            return _MAC(transport=transport, **kw)

        monkeypatch.setattr(
            "x402_agent._payer.httpx.AsyncClient", _factory
        )

        tool = _tool()
        out = await tool.ainvoke({"url": "https://example.com/async"})
        assert isinstance(out, str)
        body = json.loads(out)
        assert body["success"] is True
        assert body["body"] == "async paid"

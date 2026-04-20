"""Tests for XenarchPay sync path (XEN-148 PR 5b).

These tests exercise the 402 parse → budget → payment → retry flow against a
mocked httpx transport. The x402 SDK is left real; we generate a throwaway
Ethereum key and let the EIP-3009 signer actually sign. That way a regression
in how we construct the PaymentRequired dict (field aliases, missing extras)
surfaces here rather than in an integration run.
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


# Canonical USDC-on-Base accept entry. `amount` is 6-decimal atomic units —
# 10_000 = $0.01. `payTo` uses the x402 camelCase alias.
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
    # x402 v2 requires a few `extra` fields for EIP-712 domain separator;
    # populate them with USDC defaults so the SDK's EIP-3009 signer has
    # everything it needs. Tests that care about an empty `extra` can
    # still override — passing `extra={}` keeps the empty dict.
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
    *,
    budget: XenarchBudgetPolicy | None = None,
    transport: httpx.MockTransport | None = None,
) -> XenarchPay:
    """Build a XenarchPay with a throwaway key and (optionally) a mock transport.

    To inject an httpx.MockTransport, we monkeypatch `httpx.Client` at call
    time — see `_with_mock_transport` below. Keeping tool construction and
    transport injection separate keeps tests readable.
    """
    account = Account.create()
    return XenarchPay(
        private_key=account.key.hex(),
        budget_policy=budget or XenarchBudgetPolicy(),
    )


class _MockClient(httpx.Client):
    """httpx.Client subclass that forces a specific MockTransport in place."""

    def __init__(self, transport: httpx.MockTransport, **kwargs: Any) -> None:
        super().__init__(transport=transport, **kwargs)


def _with_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Any,
) -> None:
    """Patch httpx.Client so every `httpx.Client()` uses our mock transport."""
    transport = httpx.MockTransport(handler)

    def _client_factory(*args: Any, **kwargs: Any) -> httpx.Client:
        kwargs.pop("transport", None)
        return _MockClient(transport=transport, **kwargs)

    monkeypatch.setattr("xenarch.tools.x402_pay.httpx.Client", _client_factory)


class TestNoPaymentRequired:
    def test_200_passthrough_returns_body(self, monkeypatch: pytest.MonkeyPatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free content")

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/free"))
        assert result["status"] == "no_payment_required"
        assert result["http_status"] == 200
        assert result["body"] == "free content"


class Test402Parse:
    def test_v1_body_returns_parse_failed(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # V1 uses `x402Version: 1` and a different top-level shape. PR 5b
        # is V2-only, so V1 bodies must surface as parse_failed rather than
        # silently paying against a misread amount.
        v1_body = {"x402Version": 1, "accepts": []}

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=v1_body)

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "x402_parse_failed"

    def test_no_exact_scheme_refused(self, monkeypatch: pytest.MonkeyPatch):
        body = {
            "x402Version": 2,
            "error": "payment_required",
            "accepts": [
                {
                    "scheme": "upto",
                    "network": "eip155:8453",
                    "asset": USDC_BASE_ASSET,
                    "amount": "10000",
                    "payTo": "0x0",
                    "maxTimeoutSeconds": 60,
                    "extra": {},
                }
            ],
        }

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=body)

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "no_supported_scheme"
        # Attested accept list echoed so the agent can explain itself.
        assert result["accepts"] == [
            {"scheme": "upto", "network": "eip155:8453"}
        ]


class TestBudgetIntegration:
    def test_over_per_call_cap_refuses_without_paying(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # Amount = $0.50; per-call cap = $0.10. We must not hit the gate
        # with an X-PAYMENT header, so count the requests.
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(
                402, json=_make_402_body(amount="500000")  # $0.50
            )

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "budget_exceeded"
        assert result["reason"] == "max_per_call"
        # One call only — the unpaid GET. No retry with X-PAYMENT.
        assert len(calls) == 1
        assert "X-PAYMENT" not in calls[0].headers

    def test_approval_declined_short_circuits(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=_make_402_body(amount="10000"))

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(
                human_approval_above=Decimal("0.001"),
                approval_callback=lambda plan: False,
            )
        )
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["status"] == "declined"
        # Budget unchanged.
        assert tool.budget_policy.session_spent == Decimal("0")


class TestHappyPath:
    def test_signs_and_retries_with_x_payment_header(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        seen_headers: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_headers.append(dict(request.headers))
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(
                    402, json=_make_402_body(amount="10000")
                )
            return httpx.Response(
                200,
                text="paywalled article body",
                headers={"X-PAYMENT-RESPONSE": "0xabc123"},
            )

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))

        assert result["success"] is True
        assert result["amount_usd"] == "0.01"
        assert result["body"] == "paywalled article body"
        assert result["payment_response"] == "0xabc123"
        assert result["session_spent_usd"] == "0.01"

        # Exactly two requests. Second must carry a base64 X-PAYMENT.
        assert len(seen_headers) == 2
        retry_headers = {k.lower(): v for k, v in seen_headers[1].items()}
        assert "x-payment" in retry_headers
        header_value = retry_headers["x-payment"]
        decoded = base64.b64decode(header_value).decode("utf-8")
        parsed = json.loads(decoded)
        # x402 v2 payload has x402Version, payload dict, accepted entry.
        assert parsed["x402Version"] == 2
        assert "payload" in parsed
        assert parsed["accepted"]["scheme"] == "exact"

    def test_commit_before_any_post_payment_work(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # Regression for F5 (PR 5a adversarial finding): the commit must
        # happen as soon as the paid GET returns 200, not after any later
        # post-payment work. We simulate the "paid" response returning
        # normally; then we assert session_spent updated before _run
        # returned. (No easy way to inject failure mid-flight at this
        # layer — that's what the property tests in 5c will cover.)
        def handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(
                    402, json=_make_402_body(amount="10000")
                )
            return httpx.Response(200, text="ok")

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        tool._run("https://example.com/gated")
        assert tool.budget_policy.session_spent == Decimal("0.01")


class TestRetryFailure:
    def test_retry_non_200_surfaces_error(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # If the server rejects our payment (bad sig, replay, insufficient
        # balance), it returns 402 or 4xx with a fresh body. We return the
        # status and truncated body — and crucially do NOT commit spend.
        def handler(request: httpx.Request) -> httpx.Response:
            if "x-payment" not in {k.lower() for k in request.headers}:
                return httpx.Response(
                    402, json=_make_402_body(amount="10000")
                )
            return httpx.Response(402, text="invalid signature")

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "x402_retry_failed"
        assert result["http_status"] == 402
        assert "invalid signature" in result["body"]
        assert tool.budget_policy.session_spent == Decimal("0")


class TestDecimalsOverride:
    def test_extra_decimals_used_when_present(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # Some future non-USDC asset with 18 decimals. 10^18 = $1.00.
        body = _make_402_body(
            amount="1000000000000000000",
            extra={"decimals": 18},
        )

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json=body)

        _with_mock_transport(monkeypatch, handler)
        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        )
        # $1.00 > $0.10 cap — must refuse, not try to pay.
        result = json.loads(tool._run("https://example.com/gated"))
        assert result["error"] == "budget_exceeded"
        assert result["reason"] == "max_per_call"
        assert result["price_usd"] == "1"  # Decimal repr of exactly 1

"""Tests for XenarchPay's pay.json pre-discovery path (XEN-148 PR 5c).

Pay.json is a hint layer: it tells us up front whether a resource is worth
fetching at all. When a publisher advertises ``budget_hints`` that exceed
our caps we refuse early and save a network round-trip. When pay.json is
missing, broken, or just silent we fall through to the live 402 flow —
pay.json must never be the sole gate.

These tests patch ``pay_json.PayJson.fetch`` directly rather than going
through the httpx mock, because pay-json uses its own httpx.get call and
we don't want its network layer entangled with the x402 test transport.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import httpx
import pytest
from eth_account import Account
from pay_json import (
    PayJson,
    PayJsonError,
    PayJsonInvalid,
    PayJsonNotFound,
    Rule,
)

from xenarch.tools import XenarchBudgetPolicy, XenarchPay


def _make_rule(
    *,
    path: str = "/article/**",
    price_usd: str = "0.01",
    budget_hints: dict[str, Any] | None = None,
) -> Rule:
    return Rule(
        path=path,
        price_usd=Decimal(price_usd),
        terms=None,
        budget_hints=budget_hints,
        raw={},
    )


def _make_doc(rules: tuple[Rule, ...]) -> PayJson:
    return PayJson(
        version="1.1",
        protocol="x402",
        network="base",
        asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        receiver="0x0000000000000000000000000000000000000001",
        seller_wallet="0x0000000000000000000000000000000000000002",
        rules=rules,
        raw={},
    )


def _fresh_tool(
    *,
    budget: XenarchBudgetPolicy | None = None,
    discover: bool = True,
) -> XenarchPay:
    return XenarchPay(
        private_key=Account.create().key.hex(),
        budget_policy=budget or XenarchBudgetPolicy(),
        discover_via_pay_json=discover,
    )


class _MockClient(httpx.Client):
    """Subclass so ``super().__init__`` resolves the original Client class at
    class-definition time. If we called ``httpx.Client(...)`` from inside the
    factory, the monkeypatch would make the factory recurse into itself."""

    def __init__(self, transport: httpx.MockTransport, **kwargs: Any) -> None:
        super().__init__(transport=transport, **kwargs)


def _mock_resource_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    transport = httpx.MockTransport(handler)

    def _factory(*args: Any, **kwargs: Any) -> httpx.Client:
        kwargs.pop("transport", None)
        return _MockClient(transport=transport, **kwargs)

    monkeypatch.setattr("xenarch.tools.x402_pay.httpx.Client", _factory)


def _patch_payjson(monkeypatch: pytest.MonkeyPatch, result: Any) -> list[str]:
    """Patch ``PayJson.fetch`` to return (or raise) ``result``.

    ``result`` can be a PayJson doc to return, or an Exception instance
    to raise. Records the hosts it was called with so tests can assert
    the pre-check was reached.
    """
    seen: list[str] = []

    def fake_fetch(host: str, *, timeout: float = 5.0) -> PayJson:
        seen.append(host)
        if isinstance(result, Exception):
            raise result
        return result

    # pay_json.PayJson is a frozen dataclass and `fetch` is a classmethod.
    # Replacing it with a staticmethod drops the implicit `cls` arg so our
    # fake's `(host, *, timeout)` signature lines up with the call site in
    # `_pay_json_pre_check`, which calls `PayJson.fetch(host, timeout=...)`.
    monkeypatch.setattr(PayJson, "fetch", staticmethod(fake_fetch))
    return seen


class TestPayJsonNotFound:
    def test_404_falls_through_to_live_402(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # Host serves no pay.json. Must fall through silently — most
        # hosts today don't have one yet, so 404 has to be a non-event.
        seen = _patch_payjson(monkeypatch, PayJsonNotFound("no doc"))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free resource")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["status"] == "no_payment_required"
        assert seen == ["example.com"]


class TestBudgetHintRefusal:
    def test_per_call_hint_above_cap_refuses_early(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # Publisher advertises $2 per call; our cap is $0.10. Refuse
        # without ever hitting the resource URL.
        rule = _make_rule(
            budget_hints={"recommended_max_per_call": "2.00"}
        )
        _patch_payjson(monkeypatch, _make_doc((rule,)))

        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(200, text="should not be fetched")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(max_per_call=Decimal("0.10"))
        )
        result = json.loads(tool._run("https://example.com/article/123"))
        assert result["error"] == "budget_hint_exceeded"
        assert result["reason"] == "recommended_max_per_call"
        assert result["hint_usd"] == "2.00"
        assert result["limit_usd"] == "0.10"
        # Resource URL never touched.
        assert calls == []

    def test_per_session_hint_above_cap_refuses_early(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        rule = _make_rule(
            budget_hints={"recommended_max_per_session": "100.00"}
        )
        _patch_payjson(monkeypatch, _make_doc((rule,)))

        tool = _fresh_tool(
            budget=XenarchBudgetPolicy(max_per_session=Decimal("5.00"))
        )
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["error"] == "budget_hint_exceeded"
        assert result["reason"] == "recommended_max_per_session"

    def test_hint_within_cap_falls_through(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # Hint says $0.02, our cap is $0.10. Fine — proceed to 402 flow.
        rule = _make_rule(
            price_usd="0.02",
            budget_hints={"recommended_max_per_call": "0.02"},
        )
        _patch_payjson(monkeypatch, _make_doc((rule,)))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="free content")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["status"] == "no_payment_required"


class TestMalformedHints:
    def test_non_string_hint_falls_through(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # A pay.json where `recommended_max_per_call` is a raw number
        # (spec says string). We treat it as "no guidance" and fall
        # through — don't crash the pre-check on type surprises.
        rule = _make_rule(
            budget_hints={"recommended_max_per_call": 2.0}  # type: ignore[dict-item]
        )
        _patch_payjson(monkeypatch, _make_doc((rule,)))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="ok")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["status"] == "no_payment_required"

    def test_garbage_decimal_falls_through(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # `"NaN"` is a technically-valid Decimal but a nonsensical cap.
        # The pre-check must skip rather than refuse everything.
        rule = _make_rule(
            budget_hints={"recommended_max_per_call": "NaN"}
        )
        _patch_payjson(monkeypatch, _make_doc((rule,)))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="ok")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["status"] == "no_payment_required"


class TestInvalidDocument:
    def test_pay_json_invalid_is_hard_stop(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # A broken pay.json usually means the publisher is misconfigured
        # and the live 402 is probably broken too. Refuse with
        # `pay_json_invalid` instead of silently proceeding.
        _patch_payjson(
            monkeypatch, PayJsonInvalid("missing required field: receiver")
        )

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["error"] == "pay_json_invalid"
        assert result["host"] == "example.com"
        assert "receiver" in result["details"]

    def test_transport_error_falls_through(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # The pay.json endpoint times out or refuses connection. We
        # fall through to the live 402 — a flaky pay.json host must
        # not disable payments on a working resource.
        _patch_payjson(monkeypatch, PayJsonError("connection refused"))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="served")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["status"] == "no_payment_required"


class TestDiscoveryOff:
    def test_discovery_off_skips_pay_json(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # The pre-check shouldn't even call fetch when the field is off.
        seen = _patch_payjson(monkeypatch, PayJsonNotFound("boom"))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="ok")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool(discover=False)
        tool._run("https://example.com/article/a")
        assert seen == []


class TestNoMatchingRule:
    def test_path_without_rule_falls_through(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        # pay.json exists but no rule matches our path. Pre-check is a
        # no-op — the live 402 is authoritative.
        rule = _make_rule(path="/other/**")
        _patch_payjson(monkeypatch, _make_doc((rule,)))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="ok")

        _mock_resource_transport(monkeypatch, handler)

        tool = _fresh_tool()
        result = json.loads(tool._run("https://example.com/article/a"))
        assert result["status"] == "no_payment_required"

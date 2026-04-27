"""Tests for ``XenarchPayer`` post-XEN-179 V2 path.

Covers the route-via-third-party-facilitator + replay-with-gate-headers
flow that ``XenarchPayer`` adds on top of the framework-free V1 payer.
We mock both ``httpx.Client`` (the publisher fetch + facilitator settle
+ retry all share one client in the V2 flow) and ``httpx.AsyncClient``
via ``MockTransport``, then assert:

- the retry GET carries the canonical ``X-Xenarch-Gate-Id`` and
  ``X-Xenarch-Tx-Hash`` headers (lowercase compared, since httpx
  normalises);
- /settle is POSTed to the URL chosen by ``Router.select()``;
- failure of one facilitator falls back to the next;
- Router records success/failure on the right URL;
- a non-Xenarch 402 falls through to the V1 path unchanged.

The x402 SDK is left real; we sign with a throwaway key so a regression
in PaymentRequirements field aliases would surface here, not just in
integration.
"""

from __future__ import annotations

import json
import uuid
from decimal import Decimal
from typing import Any, Callable

import httpx
import pytest
from eth_account import Account

from xenarch._payer import XenarchPayer


USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
PAY_TO = "0x000000000000000000000000000000000000dEaD"
GATE_ID = "550e8400-e29b-41d4-a716-446655440099"
GOOD_TX = "0x" + "ab" * 32

PAYAI_URL = "https://facilitator.payai.network"
XPAY_URL = "https://facilitator.xpay.dev"


def _make_xenarch_envelope(
    *,
    facilitators: list[dict[str, str]] | None = None,
    amount: str = "10000",
    network: str = "base",
) -> dict[str, Any]:
    """Build a 402 body matching ``GateResponse`` (post-XEN-179 shape).

    Network defaults to V1 ``"base"`` so ``select_accept`` falls into the
    V1 preference branch — that's what the platform actually emits today
    (see ``tests/test_client.py:gate_response_data``).
    """
    return {
        "x402Version": 1,
        "accepts": [
            {
                "scheme": "exact",
                "network": network,
                "maxAmountRequired": amount,
                "resource": "https://example.com/article",
                "description": "Premium article",
                "mimeType": "text/html",
                "payTo": PAY_TO,
                "maxTimeoutSeconds": 60,
                "asset": USDC_BASE_ASSET,
                "extra": {"name": "USD Coin", "version": "2"},
            }
        ],
        "error": None,
        "xenarch": True,
        "gate_id": GATE_ID,
        "price_usd": "0.01",
        "seller_wallet": PAY_TO,
        "network": network,
        "asset": "USDC",
        "protocol": "x402",
        "facilitators": facilitators
        or [
            {"name": "PayAI", "url": PAYAI_URL, "spec_version": "v2"}
        ],
        "verify_url": f"https://xenarch.dev/v1/gates/{GATE_ID}/verify",
        "expires": "2026-04-25T00:00:00Z",
    }


def _fresh_payer() -> XenarchPayer:
    account = Account.create()
    # discover_via_pay_json off keeps the test offline.
    return XenarchPayer(
        private_key=account.key.hex(),
        discover_via_pay_json=False,
    )


class _MockClient(httpx.Client):
    def __init__(
        self, transport: httpx.MockTransport, **kwargs: Any
    ) -> None:
        super().__init__(transport=transport, **kwargs)


class _MockAsyncClient(httpx.AsyncClient):
    def __init__(
        self, transport: httpx.MockTransport, **kwargs: Any
    ) -> None:
        super().__init__(transport=transport, **kwargs)


def _patch_sync_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    """Force every ``httpx.Client(...)`` call inside the payer to use ours."""
    transport = httpx.MockTransport(handler)

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        kwargs.pop("transport", None)
        return _MockClient(transport=transport, **kwargs)

    # Patch the symbol the payer actually imports — both modules use the
    # ``import httpx`` form, so we patch ``httpx.Client`` itself.
    monkeypatch.setattr("xenarch._payer.httpx.Client", factory)
    monkeypatch.setattr("x402_agent._payer.httpx.Client", factory)


def _patch_async_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    transport = httpx.MockTransport(handler)

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("transport", None)
        return _MockAsyncClient(transport=transport, **kwargs)

    monkeypatch.setattr("xenarch._payer.httpx.AsyncClient", factory)
    monkeypatch.setattr("x402_agent._payer.httpx.AsyncClient", factory)


def _record(
    requests: list[httpx.Request], request: httpx.Request
) -> None:
    requests.append(request)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_v2_happy_path(monkeypatch: pytest.MonkeyPatch):
    """Single facilitator, settle succeeds, retry returns 200."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        url = str(request.url)
        if request.method == "GET" and url == "https://example.com/article":
            # Distinguish initial vs retry by the presence of gate headers.
            lc = {k.lower(): v for k, v in request.headers.items()}
            if "x-xenarch-gate-id" in lc:
                return httpx.Response(
                    200, text="paid article body"
                )
            return httpx.Response(402, json=_make_xenarch_envelope())
        if request.method == "POST" and url == f"{PAYAI_URL}/settle":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "transaction": GOOD_TX,
                    "network": "base",
                },
            )
        return httpx.Response(404, text=f"unexpected {request.method} {url}")

    _patch_sync_transport(monkeypatch, handler)

    payer = _fresh_payer()
    result = payer.pay("https://example.com/article")

    assert result.get("success") is True, result
    assert result["tx_hash"] == GOOD_TX
    assert result["facilitator"] == PAYAI_URL
    assert result["gate_id"] == GATE_ID
    assert result["body"] == "paid article body"
    assert result["amount_usd"] == "0.01"

    # Three requests total: initial GET, settle POST, retry GET.
    methods_urls = [(r.method, str(r.url)) for r in requests]
    assert methods_urls == [
        ("GET", "https://example.com/article"),
        ("POST", f"{PAYAI_URL}/settle"),
        ("GET", "https://example.com/article"),
    ]

    # The retry MUST carry both canonical headers, lowercase compared.
    retry = requests[2]
    lc = {k.lower(): v for k, v in retry.headers.items()}
    assert lc.get("x-xenarch-gate-id") == GATE_ID
    assert lc.get("x-xenarch-tx-hash") == GOOD_TX

    # Settle body shape sanity check.
    settle = requests[1]
    body = json.loads(settle.content)
    assert body["x402Version"] == 1
    assert "paymentPayload" in body
    assert "paymentRequirements" in body
    assert body["paymentRequirements"]["payTo"] == PAY_TO


# ---------------------------------------------------------------------------
# Fallback across multiple facilitators
# ---------------------------------------------------------------------------


def test_v2_facilitator_fallback(monkeypatch: pytest.MonkeyPatch):
    """First facilitator's /settle returns 500; second succeeds."""
    requests: list[httpx.Request] = []
    envelope = _make_xenarch_envelope(
        facilitators=[
            {"name": "PayAI", "url": PAYAI_URL, "spec_version": "v2"},
            {"name": "xpay", "url": XPAY_URL, "spec_version": "v2"},
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        url = str(request.url)
        if request.method == "GET" and url == "https://example.com/article":
            lc = {k.lower(): v for k, v in request.headers.items()}
            if "x-xenarch-gate-id" in lc:
                return httpx.Response(200, text="ok")
            return httpx.Response(402, json=envelope)
        if request.method == "POST" and url == f"{PAYAI_URL}/settle":
            return httpx.Response(500, text="boom")
        if request.method == "POST" and url == f"{XPAY_URL}/settle":
            return httpx.Response(
                200,
                json={"success": True, "transaction": GOOD_TX, "network": "base"},
            )
        return httpx.Response(404, text=f"unexpected {request.method} {url}")

    _patch_sync_transport(monkeypatch, handler)
    payer = _fresh_payer()
    result = payer.pay("https://example.com/article")

    assert result.get("success") is True, result
    assert result["facilitator"] == XPAY_URL
    assert result["tx_hash"] == GOOD_TX

    # Both facilitators were tried in router order.
    settle_urls = [
        str(r.url) for r in requests if r.method == "POST"
    ]
    assert f"{PAYAI_URL}/settle" in settle_urls
    assert f"{XPAY_URL}/settle" in settle_urls

    # Router reflects the outcomes.
    router = payer._router
    assert router is not None
    payai_state = router._states[PAYAI_URL]
    xpay_state = router._states[XPAY_URL]
    assert len(payai_state.failures) == 1
    assert len(payai_state.successes) == 0
    assert len(xpay_state.successes) == 1


# ---------------------------------------------------------------------------
# All facilitators fail — no retry GET, no spend
# ---------------------------------------------------------------------------


def test_v2_all_facilitators_fail(monkeypatch: pytest.MonkeyPatch):
    requests: list[httpx.Request] = []
    envelope = _make_xenarch_envelope(
        facilitators=[
            {"name": "PayAI", "url": PAYAI_URL, "spec_version": "v2"},
            {"name": "xpay", "url": XPAY_URL, "spec_version": "v2"},
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        url = str(request.url)
        if request.method == "GET" and url == "https://example.com/article":
            return httpx.Response(402, json=envelope)
        if request.method == "POST" and url.endswith("/settle"):
            return httpx.Response(500, text="boom")
        return httpx.Response(404, text=f"unexpected {request.method} {url}")

    _patch_sync_transport(monkeypatch, handler)
    payer = _fresh_payer()
    result = payer.pay("https://example.com/article")

    assert result.get("error") == "no_facilitator_settled", result
    assert set(result["tried"]) == {PAYAI_URL, XPAY_URL}

    # No retry GET issued — only initial GET + 2 settle POSTs.
    get_count = sum(1 for r in requests if r.method == "GET")
    assert get_count == 1
    # Spend not committed.
    assert payer.budget_policy.session_spent == Decimal("0")


# ---------------------------------------------------------------------------
# Retry still 402 — preserve tx_hash so caller can manually claim
# ---------------------------------------------------------------------------


def test_v2_retry_returns_402(monkeypatch: pytest.MonkeyPatch):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "GET" and url == "https://example.com/article":
            lc = {k.lower(): v for k, v in request.headers.items()}
            if "x-xenarch-gate-id" in lc:
                # Platform reject: cache miss, verify failed, etc.
                return httpx.Response(402, text="verify_rejected")
            return httpx.Response(402, json=_make_xenarch_envelope())
        if request.method == "POST" and url == f"{PAYAI_URL}/settle":
            return httpx.Response(
                200,
                json={"success": True, "transaction": GOOD_TX, "network": "base"},
            )
        return httpx.Response(404, text=f"unexpected {request.method} {url}")

    _patch_sync_transport(monkeypatch, handler)
    payer = _fresh_payer()
    result = payer.pay("https://example.com/article")

    assert result.get("error") == "xenarch_replay_failed", result
    assert result["tx_hash"] == GOOD_TX
    assert result["facilitator"] == PAYAI_URL
    assert result["http_status"] == 402
    assert result["gate_id"] == GATE_ID
    # Spend not committed — V2 only commits on a 200 retry.
    assert payer.budget_policy.session_spent == Decimal("0")


# ---------------------------------------------------------------------------
# Non-Xenarch 402 falls through to V1
# ---------------------------------------------------------------------------


def test_v2_falls_through_for_non_xenarch_402(monkeypatch: pytest.MonkeyPatch):
    """A bare x402 402 with no ``xenarch: true`` envelope must take the V1
    path. We construct a body that V1 itself rejects (no supported scheme)
    so the flow is observable without a real EIP-712 round trip.
    """
    bare_v1 = {
        "x402Version": 1,
        "accepts": [
            {
                "scheme": "upto",  # not "exact" — V1 select_accept rejects
                "network": "base",
                "maxAmountRequired": "10000",
                "resource": "https://example.com/article",
                "description": "",
                "mimeType": "text/html",
                "payTo": PAY_TO,
                "maxTimeoutSeconds": 60,
                "asset": USDC_BASE_ASSET,
                "extra": {},
            }
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "GET" and url == "https://example.com/article":
            return httpx.Response(402, json=bare_v1)
        return httpx.Response(404, text=f"unexpected {request.method} {url}")

    _patch_sync_transport(monkeypatch, handler)
    payer = _fresh_payer()
    result = payer.pay("https://example.com/article")

    # V1 path's signature: ``no_supported_scheme`` with the rejected accepts
    # echoed back. None of the V2 fields appear.
    assert result.get("error") == "no_supported_scheme", result
    assert "tx_hash" not in result
    assert "facilitator" not in result
    assert "gate_id" not in result


# ---------------------------------------------------------------------------
# Async happy path — mirror sync to confirm pay_async() override works
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_v2_happy_path_async(monkeypatch: pytest.MonkeyPatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        url = str(request.url)
        if request.method == "GET" and url == "https://example.com/article":
            lc = {k.lower(): v for k, v in request.headers.items()}
            if "x-xenarch-gate-id" in lc:
                return httpx.Response(200, text="paid article body")
            return httpx.Response(402, json=_make_xenarch_envelope())
        if request.method == "POST" and url == f"{PAYAI_URL}/settle":
            return httpx.Response(
                200,
                json={"success": True, "transaction": GOOD_TX, "network": "base"},
            )
        return httpx.Response(404, text=f"unexpected {request.method} {url}")

    _patch_async_transport(monkeypatch, handler)
    payer = _fresh_payer()
    result = await payer.pay_async("https://example.com/article")

    assert result.get("success") is True, result
    assert result["tx_hash"] == GOOD_TX
    assert result["facilitator"] == PAYAI_URL
    retry = requests[-1]
    lc = {k.lower(): v for k, v in retry.headers.items()}
    assert lc["x-xenarch-gate-id"] == GATE_ID
    assert lc["x-xenarch-tx-hash"] == GOOD_TX


# ---------------------------------------------------------------------------
# Empty router list (publisher facilitators not in injected router stack)
# ---------------------------------------------------------------------------


def test_v2_no_supported_facilitator(monkeypatch: pytest.MonkeyPatch):
    """If the caller injects a Router whose registered stack doesn't
    overlap with the publisher's facilitators[], select() returns []."""
    from xenarch.router import FacilitatorConfig, Router

    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        url = str(request.url)
        if request.method == "GET" and url == "https://example.com/article":
            return httpx.Response(402, json=_make_xenarch_envelope())
        return httpx.Response(404, text=f"unexpected {request.method} {url}")

    _patch_sync_transport(monkeypatch, handler)

    # Inject a router whose only facilitator has a chain the gate doesn't
    # use, so select() returns []. Publisher list is also unrelated.
    other = FacilitatorConfig(
        name="other",
        url="https://other.example",
        supported_chains=frozenset({"solana"}),
    )
    account = Account.create()
    payer = XenarchPayer(
        private_key=account.key.hex(),
        discover_via_pay_json=False,
        router=Router(facilitators=[other]),
    )

    result = payer.pay("https://example.com/article")
    assert result.get("error") == "no_facilitator_settled"
    assert result["tried"] == []
    # No settle POST issued.
    assert all(r.method != "POST" for r in requests)
    assert payer.budget_policy.session_spent == Decimal("0")

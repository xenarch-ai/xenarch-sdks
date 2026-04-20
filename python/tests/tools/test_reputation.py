"""Unit tests for the reputation-gate helper (XEN-148 PR 5d).

The gate is opt-in via ``XenarchPay.require_reputation_score``; these tests
exercise the underlying HTTP wrapper in isolation. 404 → score 0.0 is the
contract that keeps the gate failing closed for unknown receivers, which is
the point of the gate — known bad actors AND unknown actors both refuse.
"""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from xenarch._reputation import fetch_score, fetch_score_async


class TestFetchScoreSync:
    def test_200_returns_decimal(self, monkeypatch: pytest.MonkeyPatch) -> None:
        transport = httpx.MockTransport(
            lambda req: httpx.Response(
                200,
                json={
                    "address": "0xabc",
                    "verified_payments": 50,
                    "total_received_usd": "12.34",
                    "first_paid_at": "2026-01-01T00:00:00Z",
                    "last_paid_at": "2026-04-18T00:00:00Z",
                    "score": 0.85,
                },
            )
        )
        monkeypatch.setattr(
            "xenarch._reputation.httpx.get",
            lambda *a, **kw: httpx.Client(transport=transport).get(*a, **kw),
        )
        assert fetch_score("https://xenarch.dev", "0xabc") == Decimal("0.85")

    def test_404_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        transport = httpx.MockTransport(
            lambda req: httpx.Response(
                404, json={"detail": "Insufficient payment history for scoring"}
            )
        )
        monkeypatch.setattr(
            "xenarch._reputation.httpx.get",
            lambda *a, **kw: httpx.Client(transport=transport).get(*a, **kw),
        )
        assert fetch_score("https://xenarch.dev", "0xabc") == Decimal("0")

    def test_500_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        transport = httpx.MockTransport(
            lambda req: httpx.Response(500, text="kaboom")
        )
        monkeypatch.setattr(
            "xenarch._reputation.httpx.get",
            lambda *a, **kw: httpx.Client(transport=transport).get(*a, **kw),
        )
        with pytest.raises(httpx.HTTPError):
            fetch_score("https://xenarch.dev", "0xabc")


class TestFetchScoreAsync:
    async def test_happy_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        transport = httpx.MockTransport(
            lambda req: httpx.Response(200, json={"score": 0.42})
        )

        class _MockAsyncClient(httpx.AsyncClient):
            def __init__(self, **kwargs: object) -> None:
                kwargs.pop("transport", None)
                super().__init__(transport=transport, **kwargs)

        monkeypatch.setattr(
            "xenarch._reputation.httpx.AsyncClient", _MockAsyncClient
        )
        assert await fetch_score_async(
            "https://xenarch.dev", "0xabc"
        ) == Decimal("0.42")

    async def test_404_returns_zero(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        transport = httpx.MockTransport(lambda req: httpx.Response(404))

        class _MockAsyncClient(httpx.AsyncClient):
            def __init__(self, **kwargs: object) -> None:
                kwargs.pop("transport", None)
                super().__init__(transport=transport, **kwargs)

        monkeypatch.setattr(
            "xenarch._reputation.httpx.AsyncClient", _MockAsyncClient
        )
        assert await fetch_score_async(
            "https://xenarch.dev", "0xabc"
        ) == Decimal("0")

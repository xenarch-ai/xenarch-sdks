"""Tests for ASGI middleware (post-XEN-179 protocol).

Verification flow under test:

* Bot hits /article without payment headers → 402 with new shape.
* Bot hits /article with X-Xenarch-Gate-Id + X-Xenarch-Tx-Hash, the
  middleware re-verifies via the platform, then passes through.
* Repeat verified hit within cache TTL skips the platform call.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from xenarch.client import (
    FacilitatorOption,
    GateResponse,
    PaymentRequirements,
    VerifiedPaymentResponse,
    XenarchAPIError,
)

from tests.conftest import TEST_GATE_ID, TEST_TX_HASH


@pytest.fixture
def mock_gate() -> GateResponse:
    return GateResponse(
        x402Version=1,
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="base",
                maxAmountRequired="10000",
                resource="https://example.com/article",
                description="",
                mimeType="text/html",
                payTo="0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                maxTimeoutSeconds=3600,
                asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            )
        ],
        gate_id=TEST_GATE_ID,
        price_usd="0.01",
        seller_wallet="0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        network="base",
        facilitators=[FacilitatorOption(name="PayAI", url="https://facilitator.payai.network")],
        verify_url=f"https://xenarch.dev/v1/gates/{TEST_GATE_ID}/verify",
        expires="2026-04-25T00:00:00Z",
    )


@pytest.fixture
def mock_verified() -> VerifiedPaymentResponse:
    return VerifiedPaymentResponse(
        gate_id=TEST_GATE_ID,
        status="paid",
        tx_hash=TEST_TX_HASH,
        amount_usd="0.01",
        verified_at="2026-04-24T01:00:00Z",
    )


class TestXenarchMiddleware:
    @pytest.mark.asyncio
    async def test_human_request_passes_through(self, async_client):
        resp = await async_client.get(
            "/",
            headers={"user-agent": "Mozilla/5.0 Chrome/120.0"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"message": "hello"}

    @pytest.mark.asyncio
    async def test_bot_request_returns_402_with_new_shape(self, async_client, mock_gate):
        with patch(
            "xenarch.middleware.XenarchClient.create_gate",
            new_callable=AsyncMock,
            return_value=mock_gate,
        ):
            resp = await async_client.get(
                "/article",
                headers={"user-agent": "GPTBot/1.0"},
            )
        assert resp.status_code == 402
        body = resp.json()
        assert body["xenarch"] is True
        assert body["protocol"] == "x402"
        assert body["seller_wallet"] == "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        assert "splitter" not in body
        assert "collector" not in body
        assert isinstance(body["accepts"], list) and len(body["accepts"]) == 1
        assert body["accepts"][0]["payTo"] == body["seller_wallet"]
        assert isinstance(body["facilitators"], list) and len(body["facilitators"]) == 1

    @pytest.mark.asyncio
    async def test_bot_with_verified_headers_passes_through(self, async_client, mock_verified):
        with patch(
            "xenarch.middleware.XenarchClient.verify_payment",
            new_callable=AsyncMock,
            return_value=mock_verified,
        ):
            resp = await async_client.get(
                "/article",
                headers={
                    "user-agent": "GPTBot/1.0",
                    "x-xenarch-gate-id": TEST_GATE_ID,
                    "x-xenarch-tx-hash": TEST_TX_HASH,
                },
            )
        assert resp.status_code == 200
        assert resp.json() == {"content": "premium article"}

    @pytest.mark.asyncio
    async def test_bot_with_rejected_verification_returns_402(
        self, async_client, mock_gate
    ):
        with patch(
            "xenarch.middleware.XenarchClient.verify_payment",
            new_callable=AsyncMock,
            side_effect=XenarchAPIError(404, "Gate not found"),
        ), patch(
            "xenarch.middleware.XenarchClient.create_gate",
            new_callable=AsyncMock,
            return_value=mock_gate,
        ):
            resp = await async_client.get(
                "/article",
                headers={
                    "user-agent": "GPTBot/1.0",
                    "x-xenarch-gate-id": TEST_GATE_ID,
                    "x-xenarch-tx-hash": TEST_TX_HASH,
                },
            )
        assert resp.status_code == 402

    @pytest.mark.asyncio
    async def test_excluded_path_passes_through_for_bots(self, async_client):
        resp = await async_client.get(
            "/health",
            headers={"user-agent": "GPTBot/1.0"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

    @pytest.mark.asyncio
    async def test_create_gate_failure_passes_bot_through(self, async_client):
        with patch(
            "xenarch.middleware.XenarchClient.create_gate",
            new_callable=AsyncMock,
            side_effect=Exception("API down"),
        ):
            resp = await async_client.get(
                "/article",
                headers={"user-agent": "GPTBot/1.0"},
            )
        assert resp.status_code == 200
        assert resp.json() == {"content": "premium article"}

    @pytest.mark.asyncio
    async def test_repeat_verification_within_ttl_skips_platform_call(
        self, async_client, mock_verified
    ):
        with patch(
            "xenarch.middleware.XenarchClient.verify_payment",
            new_callable=AsyncMock,
            return_value=mock_verified,
        ) as mock_verify:
            for _ in range(3):
                resp = await async_client.get(
                    "/article",
                    headers={
                        "user-agent": "GPTBot/1.0",
                        "x-xenarch-gate-id": TEST_GATE_ID,
                        "x-xenarch-tx-hash": TEST_TX_HASH,
                    },
                )
                assert resp.status_code == 200
            # Cache means we only hit the platform once for the same (gate, tx) pair.
            assert mock_verify.call_count == 1

    @pytest.mark.asyncio
    async def test_partial_payment_headers_treated_as_unverified(
        self, async_client, mock_gate
    ):
        # Only gate_id, no tx_hash → middleware should fall through to bot/402 path.
        with patch(
            "xenarch.middleware.XenarchClient.verify_payment",
            new_callable=AsyncMock,
        ) as mock_verify, patch(
            "xenarch.middleware.XenarchClient.create_gate",
            new_callable=AsyncMock,
            return_value=mock_gate,
        ):
            resp = await async_client.get(
                "/article",
                headers={
                    "user-agent": "GPTBot/1.0",
                    "x-xenarch-gate-id": TEST_GATE_ID,
                },
            )
        assert resp.status_code == 402
        mock_verify.assert_not_called()

"""Tests for the async HTTP client.

Mocks here MUST mirror the post-XEN-179 platform shape declared in
``xenarch-platform/app/schemas/gates.py``. If the platform changes its
response shape and these mocks don't, the SDK will silently break in
production while tests stay green — exactly the trap that motivated
XEN-183.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from xenarch.client import (
    FacilitatorOption,
    GateResponse,
    GateStatusResponse,
    PaymentRequirements,
    VerifiedPaymentResponse,
    XenarchAPIError,
    XenarchClient,
)


GATE_ID = "550e8400-e29b-41d4-a716-446655440001"
TX_HASH = "0x" + "a" * 64


@pytest.fixture
def gate_response_data():
    """Minimal valid 402 body matching app/schemas/gates.py:GateCreateResponse."""
    return {
        "x402Version": 1,
        "accepts": [
            {
                "scheme": "exact",
                "network": "base",
                "maxAmountRequired": "10000",  # 0.01 USDC in atomic units
                "resource": "https://example.com/article/1",
                "description": "Access to https://example.com/article/1",
                "mimeType": "text/html",
                "payTo": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                "maxTimeoutSeconds": 3600,
                "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "extra": {"name": "USD Coin", "version": "2"},
            }
        ],
        "error": None,
        "xenarch": True,
        "gate_id": GATE_ID,
        "price_usd": "0.01",
        "seller_wallet": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        "network": "base",
        "asset": "USDC",
        "protocol": "x402",
        "facilitators": [
            {"name": "PayAI", "url": "https://facilitator.payai.network", "spec_version": "v2"},
            {"name": "xpay", "url": "https://facilitator.xpay.dev", "spec_version": "v2"},
        ],
        "verify_url": f"https://xenarch.dev/v1/gates/{GATE_ID}/verify",
        "expires": "2026-04-25T00:00:00Z",
    }


@pytest.fixture
def verified_payment_data():
    return {
        "gate_id": GATE_ID,
        "status": "paid",
        "tx_hash": TX_HASH,
        "amount_usd": "0.01",
        "verified_at": "2026-04-24T01:00:00Z",
    }


@pytest.fixture
def gate_status_data():
    return {
        "gate_id": GATE_ID,
        "status": "pending",
        "price_usd": "0.01",
        "created_at": "2026-04-24T00:00:00Z",
        "paid_at": None,
    }


class TestXenarchClient:
    @pytest.mark.asyncio
    async def test_create_gate(self, gate_response_data):
        mock_resp = httpx.Response(402, json=gate_response_data)
        with patch.object(httpx.AsyncClient, "post", return_value=mock_resp):
            async with XenarchClient("token") as client:
                gate = await client.create_gate("/article/1")
        assert isinstance(gate, GateResponse)
        assert gate.xenarch is True
        assert gate.protocol == "x402"
        assert gate.seller_wallet == "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        assert len(gate.accepts) == 1
        assert isinstance(gate.accepts[0], PaymentRequirements)
        assert gate.accepts[0].pay_to == gate.seller_wallet
        assert len(gate.facilitators) == 2
        assert isinstance(gate.facilitators[0], FacilitatorOption)
        assert gate.facilitators[0].name == "PayAI"

    @pytest.mark.asyncio
    async def test_create_gate_sends_correct_body(self, gate_response_data):
        mock_resp = httpx.Response(402, json=gate_response_data)
        with patch.object(httpx.AsyncClient, "post", return_value=mock_resp) as mock:
            async with XenarchClient("my-token", api_base="https://test.bot") as client:
                await client.create_gate("/page", detection_method="ua")
                mock.assert_called_once_with(
                    "/gates",
                    json={"url": "/page", "detection_method": "ua"},
                )

    @pytest.mark.asyncio
    async def test_verify_payment(self, verified_payment_data):
        mock_resp = httpx.Response(200, json=verified_payment_data)
        with patch.object(httpx.AsyncClient, "post", return_value=mock_resp):
            async with XenarchClient("token") as client:
                result = await client.verify_payment(uuid.UUID(GATE_ID), TX_HASH)
        assert isinstance(result, VerifiedPaymentResponse)
        assert result.tx_hash == TX_HASH
        assert result.status == "paid"
        # No access_token field — XEN-179 dropped it.
        assert not hasattr(result, "access_token")

    @pytest.mark.asyncio
    async def test_verify_payment_sends_tx_hash_in_body(self, verified_payment_data):
        mock_resp = httpx.Response(200, json=verified_payment_data)
        with patch.object(httpx.AsyncClient, "post", return_value=mock_resp) as mock:
            async with XenarchClient("token") as client:
                await client.verify_payment(GATE_ID, TX_HASH)
                mock.assert_called_once_with(
                    f"/gates/{GATE_ID}/verify",
                    json={"tx_hash": TX_HASH},
                )

    @pytest.mark.asyncio
    async def test_get_gate(self, gate_status_data):
        mock_resp = httpx.Response(200, json=gate_status_data)
        with patch.object(httpx.AsyncClient, "get", return_value=mock_resp):
            async with XenarchClient("token") as client:
                result = await client.get_gate(GATE_ID)
        assert isinstance(result, GateStatusResponse)
        assert result.status == "pending"

    @pytest.mark.asyncio
    async def test_api_error_on_500(self):
        mock_resp = httpx.Response(500, text="Internal Server Error")
        with patch.object(httpx.AsyncClient, "get", return_value=mock_resp):
            async with XenarchClient("token") as client:
                with pytest.raises(XenarchAPIError) as exc_info:
                    await client.get_gate(GATE_ID)
                assert exc_info.value.status_code == 500

    @pytest.mark.asyncio
    async def test_verify_payment_404_raises(self):
        mock_resp = httpx.Response(404, text="Gate not found")
        with patch.object(httpx.AsyncClient, "post", return_value=mock_resp):
            async with XenarchClient("token") as client:
                with pytest.raises(XenarchAPIError) as exc_info:
                    await client.verify_payment(GATE_ID, TX_HASH)
                assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    async def test_context_manager_closes_client(self):
        with patch.object(httpx.AsyncClient, "aclose", new_callable=AsyncMock) as mock:
            async with XenarchClient("token"):
                pass
            mock.assert_called_once()

    @pytest.mark.asyncio
    async def test_default_api_base_is_xenarch_dev(self):
        async with XenarchClient("token") as client:
            assert client._api_base == "https://xenarch.dev"
            assert "v1" in str(client._client.base_url)

    @pytest.mark.asyncio
    async def test_no_legacy_splitter_field_on_gate_response(self, gate_response_data):
        mock_resp = httpx.Response(402, json=gate_response_data)
        with patch.object(httpx.AsyncClient, "post", return_value=mock_resp):
            async with XenarchClient("token") as client:
                gate = await client.create_gate("/article/1")
        # Defensive: post-XEN-179 GateResponse must not surface a `splitter` attr.
        assert not hasattr(gate, "splitter")
        assert not hasattr(gate, "collector")

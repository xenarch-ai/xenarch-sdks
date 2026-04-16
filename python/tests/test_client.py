"""Tests for the async HTTP client."""

import uuid
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from xenarch.client import (
    GateResponse,
    GateStatusResponse,
    VerifyResponse,
    XenarchAPIError,
    XenarchClient,
)


@pytest.fixture
def gate_response_data():
    return {
        "xenarch": True,
        "gate_id": "550e8400-e29b-41d4-a716-446655440001",
        "price_usd": "0.01",
        "splitter": "0x1234567890abcdef1234567890abcdef12345678",
        "collector": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        "network": "base",
        "asset": "USDC",
        "protocol": "x402",
        "verify_url": "https://xenarch.dev/v1/gates/550e8400-e29b-41d4-a716-446655440001",
        "expires": "2026-03-16T00:00:00Z",
    }


@pytest.fixture
def verify_response_data():
    return {
        "access_token": "eyJhbGciOi.signature",
        "expires_at": "2026-03-16T01:00:00Z",
    }


@pytest.fixture
def gate_status_data():
    return {
        "gate_id": "550e8400-e29b-41d4-a716-446655440001",
        "status": "pending",
        "price_usd": "0.01",
        "created_at": "2026-03-15T00:00:00Z",
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
    async def test_verify_payment(self, verify_response_data):
        mock_resp = httpx.Response(200, json=verify_response_data)
        with patch.object(httpx.AsyncClient, "post", return_value=mock_resp):
            async with XenarchClient("token") as client:
                result = await client.verify_payment(
                    uuid.UUID("550e8400-e29b-41d4-a716-446655440001"),
                    "0x" + "a" * 64,
                )
                assert isinstance(result, VerifyResponse)
                assert result.access_token == "eyJhbGciOi.signature"

    @pytest.mark.asyncio
    async def test_get_gate(self, gate_status_data):
        mock_resp = httpx.Response(200, json=gate_status_data)
        with patch.object(httpx.AsyncClient, "get", return_value=mock_resp):
            async with XenarchClient("token") as client:
                result = await client.get_gate("550e8400-e29b-41d4-a716-446655440001")
                assert isinstance(result, GateStatusResponse)
                assert result.status == "pending"

    @pytest.mark.asyncio
    async def test_api_error(self):
        mock_resp = httpx.Response(500, text="Internal Server Error")
        with patch.object(httpx.AsyncClient, "get", return_value=mock_resp):
            async with XenarchClient("token") as client:
                with pytest.raises(XenarchAPIError) as exc_info:
                    await client.get_gate("550e8400-e29b-41d4-a716-446655440001")
                assert exc_info.value.status_code == 500

    @pytest.mark.asyncio
    async def test_context_manager(self):
        with patch.object(httpx.AsyncClient, "aclose", new_callable=AsyncMock) as mock:
            async with XenarchClient("token"):
                pass
            mock.assert_called_once()

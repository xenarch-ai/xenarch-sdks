"""Tests for ASGI middleware."""

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import (
    ACCESS_TOKEN_SECRET,
    SITE_ID,
    SITE_TOKEN,
    generate_test_token,
)
from xenarch.client import GateResponse


@pytest.fixture
def mock_gate():
    return GateResponse(
        xenarch=True,
        gate_id="550e8400-e29b-41d4-a716-446655440001",
        price_usd="0.01",
        splitter="0x1234567890abcdef1234567890abcdef12345678",
        collector="0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        network="base",
        asset="USDC",
        protocol="x402",
        verify_url="https://xenarch.bot/v1/gates/550e8400-e29b-41d4-a716-446655440001",
        expires="2026-03-16T00:00:00Z",
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
    async def test_bot_request_returns_402(self, async_client, mock_gate):
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
            data = resp.json()
            assert data["xenarch"] is True
            assert data["protocol"] == "x402"

    @pytest.mark.asyncio
    async def test_bot_with_valid_token_passes_through(self, async_client):
        token = generate_test_token()
        resp = await async_client.get(
            "/article",
            headers={
                "user-agent": "GPTBot/1.0",
                "authorization": f"Bearer {token}",
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {"content": "premium article"}

    @pytest.mark.asyncio
    async def test_bot_with_expired_token_returns_402(self, async_client, mock_gate):
        token = generate_test_token(expired=True)
        with patch(
            "xenarch.middleware.XenarchClient.create_gate",
            new_callable=AsyncMock,
            return_value=mock_gate,
        ):
            resp = await async_client.get(
                "/article",
                headers={
                    "user-agent": "ClaudeBot/1.0",
                    "authorization": f"Bearer {token}",
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
    async def test_api_failure_passes_through(self, async_client):
        with patch(
            "xenarch.middleware.XenarchClient.create_gate",
            new_callable=AsyncMock,
            side_effect=Exception("API down"),
        ):
            resp = await async_client.get(
                "/article",
                headers={"user-agent": "GPTBot/1.0"},
            )
            # Graceful degradation: pass through on API failure
            assert resp.status_code == 200
            assert resp.json() == {"content": "premium article"}

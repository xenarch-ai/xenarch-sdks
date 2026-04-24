"""Shared fixtures and helpers for SDK tests."""

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from xenarch.middleware import XenarchMiddleware

SITE_TOKEN = "test-site-token-abc123"
TEST_GATE_ID = "660e8400-e29b-41d4-a716-446655440001"
TEST_TX_HASH = "0x" + "a" * 64


def _create_test_app() -> FastAPI:
    app = FastAPI()

    @app.get("/")
    async def index():
        return {"message": "hello"}

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/article")
    async def article():
        return {"content": "premium article"}

    return app


@pytest.fixture
def test_app():
    """FastAPI app wrapped with XenarchMiddleware."""
    inner = _create_test_app()
    app = XenarchMiddleware(
        app=inner,
        site_token=SITE_TOKEN,
        api_base="https://xenarch.dev",
        excluded_paths={"/health"},
    )
    return app


@pytest.fixture
def async_client(test_app):
    """httpx AsyncClient using ASGI transport."""
    return AsyncClient(
        transport=ASGITransport(app=test_app),
        base_url="http://testserver",
    )

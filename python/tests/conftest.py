"""Shared fixtures and helpers for SDK tests."""

import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from xenarch.middleware import XenarchMiddleware

SITE_TOKEN = "test-site-token-abc123"
SITE_ID = "550e8400-e29b-41d4-a716-446655440000"
ACCESS_TOKEN_SECRET = "test-secret-key-for-hmac-verification"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def generate_test_token(
    site_id: str = SITE_ID,
    secret: str = ACCESS_TOKEN_SECRET,
    expired: bool = False,
    gate_id: str = "660e8400-e29b-41d4-a716-446655440001",
    url: str = "/article",
    scope: str = "page",
    path_pattern: str | None = None,
) -> str:
    """Generate a valid HMAC-SHA256 access token for testing."""
    now = datetime.now(timezone.utc)
    if expired:
        exp = int(now.timestamp()) - 3600  # 1 hour ago
    else:
        exp = int(now.timestamp()) + 3600  # 1 hour from now

    payload = {
        "gate_id": gate_id,
        "site_id": site_id,
        "url": url,
        "scope": scope,
        "iat": int(now.timestamp()),
        "exp": exp,
    }
    if path_pattern is not None:
        payload["path_pattern"] = path_pattern

    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(
        secret.encode("utf-8"),
        payload_bytes,
        hashlib.sha256,
    ).digest()

    return f"{_b64url_encode(payload_bytes)}.{_b64url_encode(signature)}"


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
        site_id=SITE_ID,
        access_token_secret=ACCESS_TOKEN_SECRET,
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

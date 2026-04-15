"""Raw ASGI middleware for gating bot requests behind Xenarch payments."""

from __future__ import annotations

import json
import logging
from typing import Any

from xenarch.client import XenarchClient
from xenarch.detection import is_bot
from xenarch.token import verify_access_token

logger = logging.getLogger("xenarch.middleware")


class XenarchMiddleware:
    """ASGI middleware that gates bot requests behind payment.

    Human requests pass through with zero impact. Bot requests without
    a valid access token get a 402 with gate details.

    Uses raw ASGI (not BaseHTTPMiddleware) to avoid streaming issues.
    """

    def __init__(
        self,
        app: Any,
        site_token: str,
        site_id: str,
        access_token_secret: str,
        api_base: str = "https://api.xenarch.dev",
        excluded_paths: set[str] | None = None,
    ) -> None:
        self.app = app
        self.site_token = site_token
        self.site_id = site_id
        self.access_token_secret = access_token_secret
        self.api_base = api_base
        self.excluded_paths = excluded_paths or set()
        self._client: XenarchClient | None = None

    def _get_client(self) -> XenarchClient:
        """Lazy client creation — only instantiated on first bot detection."""
        if self._client is None:
            self._client = XenarchClient(
                site_token=self.site_token,
                api_base=self.api_base,
            )
        return self._client

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path in self.excluded_paths:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        auth_value = headers.get(b"authorization", b"").decode("latin-1")
        if auth_value.startswith("Bearer "):
            token = auth_value[7:]
            payload = verify_access_token(
                token, self.site_id, self.access_token_secret, url=path
            )
            if payload is not None:
                await self.app(scope, receive, send)
                return

        user_agent = headers.get(b"user-agent", b"").decode("latin-1")
        if not is_bot(user_agent):
            await self.app(scope, receive, send)
            return

        # Bot without valid token — create gate
        try:
            client = self._get_client()
            gate = await client.create_gate(url=path)
            body = json.dumps(gate.model_dump(mode="json"), default=str).encode()
            await _send_response(send, 402, body, "application/json")
        except Exception:
            logger.warning(
                "Xenarch API unavailable — passing through bot request",
                exc_info=True,
            )
            await self.app(scope, receive, send)


async def _send_response(
    send: Any,
    status: int,
    body: bytes,
    content_type: str,
) -> None:
    """Send a complete HTTP response via ASGI."""
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                [b"content-type", content_type.encode()],
                [b"content-length", str(len(body)).encode()],
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})

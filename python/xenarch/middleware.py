"""Raw ASGI middleware for gating bot requests behind Xenarch payments.

Post-XEN-179 verification flow:

* Bot hits a gated route without payment headers → middleware creates a
  gate via ``POST /v1/gates`` and returns 402 with the new x402 v1
  ``accepts`` array plus Xenarch metadata (gate_id, seller_wallet,
  facilitators).
* Agent settles via its facilitator of choice, then calls
  ``POST /v1/gates/{gate_id}/verify`` with the on-chain ``tx_hash``.
* Agent retries the gated route with ``X-Xenarch-Gate-Id`` and
  ``X-Xenarch-Tx-Hash`` headers. Middleware re-confirms via the
  platform's verify endpoint (idempotent — the platform writes the
  ``verified_payment`` row on first call, returns 200 on subsequent
  calls without re-doing on-chain work).
* Positive verifications are cached in-memory by ``(gate_id, tx_hash)``
  for ``cache_ttl_s`` seconds so we don't hammer the platform on every
  page view.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from xenarch.client import XenarchAPIError, XenarchClient
from xenarch.detection import is_bot

logger = logging.getLogger("xenarch.middleware")

GATE_ID_HEADER = b"x-xenarch-gate-id"
TX_HASH_HEADER = b"x-xenarch-tx-hash"


class XenarchMiddleware:
    """ASGI middleware that gates bot requests behind payment.

    Human requests pass through with zero impact. Bot requests without a
    valid (gate_id, tx_hash) pair get a 402 with gate details. Subsequent
    bot requests carrying the headers are re-verified against the
    platform and pass through on success.

    Uses raw ASGI (not BaseHTTPMiddleware) to avoid streaming issues.
    """

    def __init__(
        self,
        app: Any,
        site_token: str,
        api_base: str = "https://xenarch.dev",
        excluded_paths: set[str] | None = None,
        cache_ttl_s: float = 300.0,
    ) -> None:
        self.app = app
        self.site_token = site_token
        self.api_base = api_base
        self.excluded_paths = excluded_paths or set()
        self.cache_ttl_s = cache_ttl_s
        self._client: XenarchClient | None = None
        # (gate_id, tx_hash) -> verified_at_monotonic. In-process only;
        # publishers running multiple workers each maintain their own
        # cache, which is fine — the platform call is idempotent and
        # cheap on hits.
        self._verify_cache: dict[tuple[str, str], float] = {}

    def _get_client(self) -> XenarchClient:
        """Lazy client creation — only instantiated on first bot detection."""
        if self._client is None:
            self._client = XenarchClient(
                site_token=self.site_token,
                api_base=self.api_base,
            )
        return self._client

    def _cache_hit(self, gate_id: str, tx_hash: str) -> bool:
        key = (gate_id, tx_hash)
        verified_at = self._verify_cache.get(key)
        if verified_at is None:
            return False
        if time.monotonic() - verified_at > self.cache_ttl_s:
            self._verify_cache.pop(key, None)
            return False
        return True

    def _cache_set(self, gate_id: str, tx_hash: str) -> None:
        self._verify_cache[(gate_id, tx_hash)] = time.monotonic()

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path in self.excluded_paths:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        gate_id = headers.get(GATE_ID_HEADER, b"").decode("latin-1").strip()
        tx_hash = headers.get(TX_HASH_HEADER, b"").decode("latin-1").strip()

        if gate_id and tx_hash:
            if self._cache_hit(gate_id, tx_hash):
                await self.app(scope, receive, send)
                return
            try:
                client = self._get_client()
                await client.verify_payment(gate_id, tx_hash)
            except XenarchAPIError as exc:
                logger.info(
                    "Xenarch verification rejected gate_id=%s tx=%s status=%s",
                    gate_id,
                    tx_hash,
                    exc.status_code,
                )
            except Exception:
                logger.warning(
                    "Xenarch verify call failed — falling through to gate",
                    exc_info=True,
                )
            else:
                self._cache_set(gate_id, tx_hash)
                await self.app(scope, receive, send)
                return

        user_agent = headers.get(b"user-agent", b"").decode("latin-1")
        if not is_bot(user_agent):
            await self.app(scope, receive, send)
            return

        # Bot without verified payment — issue a 402 gate.
        try:
            client = self._get_client()
            gate = await client.create_gate(url=path)
            body = json.dumps(gate.model_dump(mode="json", by_alias=True), default=str).encode()
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

"""Agent control plane receipt reporting (XEN-372 — Phase 2 of XEN-370).

After each successful settlement, ``XenarchPayer`` posts the receipt to
the platform's ``/v1/agent/receipts`` endpoint using the operator's
``xa_live_*`` token so the dashboard's receipts feed reflects activity
in seconds.

Design:

* No token → no-op. The SDK stays usable standalone (Phase-1 backwards
  compat).
* In-memory deque retry queue capped at 100 entries. Long-lived
  callers (LangChain agents, MCP servers) survive transient platform
  flakes without losing receipts; on process restart the queue is gone
  — persistence is the caller's job. The CLI does its own JSONL
  persistence; the SDK keeps the surface light.
* Best-effort: failures never raise. The payment itself already
  succeeded; the dashboard write is a side-effect.
"""

from __future__ import annotations

import logging
import os
from collections import deque
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import httpx


logger = logging.getLogger(__name__)

ENV_TOKEN = "XENARCH_API_TOKEN"
QUEUE_CAP = 100
REPORT_TIMEOUT = 5.0


def _resolve_token(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    val = os.environ.get(ENV_TOKEN, "").strip()
    return val or None


class AgentReceiptReporter:
    """Async/sync receipt POST-er with an in-memory retry queue.

    A single instance lives on each ``XenarchPayer`` so concurrent
    payments from one payer share the queue. The class is intentionally
    self-contained (no platform imports) so it can be reused unchanged
    by any caller that wants the same fire-and-forget shape.
    """

    def __init__(
        self,
        api_base: str,
        *,
        token: str | None = None,
        timeout: float = REPORT_TIMEOUT,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.token = _resolve_token(token)
        self.timeout = timeout
        # bounded LIFO-able queue; we always drain oldest-first.
        self._queue: deque[dict[str, Any]] = deque(maxlen=QUEUE_CAP)

    @property
    def enabled(self) -> bool:
        return self.token is not None

    # ------------------------------------------------------------------
    # Sync surface
    # ------------------------------------------------------------------

    def report(self, payload: dict[str, Any]) -> None:
        """Fire-and-forget sync report. Returns immediately; never raises."""
        if not self.enabled:
            return
        try:
            self._queue.append(payload)
            self._drain_sync()
        except Exception:  # noqa: BLE001 — must never propagate
            logger.debug("agent-receipt reporter failed", exc_info=True)

    def _drain_sync(self) -> None:
        # Drain oldest-first. Stop at first transient failure to avoid
        # blocking the caller through a long outage. Terminal failures
        # (4xx) drop the entry — never going to land.
        if not self._queue:
            return
        with httpx.Client(timeout=self.timeout) as client:
            while self._queue:
                entry = self._queue[0]
                terminal, ok = self._post_sync(client, entry)
                if ok or terminal:
                    self._queue.popleft()
                    continue
                # Transient — keep the rest of the queue intact and bail.
                return

    def _post_sync(
        self, client: httpx.Client, payload: dict[str, Any]
    ) -> tuple[bool, bool]:
        """Returns ``(terminal, ok)``."""
        try:
            resp = client.post(
                f"{self.api_base}/v1/agent/receipts",
                headers={
                    "X-Api-Token": self.token or "",
                    "User-Agent": "xenarch-python-sdk",
                },
                json=payload,
            )
        except httpx.HTTPError:
            return False, False
        if resp.is_success:
            return True, True
        if 400 <= resp.status_code < 500:
            logger.debug(
                "agent-receipt dropped (%s): %s",
                resp.status_code,
                resp.text[:200],
            )
            return True, False
        return False, False

    # ------------------------------------------------------------------
    # Async surface
    # ------------------------------------------------------------------

    async def report_async(self, payload: dict[str, Any]) -> None:
        if not self.enabled:
            return
        try:
            self._queue.append(payload)
            await self._drain_async()
        except Exception:  # noqa: BLE001
            logger.debug("agent-receipt reporter failed", exc_info=True)

    async def _drain_async(self) -> None:
        if not self._queue:
            return
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            while self._queue:
                entry = self._queue[0]
                terminal, ok = await self._post_async(client, entry)
                if ok or terminal:
                    self._queue.popleft()
                    continue
                return

    async def _post_async(
        self, client: httpx.AsyncClient, payload: dict[str, Any]
    ) -> tuple[bool, bool]:
        try:
            resp = await client.post(
                f"{self.api_base}/v1/agent/receipts",
                headers={
                    "X-Api-Token": self.token or "",
                    "User-Agent": "xenarch-python-sdk",
                },
                json=payload,
            )
        except httpx.HTTPError:
            return False, False
        if resp.is_success:
            return True, True
        if 400 <= resp.status_code < 500:
            logger.debug(
                "agent-receipt dropped (%s): %s",
                resp.status_code,
                resp.text[:200],
            )
            return True, False
        return False, False


def build_payload(
    *,
    url: str,
    amount_usd: Decimal | str,
    tx_hash: str | None,
    facilitator: str | None,
    status: str = "paid",
    wallet_address: str | None = None,
    source: str = "sdk",
    auth_token: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "url": url,
        "amount_usd": str(amount_usd),
        "source": source,
        "status": status,
        "paid_at": datetime.now(timezone.utc).isoformat(),
        "tx_hash": tx_hash,
        "facilitator": facilitator,
        "wallet_address": wallet_address,
    }
    # XEN-373: optional preflight chain-of-custody. Tools that have a
    # XENARCH_API_TOKEN preflight first and forward the resulting
    # auth_token here so the platform marks the receipt chain-verified.
    if auth_token:
        payload["auth_token"] = auth_token
    return payload

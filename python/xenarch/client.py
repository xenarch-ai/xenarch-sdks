"""Async HTTP client wrapping the Xenarch platform API."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Self

import httpx
from pydantic import BaseModel


class GateResponse(BaseModel):
    """Response from POST /v1/gates (402)."""

    xenarch: bool
    gate_id: uuid.UUID
    price_usd: Decimal
    splitter: str
    collector: str
    network: str
    asset: str
    protocol: str
    verify_url: str
    expires: datetime


class VerifyResponse(BaseModel):
    """Response from POST /v1/gates/{id}/verify."""

    access_token: str
    expires_at: datetime


class GateStatusResponse(BaseModel):
    """Response from GET /v1/gates/{id}."""

    gate_id: uuid.UUID
    status: str
    price_usd: Decimal
    created_at: datetime
    paid_at: datetime | None


class XenarchAPIError(Exception):
    """Raised when the Xenarch API returns an unexpected error."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Xenarch API error {status_code}: {detail}")


class XenarchClient:
    """Async client for the Xenarch payment platform API."""

    def __init__(
        self,
        site_token: str,
        api_base: str = "https://xenarch.bot",
        timeout: float = 10.0,
    ) -> None:
        self._site_token = site_token
        self._api_base = api_base.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=f"{self._api_base}/v1",
            headers={"X-Site-Token": site_token},
            timeout=timeout,
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    async def create_gate(
        self,
        url: str,
        detection_method: str | None = None,
    ) -> GateResponse:
        """Create a payment gate. Returns gate details (expects 402)."""
        body: dict = {"url": url}
        if detection_method is not None:
            body["detection_method"] = detection_method

        resp = await self._client.post("/gates", json=body)

        if resp.status_code == 402:
            return GateResponse.model_validate(resp.json())

        raise XenarchAPIError(resp.status_code, resp.text)

    async def verify_payment(
        self,
        gate_id: uuid.UUID | str,
        tx_hash: str,
    ) -> VerifyResponse:
        """Verify an on-chain payment and get an access token."""
        resp = await self._client.post(
            f"/gates/{gate_id}/verify",
            json={"tx_hash": tx_hash},
        )

        if resp.status_code == 200:
            return VerifyResponse.model_validate(resp.json())

        raise XenarchAPIError(resp.status_code, resp.text)

    async def get_gate(self, gate_id: uuid.UUID | str) -> GateStatusResponse:
        """Get gate status."""
        resp = await self._client.get(f"/gates/{gate_id}")

        if resp.status_code == 200:
            return GateStatusResponse.model_validate(resp.json())

        raise XenarchAPIError(resp.status_code, resp.text)

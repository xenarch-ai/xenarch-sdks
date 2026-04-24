"""Async HTTP client wrapping the Xenarch platform API.

Mirrors `app/schemas/gates.py` on the platform side. Field shapes here
must stay in lockstep with that file — drift will silently break SDK
consumers because the underlying platform now returns the post-XEN-179
no-splitter shape.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Self

import httpx
from pydantic import BaseModel, ConfigDict, Field


class PaymentRequirements(BaseModel):
    """One x402 v1 PaymentRequirements entry inside a 402 response."""

    model_config = ConfigDict(populate_by_name=True)

    scheme: str = "exact"
    network: str = "base"
    max_amount_required: str = Field(alias="maxAmountRequired")
    resource: str
    description: str = ""
    mime_type: str = Field(default="text/html", alias="mimeType")
    pay_to: str = Field(alias="payTo")
    max_timeout_seconds: int = Field(alias="maxTimeoutSeconds")
    asset: str
    extra: dict = Field(default_factory=dict)


class FacilitatorOption(BaseModel):
    """One facilitator the agent may settle through."""

    name: str
    url: str
    spec_version: str = "v2"


class GateResponse(BaseModel):
    """Response from POST /v1/gates (HTTP 402).

    Post-XEN-179: no `splitter`, no `collector`. Payment goes directly
    from the agent's facilitator to ``seller_wallet``. The agent picks a
    facilitator from ``facilitators`` (or its own preference list — see
    ``xenarch.Router``) to settle through.
    """

    x402_version: int = Field(default=1, alias="x402Version")
    accepts: list[PaymentRequirements]
    error: str | None = None

    xenarch: bool = True
    gate_id: uuid.UUID
    price_usd: Decimal
    seller_wallet: str
    network: str
    asset: str = "USDC"
    protocol: str = "x402"
    facilitators: list[FacilitatorOption]
    verify_url: str
    expires: datetime

    model_config = ConfigDict(populate_by_name=True)


class GateStatusResponse(BaseModel):
    """Response from GET /v1/gates/{id}."""

    gate_id: uuid.UUID
    status: str
    price_usd: Decimal
    created_at: datetime
    paid_at: datetime | None = None


class VerifiedPaymentResponse(BaseModel):
    """Response from POST /v1/gates/{id}/verify.

    Post-XEN-179: no access token. The platform returns the verified
    payment record; subsequent gated requests carry ``gate_id`` +
    ``tx_hash`` so the publisher edge can re-verify statelessly.
    """

    gate_id: uuid.UUID
    status: str  # "paid"
    tx_hash: str
    amount_usd: Decimal
    verified_at: datetime


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
        api_base: str = "https://xenarch.dev",
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
        """Create a payment gate. Returns the 402 body parsed as ``GateResponse``."""
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
    ) -> VerifiedPaymentResponse:
        """Re-verify an on-chain payment. Idempotent on the platform side."""
        resp = await self._client.post(
            f"/gates/{gate_id}/verify",
            json={"tx_hash": tx_hash},
        )

        if resp.status_code == 200:
            return VerifiedPaymentResponse.model_validate(resp.json())

        raise XenarchAPIError(resp.status_code, resp.text)

    async def get_gate(self, gate_id: uuid.UUID | str) -> GateStatusResponse:
        """Get gate status."""
        resp = await self._client.get(f"/gates/{gate_id}")

        if resp.status_code == 200:
            return GateStatusResponse.model_validate(resp.json())

        raise XenarchAPIError(resp.status_code, resp.text)

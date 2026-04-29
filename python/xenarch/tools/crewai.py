"""CrewAI ``BaseTool`` adapter for ``XenarchPayer``.

``XenarchCrewaiPay`` is the CrewAI entrypoint for Xenarch's commercial
x402 payer. CrewAI's tool surface is pydantic-based — subclass
``crewai.tools.BaseTool``, set ``name`` / ``description``, implement
``_run`` (sync, abstract) and optionally ``_arun`` (async). The
``args_schema`` is auto-derived from the ``_run`` signature, so a typed
``url: str`` parameter is enough.

Usage::

    pip install xenarch[crewai,x402]

    from xenarch.tools import XenarchCrewaiPay, XenarchBudgetPolicy
    from crewai import Agent
    from decimal import Decimal

    pay = XenarchCrewaiPay(
        private_key="0x...",
        budget_policy=XenarchBudgetPolicy(
            max_per_call=Decimal("0.05"),
            max_per_session=Decimal("1.00"),
        ),
    )
    agent = Agent(role="Researcher", goal="...", tools=[pay])
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from pydantic import Field, PrivateAttr

from xenarch._payer import XenarchPayer

from ._budget import XenarchBudgetPolicy

try:
    from crewai.tools import BaseTool
except ImportError as exc:  # pragma: no cover - import-error path
    raise ImportError(
        "crewai is not installed. Install with: pip install xenarch[crewai]"
    ) from exc


class XenarchCrewaiPay(BaseTool):
    """Pay for x402-gated content. CrewAI-idiomatic wrapper over ``XenarchPayer``."""

    name: str = "xenarch_pay"
    description: str = (
        "Pay for gated content or a service over the x402 protocol. "
        "Fetches the URL, handles any HTTP 402 challenge by signing an "
        "EIP-3009 USDC authorization with the configured wallet, and "
        "returns the unlocked resource body. Input: the URL to retrieve."
    )

    # --- Wallet ---------------------------------------------------------
    private_key: str

    # --- Budget ---------------------------------------------------------
    budget_policy: XenarchBudgetPolicy = Field(default_factory=XenarchBudgetPolicy)

    # --- Facilitator hooks ---------------------------------------------
    facilitator_url: str = Field(default="https://xenarch.dev")
    fetch_receipts: bool | None = Field(default=None)
    verify_receipts: bool = Field(default=True)
    facilitator_public_key_url: str | None = Field(default=None)
    receipts_timeout: float = Field(default=5.0)

    # Opt-in receiver-address gate.
    require_reputation_score: Decimal | None = Field(default=None)
    reputation_timeout: float = Field(default=5.0)

    # --- pay.json pre-discovery ----------------------------------------
    discover_via_pay_json: bool = Field(default=True)
    pay_json_timeout: float = Field(default=5.0)

    # --- HTTP client ----------------------------------------------------
    http_timeout: float = Field(default=10.0)
    max_response_bytes: int = Field(default=1_000_000)

    # --- Internals ------------------------------------------------------
    _payer: Any = PrivateAttr(default=None)

    def model_post_init(self, __context: Any) -> None:
        self._payer = XenarchPayer(
            private_key=self.private_key,
            budget_policy=self.budget_policy,
            facilitator_url=self.facilitator_url,
            fetch_receipts=self.fetch_receipts,
            verify_receipts=self.verify_receipts,
            facilitator_public_key_url=self.facilitator_public_key_url,
            receipts_timeout=self.receipts_timeout,
            require_reputation_score=self.require_reputation_score,
            reputation_timeout=self.reputation_timeout,
            discover_via_pay_json=self.discover_via_pay_json,
            pay_json_timeout=self.pay_json_timeout,
            http_timeout=self.http_timeout,
            max_response_bytes=self.max_response_bytes,
        )

    # ------------------------------------------------------------------
    # CrewAI tool contract.
    # ------------------------------------------------------------------

    def _run(self, url: str) -> str:
        return json.dumps(self._payer.pay(url))

    async def _arun(self, url: str) -> str:
        return json.dumps(await self._payer.pay_async(url))

    # ------------------------------------------------------------------
    # Bypass helper — direct payer access for tests and for callers that
    # share one configured payer across multiple framework adapters.
    # ------------------------------------------------------------------

    async def pay_async(self, url: str) -> dict[str, Any]:
        result: dict[str, Any] = await self._payer.pay_async(url)
        return result

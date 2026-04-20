"""LangChain ``BaseTool`` adapter for ``XenarchPayer``.

``XenarchPay`` is the LangChain entrypoint for Xenarch's commercial x402
payer. All payment logic lives in:

- ``x402_agent.X402Payer`` — the neutral pay loop shared with every
  framework adapter.
- ``xenarch._payer.XenarchPayer`` — ``X402Payer`` plus signed receipts
  and the opt-in reputation gate.

This module stitches those onto LangChain's ``BaseTool`` contract. The tool
returns a JSON string, as LangChain tools do; the underlying payer returns
a dict.

Usage::

    pip install xenarch[langchain,x402]

    from xenarch.tools import XenarchPay, XenarchBudgetPolicy
    from decimal import Decimal

    tool = XenarchPay(
        private_key="0x...",
        budget_policy=XenarchBudgetPolicy(
            max_per_call=Decimal("0.05"),
            max_per_session=Decimal("1.00"),
        ),
    )
    agent = initialize_agent(tools=[tool], llm=llm)
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import Field, PrivateAttr

from xenarch._payer import XenarchPayer

from ._budget import XenarchBudgetPolicy


class XenarchPay(BaseTool):
    """Pay for x402-gated content. LangChain-idiomatic wrapper over ``XenarchPayer``."""

    name: str = "xenarch_pay"
    description: str = (
        "Pay for gated content or a service over the x402 protocol. "
        "Fetches the URL, handles any HTTP 402 challenge by signing an "
        "EIP-3009 USDC authorization with the configured wallet, and "
        "returns the unlocked resource body. Input: the URL to retrieve."
    )

    # --- Wallet ---------------------------------------------------------
    # 0x-prefixed hex private key. Held in pydantic so tool-level repr
    # doesn't leak it (BaseTool's own repr is field-filtered, but
    # downstream tool registries may pickle/log the model; treat this as
    # the caller's responsibility and document it in the README).
    private_key: str

    # --- Budget ---------------------------------------------------------
    budget_policy: XenarchBudgetPolicy = Field(default_factory=XenarchBudgetPolicy)

    # --- Facilitator hooks ---------------------------------------------
    facilitator_url: str = Field(default="https://xenarch.dev")

    # Auto-on for Xenarch-operated facilitators, off for everyone else —
    # protects the vendor-neutral upstream story. Set True explicitly to
    # force fetches against a third-party facilitator that implements the
    # same wire format, or False to skip even on Xenarch hosts.
    fetch_receipts: bool | None = Field(default=None)
    verify_receipts: bool = Field(default=True)
    facilitator_public_key_url: str | None = Field(default=None)
    receipts_timeout: float = Field(default=5.0)

    # Opt-in receiver-address gate. Unknown receivers (404) are treated as
    # 0.0 so the gate fails closed for new publishers rather than throwing.
    require_reputation_score: Decimal | None = Field(default=None)
    reputation_timeout: float = Field(default=5.0)

    # --- pay.json pre-discovery ----------------------------------------
    discover_via_pay_json: bool = Field(default=True)
    pay_json_timeout: float = Field(default=5.0)

    # --- HTTP client ----------------------------------------------------
    http_timeout: float = Field(default=10.0)
    max_response_bytes: int = Field(default=1_000_000)

    # --- Internals ------------------------------------------------------
    # Built in ``model_post_init`` so pydantic entry points that skip
    # ``__init__`` (model_copy, model_validate) still produce a live payer.
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
    # Legacy accessors — pre-refactor call sites (and a few tests) reach
    # into these. Forwarding keeps XEN-148 PR 5x tests passing without
    # changes. Safe to drop once all callers move to ``tool._payer.*``.
    # ------------------------------------------------------------------

    @property
    def _signer_address(self) -> str:
        addr: str = self._payer._signer_address
        return addr

    @property
    def _facilitator_pubkey(self) -> Any:
        return self._payer._facilitator_pubkey

    @_facilitator_pubkey.setter
    def _facilitator_pubkey(self, value: Any) -> None:
        self._payer._facilitator_pubkey = value

    # ------------------------------------------------------------------
    # LangChain tool contract.
    # ------------------------------------------------------------------

    def _run(self, url: str) -> str:
        return json.dumps(self._payer.pay(url))

    async def _arun(self, url: str) -> str:
        return json.dumps(await self._payer.pay_async(url))

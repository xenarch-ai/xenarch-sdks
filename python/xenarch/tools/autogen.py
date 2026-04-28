"""AutoGen v0.4+ ``FunctionTool`` adapter for ``XenarchPayer``.

``XenarchAutogenPay`` is the AutoGen entrypoint for Xenarch's commercial
x402 payer. AutoGen's tool surface differs from LangChain's: rather than
subclassing a ``BaseTool``, AutoGen agents accept any callable wrapped in
``autogen_core.tools.FunctionTool``. This adapter holds a configured
``XenarchPayer`` and exposes a ``.tool`` ``FunctionTool`` that wraps the
async pay loop.

AutoGen's runtime is asyncio-native; we wire ``XenarchPayer.pay_async``
directly into the FunctionTool callable. There is no sync path.

Usage::

    pip install xenarch[autogen,x402]

    from xenarch.tools import XenarchAutogenPay, XenarchBudgetPolicy
    from autogen_agentchat.agents import AssistantAgent
    from decimal import Decimal

    pay = XenarchAutogenPay(
        private_key="0x...",
        budget_policy=XenarchBudgetPolicy(
            max_per_call=Decimal("0.05"),
            max_per_session=Decimal("1.00"),
        ),
    )
    agent = AssistantAgent(
        name="researcher",
        model_client=client,
        tools=[pay.tool],
    )
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from xenarch._payer import XenarchPayer

from ._budget import XenarchBudgetPolicy

try:
    from autogen_core.tools import FunctionTool
except ImportError as exc:  # pragma: no cover - import-error path
    raise ImportError(
        "autogen-core is not installed. Install with: pip install xenarch[autogen]"
    ) from exc


_DEFAULT_DESCRIPTION = (
    "Pay for gated content or a service over the x402 protocol. "
    "Fetches the URL, handles any HTTP 402 challenge by signing an "
    "EIP-3009 USDC authorization with the configured wallet, and "
    "returns the unlocked resource body as a JSON string."
)


class XenarchAutogenPay:
    """AutoGen-idiomatic wrapper over ``XenarchPayer.pay_async``.

    Construct with the same kwargs as ``XenarchPayer``; the wrapped
    ``autogen_core.tools.FunctionTool`` is exposed as ``.tool``.
    """

    def __init__(
        self,
        *,
        private_key: str,
        budget_policy: XenarchBudgetPolicy | None = None,
        facilitator_url: str = "https://xenarch.dev",
        fetch_receipts: bool | None = None,
        verify_receipts: bool = True,
        facilitator_public_key_url: str | None = None,
        receipts_timeout: float = 5.0,
        require_reputation_score: Decimal | None = None,
        reputation_timeout: float = 5.0,
        discover_via_pay_json: bool = True,
        pay_json_timeout: float = 5.0,
        http_timeout: float = 10.0,
        max_response_bytes: int = 1_000_000,
        name: str = "xenarch_pay",
        description: str = _DEFAULT_DESCRIPTION,
    ) -> None:
        self._payer = XenarchPayer(
            private_key=private_key,
            budget_policy=budget_policy or XenarchBudgetPolicy(),
            facilitator_url=facilitator_url,
            fetch_receipts=fetch_receipts,
            verify_receipts=verify_receipts,
            facilitator_public_key_url=facilitator_public_key_url,
            receipts_timeout=receipts_timeout,
            require_reputation_score=require_reputation_score,
            reputation_timeout=reputation_timeout,
            discover_via_pay_json=discover_via_pay_json,
            pay_json_timeout=pay_json_timeout,
            http_timeout=http_timeout,
            max_response_bytes=max_response_bytes,
        )
        self.budget_policy = self._payer.budget_policy
        self._name = name
        self._description = description

        async def xenarch_pay(url: str) -> str:
            """Pay for an x402-gated URL and return the unlocked body."""
            return json.dumps(await self._payer.pay_async(url))

        # FunctionTool derives the JSON schema from the callable signature
        # and docstring. Override the description to match LangChain.
        self.tool: FunctionTool = FunctionTool(
            xenarch_pay, description=description, name=name
        )

    # ------------------------------------------------------------------
    # Convenience: directly invoke the pay loop without going through
    # AutoGen's FunctionTool. Useful for tests and for callers that want
    # to share one configured payer across multiple framework adapters.
    # ------------------------------------------------------------------

    async def pay_async(self, url: str) -> dict[str, Any]:
        result: dict[str, Any] = await self._payer.pay_async(url)
        return result

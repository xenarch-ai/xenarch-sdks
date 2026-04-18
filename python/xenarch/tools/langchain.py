"""LangChain tool wrappers for Xenarch agent payments.

Usage:
    pip install xenarch[langchain,agent]

    from xenarch.tools.langchain import CheckGateTool, PayTool, GetHistoryTool

    tools = [CheckGateTool(), PayTool(), GetHistoryTool()]
    agent = initialize_agent(tools=tools, llm=llm)

    # With budget guardrails:
    tools = [
        CheckGateTool(),
        PayTool(
            max_per_call="0.05",
            max_per_session="1.00",
            human_approval_above="0.20",
            approval_callback=lambda plan: input(f"Approve ${plan['price_usd']}? ") == "y",
        ),
        GetHistoryTool(),
    ]
"""

from __future__ import annotations

import json
import threading
from decimal import Decimal
from typing import Any, Callable

from langchain_core.tools import BaseTool
from pydantic import Field, PrivateAttr

from ..agent_client import (
    GateInfo,
    check_gate,
    check_gate_by_domain,
    get_payment_history,
    verify_payment,
)
from ..payment import execute_payment
from ..wallet import WalletConfig, load_wallet
from ._budget import XenarchBudgetPolicy


def _resolve_gate(url: str, wallet: WalletConfig) -> GateInfo | None:
    """Resolve a gate from a URL or domain."""
    if not url.startswith("http"):
        return check_gate_by_domain(wallet.api_base, url)
    return check_gate(url)


class CheckGateTool(BaseTool):
    """Check if a URL or domain has a Xenarch payment gate."""

    name: str = "xenarch_check_gate"
    description: str = (
        "Check if a URL or domain has a Xenarch payment gate. "
        "Returns pricing and payment details if gated. "
        "Input: a URL (https://example.com/page) or domain (example.com)."
    )

    def _run(self, url: str) -> str:
        try:
            wallet = load_wallet()
            gate = _resolve_gate(url, wallet)
            if not gate:
                return json.dumps({"gated": False, "message": f"No gate found for {url}"})
            return json.dumps(
                {
                    "gated": True,
                    "gate_id": gate.gate_id,
                    "price_usd": gate.price_usd,
                    "splitter": gate.splitter,
                    "collector": gate.collector,
                    "network": gate.network,
                }
            )
        except Exception as e:
            return json.dumps({"error": str(e)})


class PayTool(BaseTool):
    """Pay for gated content via Xenarch USDC micropayment, with budget guardrails."""

    name: str = "xenarch_pay"
    description: str = (
        "Pay for gated content or a service via Xenarch. "
        "Executes a USDC micropayment on Base through the splitter contract. "
        "Input: a URL or domain that has a Xenarch gate."
    )

    # Budget policy — configured at tool init, enforced before every payment.
    # Values as strings/Decimals to avoid float precision issues.
    max_per_call: Decimal = Field(default=Decimal("0.10"))
    max_per_session: Decimal = Field(default=Decimal("5.00"))
    human_approval_above: Decimal | None = None
    approval_callback: Callable[[dict[str, Any]], bool] | None = None

    # Internal policy instance. Shared primitive with XenarchPay (PR 5b+).
    # Constructed in model_post_init so pydantic entry points that skip
    # __init__ (model_copy, model_validate) still get a live policy.
    # Caps captured here are a snapshot: mutating `tool.max_per_call` after
    # construction does NOT re-arm the policy.
    _policy: XenarchBudgetPolicy = PrivateAttr(default=None)  # type: ignore[assignment]

    def model_post_init(self, __context: Any) -> None:
        self._policy = XenarchBudgetPolicy(
            max_per_call=self.max_per_call,
            max_per_session=self.max_per_session,
            human_approval_above=self.human_approval_above,
            approval_callback=self.approval_callback,
        )

    @property
    def session_spent(self) -> Decimal:
        return self._policy.session_spent

    # Back-compat shims for existing tests/callers that poked at the private
    # state directly. New code should use `self._policy`.
    @property
    def _session_spent(self) -> Decimal:
        return self._policy._session_spent

    @_session_spent.setter
    def _session_spent(self, value: Decimal) -> None:
        self._policy._session_spent = value

    @property
    def _spend_lock(self) -> threading.RLock:
        return self._policy.lock()

    def _check_budget(self, price: Decimal) -> dict[str, Any] | None:
        return self._policy.check(price)

    def _requires_approval(self, price: Decimal) -> bool:
        return self._policy.requires_approval(price)

    def _run(self, url: str) -> str:
        try:
            wallet = load_wallet()
            gate = _resolve_gate(url, wallet)
            if not gate:
                return json.dumps({"error": f"No gate found for {url}"})

            price = Decimal(str(gate.price_usd))

            # Hold the lock across check → approval → payment → spend-commit so
            # concurrent calls on the same tool can't both pass a cap check
            # when only one would fit.
            with self._policy.lock():
                budget_error = self._policy.check(price)
                if budget_error is not None:
                    return json.dumps(budget_error)

                plan = {
                    "url": url,
                    "price_usd": str(price),
                    "collector": gate.collector,
                    "splitter": gate.splitter,
                    "gate_id": gate.gate_id,
                }
                approval_error = self._policy.request_approval(plan)
                if approval_error is not None:
                    return json.dumps(approval_error)

                result = execute_payment(
                    wallet=wallet,
                    splitter_address=gate.splitter,
                    collector_address=gate.collector,
                    price_usd=gate.price_usd,
                )

                # Commit the spend the moment USDC leaves the wallet. If
                # verify_payment raises below, the session budget still
                # reflects the real on-chain state — no silent budget drift.
                self._policy.commit(price)

                verification = verify_payment(gate.verify_url, result.tx_hash)

            return json.dumps(
                {
                    "success": True,
                    "tx_hash": result.tx_hash,
                    "block_number": result.block_number,
                    "amount_usd": gate.price_usd,
                    "access_token": verification["access_token"],
                    "expires_at": verification["expires_at"],
                    "session_spent_usd": str(self._policy.session_spent),
                }
            )
        except Exception as e:
            return json.dumps({"error": str(e)})


class GetHistoryTool(BaseTool):
    """View Xenarch payment history for this wallet."""

    name: str = "xenarch_get_history"
    description: str = (
        "View past Xenarch micropayments made by this wallet. "
        "Input: optional domain filter (leave empty for all). "
        "Returns list of payments with amounts and transaction hashes."
    )

    def _run(self, domain: str = "") -> str:
        try:
            wallet = load_wallet()
            history = get_payment_history(
                api_base=wallet.api_base,
                wallet_address=wallet.address,
                domain=domain or None,
            )
            total = sum(float(item.amount_usd) for item in history)
            return json.dumps(
                {
                    "payments": [
                        {
                            "domain": item.domain,
                            "amount_usd": item.amount_usd,
                            "tx_hash": item.tx_hash,
                            "paid_at": item.paid_at,
                        }
                        for item in history
                    ],
                    "total_spent_usd": f"{total:.6f}",
                    "count": len(history),
                }
            )
        except Exception as e:
            return json.dumps({"error": str(e)})

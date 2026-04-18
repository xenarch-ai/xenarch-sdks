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
    check_gate,
    check_gate_by_domain,
    get_payment_history,
    verify_payment,
)
from ..payment import execute_payment
from ..wallet import WalletConfig, load_wallet


def _resolve_gate(url: str, wallet: WalletConfig):
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
    approval_callback: Callable[[dict], bool] | None = None

    # Session state — resets when a new tool instance is created.
    # Lock guards against TOCTOU when the same tool is shared across threads
    # (e.g. concurrent agent runs in a server).
    _session_spent: Decimal = PrivateAttr(default=Decimal("0"))
    _spend_lock: threading.Lock = PrivateAttr(default_factory=threading.Lock)

    @property
    def session_spent(self) -> Decimal:
        with self._spend_lock:
            return self._session_spent

    def _check_budget(self, price: Decimal) -> dict | None:
        """Return an error dict if the payment violates budget policy, else None.

        Caller must hold `_spend_lock` so the check-and-commit on
        `_session_spent` is atomic.
        """
        if price > self.max_per_call:
            return {
                "error": "budget_exceeded",
                "reason": "max_per_call",
                "price_usd": str(price),
                "limit_usd": str(self.max_per_call),
            }
        if self._session_spent + price > self.max_per_session:
            return {
                "error": "budget_exceeded",
                "reason": "max_per_session",
                "session_spent_usd": str(self._session_spent),
                "price_usd": str(price),
                "limit_usd": str(self.max_per_session),
            }
        return None

    def _requires_approval(self, price: Decimal) -> bool:
        return (
            self.human_approval_above is not None
            and price > self.human_approval_above
        )

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
            with self._spend_lock:
                budget_error = self._check_budget(price)
                if budget_error is not None:
                    return json.dumps(budget_error)

                if self._requires_approval(price):
                    if self.approval_callback is None:
                        return json.dumps(
                            {
                                "error": "approval_required",
                                "reason": "no_callback_configured",
                                "price_usd": str(price),
                                "threshold_usd": str(self.human_approval_above),
                            }
                        )
                    plan = {
                        "url": url,
                        "price_usd": str(price),
                        "collector": gate.collector,
                        "splitter": gate.splitter,
                        "gate_id": gate.gate_id,
                    }
                    if not self.approval_callback(plan):
                        return json.dumps(
                            {
                                "status": "declined",
                                "reason": "approval_callback_rejected",
                                "price_usd": str(price),
                            }
                        )

                result = execute_payment(
                    wallet=wallet,
                    splitter_address=gate.splitter,
                    collector_address=gate.collector,
                    price_usd=gate.price_usd,
                )

                verification = verify_payment(gate.verify_url, result.tx_hash)

                self._session_spent += price

            return json.dumps(
                {
                    "success": True,
                    "tx_hash": result.tx_hash,
                    "block_number": result.block_number,
                    "amount_usd": gate.price_usd,
                    "access_token": verification["access_token"],
                    "expires_at": verification["expires_at"],
                    "session_spent_usd": str(self._session_spent),
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

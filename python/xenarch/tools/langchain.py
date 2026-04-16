"""LangChain tool wrappers for Xenarch agent payments.

Usage:
    pip install xenarch[langchain,agent]

    from xenarch.tools.langchain import CheckGateTool, PayTool, GetHistoryTool

    tools = [CheckGateTool(), PayTool(), GetHistoryTool()]
    agent = initialize_agent(tools=tools, llm=llm)
"""

from __future__ import annotations

import json

from langchain_core.tools import BaseTool

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
    """Pay for gated content via Xenarch USDC micropayment."""

    name: str = "xenarch_pay"
    description: str = (
        "Pay for gated content or a service via Xenarch. "
        "Executes a USDC micropayment on Base through the splitter contract. "
        "Input: a URL or domain that has a Xenarch gate."
    )

    def _run(self, url: str) -> str:
        try:
            wallet = load_wallet()
            gate = _resolve_gate(url, wallet)
            if not gate:
                return json.dumps({"error": f"No gate found for {url}"})

            result = execute_payment(
                wallet=wallet,
                splitter_address=gate.splitter,
                collector_address=gate.collector,
                price_usd=gate.price_usd,
            )

            verification = verify_payment(gate.verify_url, result.tx_hash)

            return json.dumps(
                {
                    "success": True,
                    "tx_hash": result.tx_hash,
                    "block_number": result.block_number,
                    "amount_usd": gate.price_usd,
                    "access_token": verification["access_token"],
                    "expires_at": verification["expires_at"],
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

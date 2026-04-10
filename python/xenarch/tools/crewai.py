"""CrewAI tool wrappers for Xenarch agent payments.

Usage:
    pip install xenarch[crewai,agent]

    from xenarch.tools.crewai import check_gate, pay, get_history

    agent = Agent(tools=[check_gate, pay, get_history])
"""

from __future__ import annotations

import json

from crewai.tools import tool

from ..agent_client import (
    check_gate as _check_gate_api,
    check_gate_by_domain,
    get_payment_history,
    verify_payment,
)
from ..payment import execute_payment
from ..wallet import load_wallet


def _resolve_gate(url: str):
    wallet = load_wallet()
    if not url.startswith("http"):
        return check_gate_by_domain(wallet.api_base, url), wallet
    return _check_gate_api(url), wallet


@tool("xenarch_check_gate")
def check_gate(url: str) -> str:
    """Check if a URL or domain has a Xenarch payment gate. Returns pricing and payment details."""
    try:
        gate, wallet = _resolve_gate(url)
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


@tool("xenarch_pay")
def pay(url: str) -> str:
    """Pay for gated content via Xenarch USDC micropayment on Base. Returns transaction hash and access token."""
    try:
        gate, wallet = _resolve_gate(url)
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


@tool("xenarch_get_history")
def get_history(domain: str = "") -> str:
    """View past Xenarch micropayments made by this wallet. Optionally filter by domain."""
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

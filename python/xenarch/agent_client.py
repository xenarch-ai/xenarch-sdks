"""HTTP client for Xenarch platform API — agent-facing endpoints."""

from __future__ import annotations

from dataclasses import dataclass

import httpx


@dataclass
class GateInfo:
    """Gate information returned by the platform."""

    gate_id: str
    price_usd: str
    splitter: str
    collector: str
    network: str
    asset: str
    protocol: str
    verify_url: str


@dataclass
class PaymentHistoryItem:
    """A single payment in the history."""

    url: str
    domain: str
    amount_usd: str
    tx_hash: str
    paid_at: str


USER_AGENT = "xenarch-python/0.1.0"


def check_gate(url: str) -> GateInfo | None:
    """Check if a URL has a Xenarch payment gate (HTTP 402 check)."""
    resp = httpx.get(
        url,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
    )
    if resp.status_code != 402:
        return None
    body = resp.json()
    if not body.get("xenarch"):
        return None
    return GateInfo(
        gate_id=body["gate_id"],
        price_usd=body["price_usd"],
        splitter=body["splitter"],
        collector=body["collector"],
        network=body["network"],
        asset=body["asset"],
        protocol=body["protocol"],
        verify_url=body["verify_url"],
    )


def check_gate_by_domain(api_base: str, domain: str) -> GateInfo | None:
    """Check gate via platform API by domain name."""
    resp = httpx.get(
        f"{api_base}/v1/gates/domain/{domain}",
        headers={"User-Agent": USER_AGENT},
    )
    if resp.status_code != 200:
        return None
    body = resp.json()
    return GateInfo(
        gate_id=body["gate_id"],
        price_usd=body["price_usd"],
        splitter=body["splitter"],
        collector=body["collector"],
        network=body["network"],
        asset=body["asset"],
        protocol=body["protocol"],
        verify_url=body["verify_url"],
    )


def verify_payment(verify_url: str, tx_hash: str) -> dict:
    """Verify payment with platform and get access token."""
    resp = httpx.post(
        verify_url,
        json={"tx_hash": tx_hash},
        headers={"User-Agent": USER_AGENT},
    )
    resp.raise_for_status()
    return resp.json()


def get_payment_history(
    api_base: str,
    wallet_address: str,
    domain: str | None = None,
    limit: int = 10,
) -> list[PaymentHistoryItem]:
    """Get payment history for a wallet."""
    params: dict = {"wallet": wallet_address, "limit": str(limit)}
    if domain:
        params["domain"] = domain
    resp = httpx.get(
        f"{api_base}/v1/payments/history",
        params=params,
        headers={"User-Agent": USER_AGENT},
    )
    resp.raise_for_status()
    return [PaymentHistoryItem(**item) for item in resp.json()]

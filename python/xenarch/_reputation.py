"""Reputation lookup against the Xenarch facilitator.

Thin wrapper over ``GET /v1/reputation/{address}``. Score ranges over
``[0.0, 1.0]`` and is derived from verified-payment history on the
facilitator side (log-scale by payment count). 404 responses mean the
address has no scoreable history yet — we surface that as ``0.0`` so a
``require_reputation_score`` gate treats unknown receivers as untrusted,
not as an error.

Opt-in: ``XenarchPay`` only calls this when ``require_reputation_score``
is set. No background calls, no side effects, no caching beyond the HTTP
layer. Keeps the tool stateless and the facilitator rate-limit happy.
"""

from __future__ import annotations

from decimal import Decimal

import httpx


def fetch_score(
    facilitator_url: str,
    address: str,
    *,
    timeout: float = 5.0,
) -> Decimal:
    """Return the facilitator's reputation score for *address* (0.0 on 404).

    Network failures raise ``httpx.HTTPError`` — callers decide whether to
    fail-closed (refuse to pay) or fail-open. ``XenarchPay`` fails closed.
    """
    resp = httpx.get(
        f"{facilitator_url.rstrip('/')}/v1/reputation/{address}",
        timeout=timeout,
        follow_redirects=False,
    )
    if resp.status_code == 404:
        return Decimal("0")
    resp.raise_for_status()
    return Decimal(str(resp.json()["score"]))


async def fetch_score_async(
    facilitator_url: str,
    address: str,
    *,
    timeout: float = 5.0,
) -> Decimal:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as c:
        resp = await c.get(
            f"{facilitator_url.rstrip('/')}/v1/reputation/{address}"
        )
        if resp.status_code == 404:
            return Decimal("0")
        resp.raise_for_status()
        return Decimal(str(resp.json()["score"]))

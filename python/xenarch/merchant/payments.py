"""Payments received — the merchant side of the ledger."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from xenarch.merchant import MerchantClient


class PaymentsAPI:
    def __init__(self, client: MerchantClient) -> None:
        self._c = client

    def list(
        self, *, limit: int = 25, starting_after: str | None = None
    ) -> dict[str, Any]:
        """List payments received across your links, newest-first.

        Returns ``{payments, has_more, next_cursor}``.
        """
        return self._c._transport.request(
            "GET",
            "/payments/received",
            params={"limit": limit, "starting_after": starting_after},
        )

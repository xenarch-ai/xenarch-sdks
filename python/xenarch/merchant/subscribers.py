"""Subscribers — recurring payers across your subscription links."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from xenarch.merchant import MerchantClient


class SubscribersAPI:
    def __init__(self, client: MerchantClient) -> None:
        self._c = client

    def list(
        self,
        *,
        link_id: str | None = None,
        status: str | None = None,
        mode: str | None = None,
        limit: int = 25,
        starting_after: str | None = None,
    ) -> dict[str, Any]:
        """List subscribers, newest-first. Optional ``link_id`` / ``status`` /
        ``mode`` filters. Returns ``{subscribers, has_more, next_cursor}``.
        """
        return self._c._transport.request(
            "GET",
            "/subscribers",
            params={
                "link_id": link_id,
                "status": status,
                "mode": mode,
                "limit": limit,
                "starting_after": starting_after,
            },
        )

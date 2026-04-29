"""LangGraph node adapter for ``XenarchPayer``.

For LangGraph workflows that pay an x402 gate as part of a graph step,
``XenarchLangGraphPay`` exposes ``.as_node()`` — an async callable that
reads the URL from a configurable state key, settles the 402 via
``XenarchPayer.pay_async``, and writes the result back to another
configurable state key. Wire it into ``StateGraph.add_node``.

For agent-style flows (``langgraph.prebuilt.create_react_agent``), prefer
``xenarch.tools.XenarchPay`` — LangGraph's prebuilt agents accept any
LangChain ``BaseTool`` directly, so a separate LangGraph tool wrapper
would just be duplicate code.

Usage::

    pip install xenarch[langgraph,x402]

    from langgraph.graph import StateGraph
    from xenarch.tools import XenarchBudgetPolicy, XenarchLangGraphPay

    pay = XenarchLangGraphPay(
        private_key="0x...",
        budget_policy=XenarchBudgetPolicy(),
        url_key="article_url",
        result_key="article_payment",
    )
    graph = StateGraph(MyState)
    graph.add_node("pay", pay.as_node())
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from decimal import Decimal
from typing import Any

from xenarch._payer import XenarchPayer

from ._budget import XenarchBudgetPolicy


_DEFAULT_URL_KEY = "url"
_DEFAULT_RESULT_KEY = "payment_result"


class XenarchLangGraphPay:
    """LangGraph-idiomatic wrapper over ``XenarchPayer.pay_async``.

    The adapter is intentionally framework-light: it produces a plain
    async callable suitable for ``StateGraph.add_node`` without depending
    on any specific ``langgraph`` version's typed-state classes. Callers
    who want type-checked state can wrap the returned node themselves.
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
        url_key: str = _DEFAULT_URL_KEY,
        result_key: str = _DEFAULT_RESULT_KEY,
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
        self._url_key = url_key
        self._result_key = result_key

    # ------------------------------------------------------------------
    # Graph integration.
    # ------------------------------------------------------------------

    def as_node(
        self,
    ) -> Callable[[Mapping[str, Any]], Awaitable[dict[str, Any]]]:
        """Return an async node callable for ``StateGraph.add_node``.

        The node reads ``state[url_key]`` (raises ``KeyError`` if absent —
        graph-state typos should be loud, not silent), invokes
        ``XenarchPayer.pay_async``, and returns ``{result_key: <dict>}``
        so LangGraph's reducer merges it into the graph state.
        """
        url_key = self._url_key
        result_key = self._result_key
        payer = self._payer

        async def _node(state: Mapping[str, Any]) -> dict[str, Any]:
            url = state[url_key]
            result = await payer.pay_async(url)
            return {result_key: result}

        return _node

    # ------------------------------------------------------------------
    # Bypass helper — direct payer access for tests and for callers that
    # share one configured payer across multiple framework adapters.
    # ------------------------------------------------------------------

    async def pay_async(self, url: str) -> dict[str, Any]:
        result: dict[str, Any] = await self._payer.pay_async(url)
        return result

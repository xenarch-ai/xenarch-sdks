"""Xenarch agent tools for LangChain, CrewAI, AutoGen, and LangGraph."""

from ._budget import XenarchBudgetPolicy

__all__ = [
    "XenarchBudgetPolicy",
    "XenarchPay",
    "XenarchAutogenPay",
    "XenarchLangGraphPay",
]


def __getattr__(name: str) -> object:
    # Lazy import so the base `xenarch.tools` namespace doesn't pull in
    # `x402` / `eth_account` / framework SDKs. Callers who install the
    # right extra can `from xenarch.tools import X` and get a normal import.
    if name == "XenarchPay":
        from .x402_pay import XenarchPay

        return XenarchPay
    if name == "XenarchAutogenPay":
        from .autogen import XenarchAutogenPay

        return XenarchAutogenPay
    if name == "XenarchLangGraphPay":
        from .langgraph import XenarchLangGraphPay

        return XenarchLangGraphPay
    raise AttributeError(f"module 'xenarch.tools' has no attribute {name!r}")

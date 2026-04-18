"""Xenarch agent tools for LangChain and CrewAI."""

from ._budget import XenarchBudgetPolicy

__all__ = ["XenarchBudgetPolicy", "XenarchPay"]


def __getattr__(name: str) -> object:
    # Lazy import so the base `xenarch.tools` namespace doesn't pull in
    # `x402` / `eth_account`. Callers who install the `[x402]` extra can
    # `from xenarch.tools import XenarchPay` and get a normal import.
    if name == "XenarchPay":
        from .x402_pay import XenarchPay

        return XenarchPay
    raise AttributeError(f"module 'xenarch.tools' has no attribute {name!r}")

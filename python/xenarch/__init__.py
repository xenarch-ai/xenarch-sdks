"""Xenarch Python SDK — pay for and get paid through the agentic internet.

Two sides, one package:

- ``xenarch.x402`` — pay any HTTP 402-gated resource on the open web (pure
  protocol; the seller never has to know about Xenarch).
- ``xenarch.merchant`` — get paid: create and manage pay-links, read payments
  and subscribers, manage your merchant profile.
- ``xenarch.webhooks`` — verify incoming webhook signatures on your backend.

Payments are gasless — the agent wallet only ever holds USDC.
"""

from xenarch.detection import is_bot

__version__ = "1.2.0"


def __getattr__(name: str):
    """Lazy imports for modules with heavy dependencies (fastapi, httpx)."""
    if name in {"x402", "merchant", "webhooks"}:
        import importlib

        return importlib.import_module(f"xenarch.{name}")
    if name == "MerchantClient":
        from xenarch.merchant import MerchantClient
        return MerchantClient
    if name == "XenarchClient":
        from xenarch.client import XenarchClient
        return XenarchClient
    if name == "XenarchAPIError":
        from xenarch.client import XenarchAPIError
        return XenarchAPIError
    if name == "XenarchMiddleware":
        from xenarch.middleware import XenarchMiddleware
        return XenarchMiddleware
    if name == "require_payment":
        from xenarch.decorator import require_payment
        return require_payment
    if name in {
        "Router",
        "FacilitatorConfig",
        "PaymentContext",
        "HealthState",
    }:
        from xenarch import router as _router
        return getattr(_router, name)
    raise AttributeError(f"module 'xenarch' has no attribute {name!r}")


__all__ = [
    "x402",
    "merchant",
    "webhooks",
    "MerchantClient",
    "XenarchClient",
    "XenarchAPIError",
    "XenarchMiddleware",
    "require_payment",
    "is_bot",
    "Router",
    "FacilitatorConfig",
    "PaymentContext",
    "HealthState",
]

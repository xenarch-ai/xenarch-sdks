"""Xenarch Python SDK — payment middleware for AI agents."""

from xenarch.detection import is_bot

__version__ = "0.1.0"


def __getattr__(name: str):
    """Lazy imports for modules with heavy dependencies (fastapi, httpx)."""
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
        "DEFAULT_FACILITATOR_STACK",
    }:
        from xenarch import router as _router
        return getattr(_router, name)
    raise AttributeError(f"module 'xenarch' has no attribute {name!r}")


__all__ = [
    "XenarchClient",
    "XenarchAPIError",
    "XenarchMiddleware",
    "require_payment",
    "is_bot",
    "Router",
    "FacilitatorConfig",
    "PaymentContext",
    "HealthState",
    "DEFAULT_FACILITATOR_STACK",
]

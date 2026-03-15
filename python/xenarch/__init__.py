"""Xenarch Python SDK — payment middleware for AI agents."""

from xenarch.client import XenarchAPIError, XenarchClient
from xenarch.decorator import require_payment
from xenarch.detection import is_bot
from xenarch.middleware import XenarchMiddleware

__version__ = "0.1.0"

__all__ = [
    "XenarchClient",
    "XenarchAPIError",
    "XenarchMiddleware",
    "require_payment",
    "is_bot",
]

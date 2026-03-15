"""@require_payment decorator for selective FastAPI route gating."""

from __future__ import annotations

import functools
import json
import logging
from typing import Any, Callable

from fastapi import Request
from fastapi.responses import JSONResponse

from xenarch.client import XenarchClient
from xenarch.detection import is_bot
from xenarch.token import verify_access_token

logger = logging.getLogger("xenarch.decorator")


def require_payment(
    site_token: str,
    site_id: str,
    access_token_secret: str,
    api_base: str = "https://xenarch.bot",
) -> Callable:
    """Decorator that gates a FastAPI route behind Xenarch payment.

    The decorated function must accept a `request: Request` parameter.

    Usage::

        gate = require_payment(SITE_TOKEN, SITE_ID, SECRET)

        @app.get("/premium")
        @gate
        async def premium(request: Request):
            return {"content": "premium data"}
    """
    client: XenarchClient | None = None

    def _get_client() -> XenarchClient:
        nonlocal client
        if client is None:
            client = XenarchClient(site_token=site_token, api_base=api_base)
        return client

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            request: Request | None = kwargs.get("request")
            if request is None:
                for arg in args:
                    if isinstance(arg, Request):
                        request = arg
                        break

            if request is None:
                return await func(*args, **kwargs)

            auth = request.headers.get("authorization", "")
            if auth.startswith("Bearer "):
                token = auth[7:]
                payload = verify_access_token(
                    token, site_id, access_token_secret
                )
                if payload is not None:
                    return await func(*args, **kwargs)

            user_agent = request.headers.get("user-agent", "")
            if not is_bot(user_agent):
                return await func(*args, **kwargs)

            # Bot without valid token — create gate
            try:
                c = _get_client()
                gate = await c.create_gate(url=str(request.url.path))
                return JSONResponse(
                    status_code=402,
                    content=json.loads(
                        json.dumps(gate.model_dump(mode="json"), default=str)
                    ),
                )
            except Exception:
                logger.warning(
                    "Xenarch API unavailable — passing through bot request",
                    exc_info=True,
                )
                return await func(*args, **kwargs)

        return wrapper

    return decorator

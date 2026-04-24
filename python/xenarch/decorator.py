"""@require_payment decorator for selective FastAPI route gating.

Same verification flow as ``XenarchMiddleware`` (see its docstring for
the full protocol), packaged as a per-route decorator so publishers can
gate selectively without wrapping the whole app.
"""

from __future__ import annotations

import functools
import json
import logging
import time
from typing import Any, Callable

from fastapi import Request
from fastapi.responses import JSONResponse

from xenarch.client import XenarchAPIError, XenarchClient
from xenarch.detection import is_bot

logger = logging.getLogger("xenarch.decorator")

GATE_ID_HEADER = "x-xenarch-gate-id"
TX_HASH_HEADER = "x-xenarch-tx-hash"


def require_payment(
    site_token: str,
    api_base: str = "https://xenarch.dev",
    cache_ttl_s: float = 300.0,
) -> Callable:
    """Decorator that gates a FastAPI route behind Xenarch payment.

    The decorated function must accept a ``request: Request`` parameter.

    Usage::

        gate = require_payment(SITE_TOKEN)

        @app.get("/premium")
        @gate
        async def premium(request: Request):
            return {"content": "premium data"}
    """
    client: XenarchClient | None = None
    verify_cache: dict[tuple[str, str], float] = {}

    def _get_client() -> XenarchClient:
        nonlocal client
        if client is None:
            client = XenarchClient(site_token=site_token, api_base=api_base)
        return client

    def _cache_hit(gate_id: str, tx_hash: str) -> bool:
        key = (gate_id, tx_hash)
        verified_at = verify_cache.get(key)
        if verified_at is None:
            return False
        if time.monotonic() - verified_at > cache_ttl_s:
            verify_cache.pop(key, None)
            return False
        return True

    def _cache_set(gate_id: str, tx_hash: str) -> None:
        verify_cache[(gate_id, tx_hash)] = time.monotonic()

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

            gate_id = request.headers.get(GATE_ID_HEADER, "").strip()
            tx_hash = request.headers.get(TX_HASH_HEADER, "").strip()

            if gate_id and tx_hash:
                if _cache_hit(gate_id, tx_hash):
                    return await func(*args, **kwargs)
                try:
                    c = _get_client()
                    await c.verify_payment(gate_id, tx_hash)
                except XenarchAPIError as exc:
                    logger.info(
                        "Xenarch verification rejected gate_id=%s tx=%s status=%s",
                        gate_id,
                        tx_hash,
                        exc.status_code,
                    )
                except Exception:
                    logger.warning(
                        "Xenarch verify call failed — falling through to gate",
                        exc_info=True,
                    )
                else:
                    _cache_set(gate_id, tx_hash)
                    return await func(*args, **kwargs)

            user_agent = request.headers.get("user-agent", "")
            if not is_bot(user_agent):
                return await func(*args, **kwargs)

            try:
                c = _get_client()
                gate = await c.create_gate(url=str(request.url.path))
                return JSONResponse(
                    status_code=402,
                    content=json.loads(
                        json.dumps(
                            gate.model_dump(mode="json", by_alias=True),
                            default=str,
                        )
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

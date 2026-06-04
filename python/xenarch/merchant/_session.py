"""Authenticated transport for merchant ops.

Reuses the SIWE session the CLI establishes (``xenarch agent login``):
the raw ``xen_session`` cookie, replayed on bare ``/v1/...`` paths. The
platform scopes every merchant route to the wallet behind that session.

``from_config`` reads the same ``~/.xenarch/config.json`` the CLI writes,
so a dev who has already logged in through the CLI gets a ready-to-use
merchant client with no extra setup.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

_SESSION_COOKIE = "xen_session"
_DEFAULT_API_BASE = "https://api.xenarch.dev"
_CONFIG_DIR = Path(os.path.expanduser("~")) / ".xenarch"


class MerchantError(Exception):
    """Base class for merchant-client errors."""


class SessionExpiredError(MerchantError):
    """The SIWE session is missing or expired — re-run ``xenarch agent login``."""


class ConfirmationRequired(MerchantError):
    """A money/irreversible op was called without confirmation.

    Pass ``confirm=True`` on the call, or construct the client with
    ``require_confirm=False`` to opt out for trusted scripts.
    """


class MerchantAPIError(MerchantError):
    """The platform returned an error status."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Xenarch API error {status_code}: {detail}")


class _Transport:
    """Sync HTTP transport that replays the SIWE session cookie."""

    def __init__(
        self,
        *,
        session_token: str,
        api_base: str = _DEFAULT_API_BASE,
        private_key: str | None = None,
        timeout: float = 15.0,
    ) -> None:
        if not session_token:
            raise SessionExpiredError(
                "no session token — log in with `xenarch agent login` first"
            )
        self.session_token = session_token
        self.api_base = api_base.rstrip("/")
        self.private_key = private_key
        self._client = httpx.Client(
            base_url=f"{self.api_base}/v1",
            cookies={_SESSION_COOKIE: session_token},
            timeout=timeout,
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        # Drop None-valued query params so optional filters serialize cleanly.
        clean_params = (
            {k: v for k, v in params.items() if v is not None} if params else None
        )
        resp = self._client.request(
            method,
            path,
            params=clean_params,
            json=json_body,
            headers=extra_headers,
        )
        if resp.status_code == 401:
            raise SessionExpiredError(_error_detail(resp))
        if resp.status_code == 204:
            return None
        if not resp.is_success:
            raise MerchantAPIError(resp.status_code, _error_detail(resp))
        if not resp.content:
            return None
        return resp.json()

    def close(self) -> None:
        self._client.close()


def _error_detail(resp: httpx.Response) -> str:
    """Pull FastAPI's ``detail`` field when present, else the raw body."""
    try:
        body = resp.json()
    except Exception:
        return resp.text
    if isinstance(body, dict) and "detail" in body:
        detail = body["detail"]
        return detail if isinstance(detail, str) else json.dumps(detail)
    return json.dumps(body)


def load_config(config_dir: str | Path | None = None) -> dict[str, Any]:
    """Read ``~/.xenarch/config.json`` (the CLI's config). Empty dict if absent."""
    directory = Path(config_dir) if config_dir else _CONFIG_DIR
    path = directory / "config.json"
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise MerchantError(f"malformed config at {path}: {exc}") from exc

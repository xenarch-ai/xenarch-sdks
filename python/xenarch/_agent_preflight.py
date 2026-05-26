"""Agent control plane preflight (XEN-373 — Phase 3 of XEN-370).

Unlike receipts (best-effort, fire-and-forget), preflight BLOCKS the
pay flow. If the payer was constructed with a control-plane token (or
``XENARCH_API_TOKEN`` is set in the environment), every payment hits
``POST /v1/agent/preflight`` before settlement. The platform returns:

  - ``ok=True`` → ``auth_token`` is forwarded on the receipt POST so the
    platform can mark the receipt chain-verified.
  - ``ok=False`` → the caller refuses with the platform's reason (scope
    rule, kill switch, etc.). Returned as a refusal dict matching the
    existing :class:`XenarchPayer` pre-hook contract.

Fail-closed: if a token is configured but the control plane is
unreachable, the payer refuses. Conservative by design (spec §4.3) — no
operator wants a network blip to bypass their kill switch.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import httpx


logger = logging.getLogger(__name__)

ENV_TOKEN = "XENARCH_API_TOKEN"
PREFLIGHT_TIMEOUT = 5.0


def _resolve_token(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    val = os.environ.get(ENV_TOKEN, "").strip()
    return val or None


@dataclass(frozen=True)
class PreflightDecision:
    """Result the payer hooks consume.

    - ``ok=True`` and ``bypassed=False`` → settle with ``auth_token``.
    - ``ok=True`` and ``bypassed=True``  → no token, settle without
      enforcement (Phase-1 backwards compat).
    - ``ok=False``                       → refuse, surface ``reason``.
    """

    ok: bool
    bypassed: bool = False
    auth_token: str | None = None
    expires_in: int | None = None
    reason: str | None = None
    matched_rule: dict[str, Any] | None = None
    detail: str | None = None


def _refusal_dict(decision: PreflightDecision, url: str) -> dict[str, Any]:
    """Translate a deny ``PreflightDecision`` into the payer's refusal shape."""
    if decision.reason == "scope" and decision.matched_rule:
        return {
            "error": "control_plane_scope_denied",
            "url": url,
            "reason": decision.reason,
            "matched_rule": decision.matched_rule,
            "hint": "Edit rules at https://dash.xenarch.dev/agent/scope",
        }
    if decision.reason == "paused":
        return {
            "error": "control_plane_paused",
            "url": url,
            "reason": "paused",
            "hint": "Toggle the kill switch at https://dash.xenarch.dev/agent/scope",
        }
    if decision.reason == "control_plane_unreachable":
        return {
            "error": "control_plane_unreachable",
            "url": url,
            "detail": decision.detail or "Network error reaching control plane",
        }
    return {
        "error": "control_plane_refused",
        "url": url,
        "reason": decision.reason or "unknown",
    }


class AgentPreflightChecker:
    """Sync + async preflight wrapper for ``XenarchPayer``.

    Persists no state between calls — each preflight is a one-shot
    request/response. The payer caches the returned ``auth_token`` on
    its own instance state and threads it through to the receipt POST.
    """

    def __init__(
        self,
        api_base: str,
        *,
        token: str | None = None,
        timeout: float = PREFLIGHT_TIMEOUT,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.token = _resolve_token(token)
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return self.token is not None

    # ------------------------------------------------------------------
    # Sync
    # ------------------------------------------------------------------

    def check(self, *, url: str, amount_usd: Decimal | str) -> PreflightDecision:
        if not self.enabled:
            return PreflightDecision(ok=True, bypassed=True)
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(
                    f"{self.api_base}/v1/agent/preflight",
                    headers={
                        "X-Api-Token": self.token or "",
                        "User-Agent": "xenarch-python-sdk",
                    },
                    json={"url": url, "amount_usd": str(amount_usd)},
                )
        except httpx.HTTPError as exc:
            logger.debug("preflight http error", exc_info=True)
            return PreflightDecision(
                ok=False,
                reason="control_plane_unreachable",
                detail=str(exc),
            )
        return _parse_response(resp)

    # ------------------------------------------------------------------
    # Async
    # ------------------------------------------------------------------

    async def check_async(
        self, *, url: str, amount_usd: Decimal | str
    ) -> PreflightDecision:
        if not self.enabled:
            return PreflightDecision(ok=True, bypassed=True)
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.api_base}/v1/agent/preflight",
                    headers={
                        "X-Api-Token": self.token or "",
                        "User-Agent": "xenarch-python-sdk",
                    },
                    json={"url": url, "amount_usd": str(amount_usd)},
                )
        except httpx.HTTPError as exc:
            logger.debug("preflight http error", exc_info=True)
            return PreflightDecision(
                ok=False,
                reason="control_plane_unreachable",
                detail=str(exc),
            )
        return _parse_response(resp)


def _parse_response(resp: httpx.Response) -> PreflightDecision:
    if resp.status_code == 401:
        return PreflightDecision(
            ok=False,
            reason="control_plane_unreachable",
            detail="Token rejected — re-issue at https://dash.xenarch.dev/agent/settings",
        )
    if not resp.is_success:
        return PreflightDecision(
            ok=False,
            reason="control_plane_unreachable",
            detail=f"Platform returned HTTP {resp.status_code}",
        )
    try:
        body = resp.json()
    except ValueError:
        return PreflightDecision(
            ok=False,
            reason="control_plane_unreachable",
            detail="Platform returned malformed body",
        )
    if body.get("ok") is True:
        return PreflightDecision(
            ok=True,
            auth_token=body.get("auth_token"),
            expires_in=body.get("expires_in"),
        )
    return PreflightDecision(
        ok=False,
        reason=body.get("reason"),
        matched_rule=body.get("matched_rule"),
    )


def refusal_dict_from_decision(
    decision: PreflightDecision, url: str
) -> dict[str, Any]:
    """Public helper — translate a deny decision to the payer refusal shape."""
    return _refusal_dict(decision, url)

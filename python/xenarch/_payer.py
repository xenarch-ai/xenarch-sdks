"""Xenarch commercial payer — neutral ``X402Payer`` plus our value-adds.

``XenarchPayer`` extends the framework-free ``X402Payer`` with the Xenarch
commercial extras:

- signed Ed25519 receipts fetched from the facilitator after each paid GET;
- opt-in reputation gate for receiver addresses;
- default facilitator URL pointing at ``xenarch.dev``.

It is still plain Python — no LangChain, CrewAI, AutoGen, or LangGraph
coupling. Framework adapters live under ``xenarch.tools.x402_pay`` (LangChain
today; CrewAI / AutoGen / LangGraph flavors planned).
"""

from __future__ import annotations

import asyncio
import base64
import json
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

import httpx

from x402.schemas import PaymentRequirements
from x402_agent import X402Payer
from x402_agent._helpers import X_PAYMENT_RESPONSE_HEADER


class XenarchPayer(X402Payer):
    """``X402Payer`` with Xenarch's receipt + reputation extensions."""

    def __init__(
        self,
        *,
        facilitator_url: str = "https://xenarch.dev",
        fetch_receipts: bool | None = None,
        verify_receipts: bool = True,
        facilitator_public_key_url: str | None = None,
        receipts_timeout: float = 5.0,
        require_reputation_score: Decimal | None = None,
        reputation_timeout: float = 5.0,
        **x402_kwargs: Any,
    ) -> None:
        super().__init__(**x402_kwargs)
        self.facilitator_url = facilitator_url
        self.fetch_receipts = fetch_receipts
        self.verify_receipts = verify_receipts
        self.facilitator_public_key_url = facilitator_public_key_url
        self.receipts_timeout = receipts_timeout
        self.require_reputation_score = require_reputation_score
        self.reputation_timeout = reputation_timeout
        # Per-payer caches: tests that rotate facilitator keys do so by
        # constructing a fresh payer, and production callers can force a
        # refresh the same way.
        self._facilitator_pubkey: Any = None
        # Lazily created in ``_verify_receipt_async`` so it binds to the
        # running loop rather than whichever one happened to be active at
        # payer construction time.
        self._pubkey_lock: Any = None

    # ------------------------------------------------------------------
    # Facilitator helpers.
    # ------------------------------------------------------------------

    def _is_xenarch_facilitator(self) -> bool:
        host = urlparse(self.facilitator_url).hostname or ""
        return host == "xenarch.dev" or host.endswith(".xenarch.dev") or (
            host == "xenarch.com" or host.endswith(".xenarch.com")
        )

    def _should_fetch_receipts(self) -> bool:
        if self.fetch_receipts is not None:
            return self.fetch_receipts
        return self._is_xenarch_facilitator()

    def _public_key_url(self) -> str:
        if self.facilitator_public_key_url:
            return self.facilitator_public_key_url
        return (
            f"{self.facilitator_url.rstrip('/')}"
            "/.well-known/xenarch-facilitator-key.pem"
        )

    def _extract_tx_hash(self, response: httpx.Response) -> str | None:
        """Decode ``X-PAYMENT-RESPONSE`` into the settlement ``transaction``.

        Missing header or garbage payload → None (receipts are best-effort,
        never raise on a paid GET that already succeeded).
        """
        header = response.headers.get(X_PAYMENT_RESPONSE_HEADER)
        if not header:
            return None
        try:
            decoded = json.loads(base64.b64decode(header).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            return None
        tx = decoded.get("transaction")
        return tx if isinstance(tx, str) else None

    # ------------------------------------------------------------------
    # Hooks — wire Xenarch extensions into the neutral pay loop.
    # ------------------------------------------------------------------

    def _pre_payment_hook(
        self,
        *,
        url: str,
        accept: PaymentRequirements,
        price: Decimal,
    ) -> dict[str, Any] | None:
        return self._reputation_gate(accept.pay_to)

    async def _pre_payment_hook_async(
        self,
        *,
        url: str,
        accept: PaymentRequirements,
        price: Decimal,
    ) -> dict[str, Any] | None:
        return await self._reputation_gate_async(accept.pay_to)

    def _post_payment_hook(
        self,
        result: dict[str, Any],
        paid_response: httpx.Response,
    ) -> None:
        self._attach_receipt(result, paid_response)

    async def _post_payment_hook_async(
        self,
        result: dict[str, Any],
        paid_response: httpx.Response,
    ) -> None:
        await self._attach_receipt_async(result, paid_response)

    # ------------------------------------------------------------------
    # Reputation gate.
    # ------------------------------------------------------------------

    def _reputation_gate(self, pay_to: str) -> dict[str, Any] | None:
        if self.require_reputation_score is None:
            return None
        from xenarch import _reputation

        try:
            score = _reputation.fetch_score(
                self.facilitator_url,
                pay_to,
                timeout=self.reputation_timeout,
            )
        except httpx.HTTPError as exc:
            # Fail closed on transport errors — the gate exists precisely
            # to protect against paying unknown/untrusted receivers.
            return {
                "error": "reputation_lookup_failed",
                "pay_to": pay_to,
                "details": str(exc),
            }
        if score < self.require_reputation_score:
            return {
                "error": "reputation_below_threshold",
                "pay_to": pay_to,
                "score": str(score),
                "required": str(self.require_reputation_score),
            }
        return None

    async def _reputation_gate_async(
        self, pay_to: str
    ) -> dict[str, Any] | None:
        if self.require_reputation_score is None:
            return None
        from xenarch import _reputation

        try:
            score = await _reputation.fetch_score_async(
                self.facilitator_url,
                pay_to,
                timeout=self.reputation_timeout,
            )
        except httpx.HTTPError as exc:
            return {
                "error": "reputation_lookup_failed",
                "pay_to": pay_to,
                "details": str(exc),
            }
        if score < self.require_reputation_score:
            return {
                "error": "reputation_below_threshold",
                "pay_to": pay_to,
                "score": str(score),
                "required": str(self.require_reputation_score),
            }
        return None

    # ------------------------------------------------------------------
    # Receipt fetch + verify.
    # ------------------------------------------------------------------

    def _attach_receipt(
        self,
        response_dict: dict[str, Any],
        paid_response: httpx.Response,
    ) -> None:
        """Mutate *response_dict* in place to add receipt + verification.

        Best-effort: receipt fetch failures degrade the success response
        (add ``receipt_error``) but never turn a paid GET into a failure,
        because the spend has already been committed on the budget.
        """
        if not self._should_fetch_receipts():
            return
        tx_hash = self._extract_tx_hash(paid_response)
        if not tx_hash:
            response_dict["receipt_error"] = "no_tx_hash_in_payment_response"
            return
        from xenarch import _receipts

        try:
            receipt = _receipts.fetch_receipt(
                self.facilitator_url,
                tx_hash,
                timeout=self.receipts_timeout,
            )
        except httpx.HTTPError as exc:
            response_dict["receipt_error"] = f"fetch_failed: {exc}"
            return
        if receipt is None:
            response_dict["receipt_error"] = "receipt_not_found"
            return
        response_dict["receipt"] = receipt
        if self.verify_receipts:
            response_dict["signature_verified"] = self._verify_receipt(
                receipt
            )

    async def _attach_receipt_async(
        self,
        response_dict: dict[str, Any],
        paid_response: httpx.Response,
    ) -> None:
        if not self._should_fetch_receipts():
            return
        tx_hash = self._extract_tx_hash(paid_response)
        if not tx_hash:
            response_dict["receipt_error"] = "no_tx_hash_in_payment_response"
            return
        from xenarch import _receipts

        try:
            receipt = await _receipts.fetch_receipt_async(
                self.facilitator_url,
                tx_hash,
                timeout=self.receipts_timeout,
            )
        except httpx.HTTPError as exc:
            response_dict["receipt_error"] = f"fetch_failed: {exc}"
            return
        if receipt is None:
            response_dict["receipt_error"] = "receipt_not_found"
            return
        response_dict["receipt"] = receipt
        if self.verify_receipts:
            response_dict["signature_verified"] = (
                await self._verify_receipt_async(receipt)
            )

    def _verify_receipt(self, receipt: dict[str, Any]) -> bool:
        from xenarch import _receipts

        if self._facilitator_pubkey is None:
            try:
                self._facilitator_pubkey = _receipts.fetch_public_key(
                    self._public_key_url(),
                    timeout=self.receipts_timeout,
                )
            except (httpx.HTTPError, ValueError):
                return False
        return _receipts.verify_signature(self._facilitator_pubkey, receipt)

    async def _verify_receipt_async(self, receipt: dict[str, Any]) -> bool:
        from xenarch import _receipts

        if self._facilitator_pubkey is None:
            if self._pubkey_lock is None:
                self._pubkey_lock = asyncio.Lock()
            async with self._pubkey_lock:
                # Re-check under the lock — another coroutine may have
                # populated the cache while we were waiting.
                if self._facilitator_pubkey is None:
                    try:
                        self._facilitator_pubkey = (
                            await _receipts.fetch_public_key_async(
                                self._public_key_url(),
                                timeout=self.receipts_timeout,
                            )
                        )
                    except (httpx.HTTPError, ValueError):
                        return False
        return _receipts.verify_signature(self._facilitator_pubkey, receipt)

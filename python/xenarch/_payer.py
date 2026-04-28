"""Xenarch commercial payer — neutral ``X402Payer`` plus our value-adds.

``XenarchPayer`` extends the framework-free ``X402Payer`` with the Xenarch
commercial extras:

- signed Ed25519 receipts fetched from the facilitator after each paid GET
  (legacy V1 path against ``xenarch.dev``);
- opt-in reputation gate for receiver addresses;
- post-XEN-179 V2 flow: when the resource server returns a Xenarch envelope
  (``xenarch: true`` + ``gate_id`` + ``facilitators[]``), settle directly
  through a third-party x402 facilitator chosen by ``Router.select()``,
  then replay the URL with ``X-Xenarch-Gate-Id`` + ``X-Xenarch-Tx-Hash``
  so the publisher's middleware can stateless-verify.

It is still plain Python — no LangChain, CrewAI, AutoGen, or LangGraph
coupling. Framework adapters live under ``xenarch.tools.x402_pay`` (LangChain
today; CrewAI / AutoGen / LangGraph flavors planned).
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

import httpx

# x402 stack is an optional dep delivered by the [x402] extra (which the
# framework extras transitively include). Re-raise as a clear install
# hint so callers who reach this module without the extra get an
# actionable error instead of a raw ModuleNotFoundError.
try:
    from x402_agent import X402Payer
    from x402_agent._helpers import (
        AnyPaymentRequirements,
        X_PAYMENT_HEADER,
        X_PAYMENT_RESPONSE_HEADER,
        encode_payment_header,
        is_public_host,
        is_public_host_async,
        price_usd,
        select_accept,
        truncate_body,
    )
    from x402.schemas import parse_payment_required
except ImportError as exc:  # pragma: no cover - install-error path
    raise ImportError(
        "xenarch.XenarchPayer requires the x402 extra. Install with: "
        "pip install 'xenarch[x402]' (or use a framework extra like "
        "'xenarch[langchain]' / 'xenarch[autogen]' which transitively "
        "include it)."
    ) from exc

from xenarch.client import GateResponse
from xenarch.router import FacilitatorConfig, PaymentContext, Router

# Canonical Xenarch replay headers. Lowercase comparison only — httpx
# normalises header casing and the publisher middleware reads them
# lowercase too (see ``xenarch/middleware.py``).
GATE_ID_HEADER = "X-Xenarch-Gate-Id"
TX_HASH_HEADER = "X-Xenarch-Tx-Hash"


def _is_xenarch_envelope(body: bytes) -> dict[str, Any] | None:
    """Return parsed body iff it carries the Xenarch V2 envelope, else None.

    Used to disambiguate post-XEN-179 Xenarch-issued 402s (route via
    third-party facilitator + replay with gate headers) from generic
    x402 402s (legacy V1 path: settle with ``X-PAYMENT`` against the
    resource server).
    """
    try:
        data = json.loads(body)
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get("xenarch") is not True:
        return None
    if "gate_id" not in data or "facilitators" not in data:
        return None
    return data


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
        router: Router | None = None,
        facilitator_settle_timeout: float = 30.0,
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
        self.facilitator_settle_timeout = facilitator_settle_timeout
        # Per-payer caches: tests that rotate facilitator keys do so by
        # constructing a fresh payer, and production callers can force a
        # refresh the same way.
        self._facilitator_pubkey: Any = None
        # Lazily created in ``_verify_receipt_async`` so it binds to the
        # running loop rather than whichever one happened to be active at
        # payer construction time.
        self._pubkey_lock: Any = None
        # Caller may inject a Router (e.g. with custom weights or a
        # pre-warmed health window). Otherwise we lazy-build one whose
        # registered stack mirrors the publisher's facilitators[] — the
        # safest default since we won't make outbound calls to URLs
        # outside the publisher's own advertised list.
        self._router: Router | None = router

    # ------------------------------------------------------------------
    # Public entry points — V2-aware overrides.
    # ------------------------------------------------------------------

    def pay(self, url: str) -> dict[str, Any]:
        """Pay for ``url``. V2-aware: detects Xenarch envelope and routes
        via a third-party facilitator instead of the V1 ``X-PAYMENT`` flow.
        """
        try:
            hostname = urlparse(url).hostname or ""
            if not is_public_host(hostname):
                return {"error": "unsafe_host", "host": hostname}

            pre_check = self._pay_json_pre_check(url)
            if pre_check is not None:
                return pre_check

            with httpx.Client(timeout=self.http_timeout) as client:
                initial = client.get(url)

                if initial.status_code != 402:
                    return {
                        "status": "no_payment_required",
                        "url": url,
                        "http_status": initial.status_code,
                        "body": truncate_body(
                            initial.text, self.max_response_bytes
                        ),
                    }

                envelope = _is_xenarch_envelope(initial.content)
                if envelope is None:
                    # Not a Xenarch V2 gate — settle inline using the V1
                    # X-PAYMENT flow against the resource server. Inlined
                    # rather than calling super().pay() to avoid a second
                    # GET (existing V1 tests count requests strictly).
                    return self._pay_v1_inline(client, url, initial)

                return self._pay_xenarch_v2(client, url, initial, envelope)
        except httpx.HTTPError as exc:
            return {"error": "http_error", "kind": type(exc).__name__}
        except Exception as exc:  # noqa: BLE001 — payer contract is a dict
            return {"error": "unexpected_error", "kind": type(exc).__name__}

    async def pay_async(self, url: str) -> dict[str, Any]:
        try:
            hostname = urlparse(url).hostname or ""
            if not await is_public_host_async(hostname):
                return {"error": "unsafe_host", "host": hostname}

            pre_check = await asyncio.to_thread(self._pay_json_pre_check, url)
            if pre_check is not None:
                return pre_check

            async with httpx.AsyncClient(timeout=self.http_timeout) as client:
                initial = await client.get(url)

                if initial.status_code != 402:
                    return {
                        "status": "no_payment_required",
                        "url": url,
                        "http_status": initial.status_code,
                        "body": truncate_body(
                            initial.text, self.max_response_bytes
                        ),
                    }

                envelope = _is_xenarch_envelope(initial.content)
                if envelope is None:
                    return await self._pay_v1_inline_async(
                        client, url, initial
                    )

                return await self._pay_xenarch_v2_async(
                    client, url, initial, envelope
                )
        except httpx.HTTPError as exc:
            return {"error": "http_error", "kind": type(exc).__name__}
        except Exception as exc:  # noqa: BLE001
            return {"error": "unexpected_error", "kind": type(exc).__name__}

    # ------------------------------------------------------------------
    # V1 flow inlined against an already-fetched 402.
    # Mirrors ``X402Payer.pay()`` lines 264-328 byte-for-byte, just with
    # the initial GET hoisted out so we don't re-fetch the publisher
    # after the envelope sniff.
    # ------------------------------------------------------------------

    def _pay_v1_inline(
        self,
        client: httpx.Client,
        url: str,
        initial: httpx.Response,
    ) -> dict[str, Any]:
        payment_required = self._parse_402(initial)
        if payment_required is None:
            return {
                "error": "x402_parse_failed",
                "url": url,
                "body": truncate_body(initial.text, 500),
            }

        accept = select_accept(payment_required)
        if accept is None:
            return {
                "error": "no_supported_scheme",
                "url": url,
                "accepts": [
                    {"scheme": a.scheme, "network": a.network}
                    for a in payment_required.accepts
                ],
            }

        price = price_usd(accept)

        pre_hook = self._pre_payment_hook(
            url=url, accept=accept, price=price
        )
        if pre_hook is not None:
            return pre_hook

        with self.budget_policy.lock():
            gate_error = self._budget_gate(
                url=url, accept=accept, price=price
            )
            if gate_error is not None:
                return gate_error

            payload = self._x402_sync.create_payment_payload(payment_required)
            header_value = encode_payment_header(payload)

            paid = client.get(
                url, headers={X_PAYMENT_HEADER: header_value}
            )

            if paid.status_code != 200:
                return {
                    "error": "x402_retry_failed",
                    "url": url,
                    "http_status": paid.status_code,
                    "body": truncate_body(paid.text, 500),
                }

            self.budget_policy.commit(price)

            result = self._success_response(
                url=url, response=paid, accept=accept, price=price
            )
            self._post_payment_hook(result, paid)
            return result

    async def _pay_v1_inline_async(
        self,
        client: httpx.AsyncClient,
        url: str,
        initial: httpx.Response,
    ) -> dict[str, Any]:
        payment_required = self._parse_402(initial)
        if payment_required is None:
            return {
                "error": "x402_parse_failed",
                "url": url,
                "body": truncate_body(initial.text, 500),
            }

        accept = select_accept(payment_required)
        if accept is None:
            return {
                "error": "no_supported_scheme",
                "url": url,
                "accepts": [
                    {"scheme": a.scheme, "network": a.network}
                    for a in payment_required.accepts
                ],
            }

        price = price_usd(accept)

        pre_hook = await self._pre_payment_hook_async(
            url=url, accept=accept, price=price
        )
        if pre_hook is not None:
            return pre_hook

        with self.budget_policy.lock():
            gate_error = self._budget_gate(
                url=url, accept=accept, price=price
            )
            if gate_error is not None:
                return gate_error

            payload = await self._x402_async.create_payment_payload(
                payment_required
            )
            header_value = encode_payment_header(payload)

            paid = await client.get(
                url, headers={X_PAYMENT_HEADER: header_value}
            )

            if paid.status_code != 200:
                return {
                    "error": "x402_retry_failed",
                    "url": url,
                    "http_status": paid.status_code,
                    "body": truncate_body(paid.text, 500),
                }

            self.budget_policy.commit(price)

            result = self._success_response(
                url=url, response=paid, accept=accept, price=price
            )
            await self._post_payment_hook_async(result, paid)
            return result

    # ------------------------------------------------------------------
    # V2 flow (post-XEN-179: route → settle → replay).
    # ------------------------------------------------------------------

    def _ensure_router(self, gate: GateResponse) -> Router:
        """Return the configured Router, lazy-building from gate.facilitators.

        Lazy-building from the publisher's advertised list is the safest
        default: ``Router.select`` only ever returns URLs from its own
        registered stack, so we won't accidentally settle through an
        attacker-controlled URL just because it appeared in pay.json or
        a 402 body.
        """
        if self._router is not None:
            return self._router
        configs = [
            FacilitatorConfig(
                name=f.name, url=f.url, spec_version=f.spec_version
            )
            for f in gate.facilitators
        ]
        # ``Router(facilitators=[])`` raises; we let that propagate so the
        # caller sees a clean error rather than mysterious empty selects.
        self._router = Router(facilitators=configs)
        return self._router

    def _build_settle_body(
        self,
        *,
        payment_required: Any,
        payload: Any,
        accept: AnyPaymentRequirements,
    ) -> dict[str, Any]:
        """Marshal the body for POST {facilitator}/settle.

        ``paymentPayload`` is the EIP-3009 transferWithAuthorization
        payload returned by ``x402Client.create_payment_payload`` — same
        object the V1 ``X-PAYMENT`` header carries, just sent JSON-mode
        to the facilitator instead of base64-encoded to the resource
        server.
        """
        return {
            "x402Version": payment_required.x402_version,
            "paymentPayload": payload.model_dump(
                by_alias=True, mode="json", exclude_none=True
            ),
            "paymentRequirements": accept.model_dump(
                by_alias=True, mode="json", exclude_none=True
            ),
        }

    def _v2_success_dict(
        self,
        *,
        url: str,
        accept: AnyPaymentRequirements,
        price: Decimal,
        retry_response: httpx.Response,
        gate: GateResponse,
        tx_hash: str,
        facilitator_url: str,
    ) -> dict[str, Any]:
        return {
            "success": True,
            "url": url,
            "amount_usd": str(price),
            "pay_to": accept.pay_to,
            "asset": accept.asset,
            "network": accept.network,
            "body": truncate_body(
                retry_response.text, self.max_response_bytes
            ),
            "session_spent_usd": str(self.budget_policy.session_spent),
            "tx_hash": tx_hash,
            "facilitator": facilitator_url,
            "gate_id": str(gate.gate_id),
        }

    def _pay_xenarch_v2(
        self,
        client: httpx.Client,
        url: str,
        initial: httpx.Response,
        envelope: dict[str, Any],
    ) -> dict[str, Any]:
        gate = GateResponse.model_validate(envelope)

        payment_required = parse_payment_required(initial.content)
        accept = select_accept(payment_required)
        if accept is None:
            return {
                "error": "no_supported_scheme",
                "url": url,
                "accepts": [
                    {"scheme": a.scheme, "network": a.network}
                    for a in payment_required.accepts
                ],
            }

        price = price_usd(accept)

        pre_hook = self._pre_payment_hook(
            url=url, accept=accept, price=price
        )
        if pre_hook is not None:
            return pre_hook

        with self.budget_policy.lock():
            gate_error = self._budget_gate(
                url=url, accept=accept, price=price
            )
            if gate_error is not None:
                return gate_error

            router = self._ensure_router(gate)
            # Route on the *gate-level* network + asset (e.g. ``base`` /
            # ``USDC``), not on the per-accept fields. ``accept.asset``
            # is the on-chain ERC-20 contract address — comparing that
            # to ``Router``'s symbolic ``supported_assets`` would never
            # match.
            candidates = router.select(
                ctx=PaymentContext(
                    chain=gate.network, asset=gate.asset, amount_usd=price
                ),
                publisher_facilitators=[f.url for f in gate.facilitators],
            )
            if not candidates:
                return {
                    "error": "no_facilitator_settled",
                    "url": url,
                    "tried": [],
                    "reason": "no_supported_facilitator",
                }

            payload = self._x402_sync.create_payment_payload(payment_required)
            settle_body = self._build_settle_body(
                payment_required=payment_required,
                payload=payload,
                accept=accept,
            )

            tried: list[str] = []
            tx_hash: str | None = None
            chosen: FacilitatorConfig | None = None

            for facilitator in candidates:
                tried.append(facilitator.url)
                t0 = time.monotonic()
                try:
                    settle_resp = client.post(
                        f"{facilitator.url.rstrip('/')}/settle",
                        json=settle_body,
                        timeout=self.facilitator_settle_timeout,
                    )
                except httpx.HTTPError:
                    router.record_failure(facilitator.url)
                    continue

                if settle_resp.status_code != 200:
                    router.record_failure(facilitator.url)
                    continue
                try:
                    settle_json = settle_resp.json()
                except (ValueError, json.JSONDecodeError):
                    router.record_failure(facilitator.url)
                    continue
                if not settle_json.get("success"):
                    router.record_failure(facilitator.url)
                    continue
                tx = settle_json.get("transaction")
                if not isinstance(tx, str) or not tx:
                    router.record_failure(facilitator.url)
                    continue

                latency_ms = (time.monotonic() - t0) * 1000.0
                router.record_success(facilitator.url, latency_ms=latency_ms)
                tx_hash = tx
                chosen = facilitator
                break

            if tx_hash is None or chosen is None:
                return {
                    "error": "no_facilitator_settled",
                    "url": url,
                    "tried": tried,
                }

            retry = client.get(
                url,
                headers={
                    GATE_ID_HEADER: str(gate.gate_id),
                    TX_HASH_HEADER: tx_hash,
                },
            )

            if retry.status_code != 200:
                # The on-chain tx already happened; surface enough state
                # for the caller to manually claim the content rather
                # than silently eating the spend.
                return {
                    "error": "xenarch_replay_failed",
                    "url": url,
                    "http_status": retry.status_code,
                    "tx_hash": tx_hash,
                    "facilitator": chosen.url,
                    "gate_id": str(gate.gate_id),
                    "body": truncate_body(retry.text, 500),
                }

            self.budget_policy.commit(price)
            # Skip _post_payment_hook in the V2 path — it's a V1 receipt
            # mechanism that reads X-PAYMENT-RESPONSE, which a Xenarch
            # replay never carries. We have the tx hash directly already.
            return self._v2_success_dict(
                url=url,
                accept=accept,
                price=price,
                retry_response=retry,
                gate=gate,
                tx_hash=tx_hash,
                facilitator_url=chosen.url,
            )

    async def _pay_xenarch_v2_async(
        self,
        client: httpx.AsyncClient,
        url: str,
        initial: httpx.Response,
        envelope: dict[str, Any],
    ) -> dict[str, Any]:
        gate = GateResponse.model_validate(envelope)

        payment_required = parse_payment_required(initial.content)
        accept = select_accept(payment_required)
        if accept is None:
            return {
                "error": "no_supported_scheme",
                "url": url,
                "accepts": [
                    {"scheme": a.scheme, "network": a.network}
                    for a in payment_required.accepts
                ],
            }

        price = price_usd(accept)

        pre_hook = await self._pre_payment_hook_async(
            url=url, accept=accept, price=price
        )
        if pre_hook is not None:
            return pre_hook

        with self.budget_policy.lock():
            gate_error = self._budget_gate(
                url=url, accept=accept, price=price
            )
            if gate_error is not None:
                return gate_error

            router = self._ensure_router(gate)
            # Route on the *gate-level* network + asset (e.g. ``base`` /
            # ``USDC``), not on the per-accept fields. ``accept.asset``
            # is the on-chain ERC-20 contract address — comparing that
            # to ``Router``'s symbolic ``supported_assets`` would never
            # match.
            candidates = router.select(
                ctx=PaymentContext(
                    chain=gate.network, asset=gate.asset, amount_usd=price
                ),
                publisher_facilitators=[f.url for f in gate.facilitators],
            )
            if not candidates:
                return {
                    "error": "no_facilitator_settled",
                    "url": url,
                    "tried": [],
                    "reason": "no_supported_facilitator",
                }

            payload = await self._x402_async.create_payment_payload(
                payment_required
            )
            settle_body = self._build_settle_body(
                payment_required=payment_required,
                payload=payload,
                accept=accept,
            )

            tried: list[str] = []
            tx_hash: str | None = None
            chosen: FacilitatorConfig | None = None

            for facilitator in candidates:
                tried.append(facilitator.url)
                t0 = time.monotonic()
                try:
                    settle_resp = await client.post(
                        f"{facilitator.url.rstrip('/')}/settle",
                        json=settle_body,
                        timeout=self.facilitator_settle_timeout,
                    )
                except httpx.HTTPError:
                    router.record_failure(facilitator.url)
                    continue

                if settle_resp.status_code != 200:
                    router.record_failure(facilitator.url)
                    continue
                try:
                    settle_json = settle_resp.json()
                except (ValueError, json.JSONDecodeError):
                    router.record_failure(facilitator.url)
                    continue
                if not settle_json.get("success"):
                    router.record_failure(facilitator.url)
                    continue
                tx = settle_json.get("transaction")
                if not isinstance(tx, str) or not tx:
                    router.record_failure(facilitator.url)
                    continue

                latency_ms = (time.monotonic() - t0) * 1000.0
                router.record_success(facilitator.url, latency_ms=latency_ms)
                tx_hash = tx
                chosen = facilitator
                break

            if tx_hash is None or chosen is None:
                return {
                    "error": "no_facilitator_settled",
                    "url": url,
                    "tried": tried,
                }

            retry = await client.get(
                url,
                headers={
                    GATE_ID_HEADER: str(gate.gate_id),
                    TX_HASH_HEADER: tx_hash,
                },
            )

            if retry.status_code != 200:
                return {
                    "error": "xenarch_replay_failed",
                    "url": url,
                    "http_status": retry.status_code,
                    "tx_hash": tx_hash,
                    "facilitator": chosen.url,
                    "gate_id": str(gate.gate_id),
                    "body": truncate_body(retry.text, 500),
                }

            self.budget_policy.commit(price)
            return self._v2_success_dict(
                url=url,
                accept=accept,
                price=price,
                retry_response=retry,
                gate=gate,
                tx_hash=tx_hash,
                facilitator_url=chosen.url,
            )

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
        accept: AnyPaymentRequirements,
        price: Decimal,
    ) -> dict[str, Any] | None:
        return self._reputation_gate(accept.pay_to)

    async def _pre_payment_hook_async(
        self,
        *,
        url: str,
        accept: AnyPaymentRequirements,
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

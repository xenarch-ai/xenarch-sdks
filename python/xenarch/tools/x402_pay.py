"""Vendor-neutral x402 payment tool for LangChain agents.

``XenarchPay`` speaks the public x402 protocol (HTTP 402 + EIP-3009 USDC on
Base) via the official ``x402`` PyPI SDK. It is not tied to the Xenarch
facilitator — the default ``facilitator_url`` points at ``xenarch.dev`` but
the payment path works against any spec-compliant x402 resource server.

Flow per call:

  1. GET the resource.
  2. If the response is not 402, return the body (resource is free).
  3. Parse the 402 body into ``PaymentRequired`` via the x402 SDK.
  4. Select the first ``scheme=="exact"`` accept entry whose network matches
     a scheme registered on the SDK client (the tool pre-registers the
     EVM-exact scheme for EIP-3009 USDC).
  5. Convert the atomic ``amount`` to a ``Decimal`` USD price using the
     asset's ``decimals`` (6 for USDC).
  6. Under ``budget_policy.lock()``: budget check → optional approval →
     ``create_payment_payload`` → retry the GET with ``X-PAYMENT`` → commit
     the session spend BEFORE post-payment work (so a later failure cannot
     silently re-open the budget).
  7. Return a JSON string with the body and transaction metadata.

Receipt fetch + verification, pay.json pre-discovery, and the reputation gate
are intentionally not implemented here — they ship in subsequent PRs on top
of this scaffold.

Usage::

    pip install xenarch[langchain,x402]

    from xenarch.tools import XenarchPay, XenarchBudgetPolicy
    from decimal import Decimal

    tool = XenarchPay(
        private_key="0x...",
        budget_policy=XenarchBudgetPolicy(
            max_per_call=Decimal("0.05"),
            max_per_session=Decimal("1.00"),
        ),
    )
    agent = initialize_agent(tools=[tool], llm=llm)
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

import httpx
from langchain_core.tools import BaseTool
from pydantic import Field, PrivateAttr

from ._budget import XenarchBudgetPolicy

# The x402 SDK ships its own sync + async clients; we hold one of each so
# `_run` and `_arun` never collide on a single event-loop-bound instance.
from x402.client import x402Client, x402ClientSync
from x402.mechanisms.evm.constants import DEFAULT_DECIMALS
from x402.mechanisms.evm.exact import register_exact_evm_client
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.schemas import PaymentRequired, PaymentRequirements, parse_payment_required

# USDC atomic-unit conversion. The x402 server advertises `amount` as an
# integer string in the asset's smallest unit; for USDC that is 6 decimals.
# The authoritative value can live in `requirements.extra["decimals"]` — we
# honour that when present and fall back to the EVM-default (6) otherwise.
_X_PAYMENT_HEADER = "X-PAYMENT"
_X_PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE"

# Default preferred network — CAIP-2 chain ID for Base (8453). The x402 v2
# spec identifies networks with CAIP-2 identifiers and the SDK registers an
# `eip155:*` wildcard, so any EVM chain with that prefix is payable. We
# prefer Base explicitly but fall back to any CAIP-2 eip155 entry so a
# resource server advertising `eip155:1` (Ethereum) still works out of the
# box. Non-CAIP-2 legacy strings like `"base"` are V1 and not handled here.
_DEFAULT_NETWORK = "eip155:8453"
_DEFAULT_SCHEME = "exact"
_EIP155_PREFIX = "eip155:"


def _price_usd(req: PaymentRequirements) -> Decimal:
    """Convert atomic on-chain amount to Decimal USD using asset decimals."""
    decimals = DEFAULT_DECIMALS
    extra = req.extra or {}
    extra_decimals = extra.get("decimals")
    if isinstance(extra_decimals, int) and extra_decimals >= 0:
        decimals = extra_decimals
    # Decimal constructor on a str keeps full precision. Integer division
    # by `10 ** decimals` would truncate; Decimal division preserves it.
    amount = Decimal(req.amount)
    scale = Decimal(10) ** decimals
    return amount / scale


def _select_accept(
    payment_required: PaymentRequired,
    *,
    preferred_scheme: str = _DEFAULT_SCHEME,
    preferred_network: str = _DEFAULT_NETWORK,
) -> PaymentRequirements | None:
    """Pick the first accept entry that matches our registered scheme/network.

    Preference order:
      1. Exact match on (scheme, network) — e.g. (exact, eip155:8453).
      2. Same scheme on any CAIP-2 `eip155:` chain — the SDK's V2 EVM
         client is registered under `eip155:*` so any EVM network works.
      3. Give up. V1 legacy networks (e.g. plain `"base"`) are rejected;
         the caller gets a `no_supported_scheme` error upstream.
    """
    for entry in payment_required.accepts:
        if entry.scheme == preferred_scheme and entry.network == preferred_network:
            return entry
    for entry in payment_required.accepts:
        if (
            entry.scheme == preferred_scheme
            and entry.network.startswith(_EIP155_PREFIX)
        ):
            return entry
    return None


def _encode_payment_header(payload: Any) -> str:
    """Base64-encode the JSON form of a x402 payment payload for X-PAYMENT."""
    # `model_dump_json(by_alias=True, exclude_none=True)` matches what the
    # x402 SDK emits internally for the header — keep one source of truth.
    return base64.b64encode(
        payload.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8")
    ).decode("ascii")


def _truncate_body(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


class XenarchPay(BaseTool):
    """Pay for x402-gated content. Vendor-neutral, LangChain-idiomatic."""

    name: str = "xenarch_pay"
    description: str = (
        "Pay for gated content or a service over the x402 protocol. "
        "Fetches the URL, handles any HTTP 402 challenge by signing an "
        "EIP-3009 USDC authorization with the configured wallet, and "
        "returns the unlocked resource body. Input: the URL to retrieve."
    )

    # --- Wallet ---------------------------------------------------------
    # 0x-prefixed hex private key. Held in pydantic so tool-level repr
    # doesn't leak it (pydantic redacts secret-looking fields only if you
    # use SecretStr — BaseTool's own repr is already field-filtered, but
    # downstream tool registries may pickle/log the model; treat this as
    # the caller's responsibility and document it in the README).
    private_key: str

    # --- Budget ---------------------------------------------------------
    budget_policy: XenarchBudgetPolicy = Field(default_factory=XenarchBudgetPolicy)

    # --- Facilitator hooks (placeholder for PR 5d) ----------------------
    # Stored but unused at this layer. Receipts, reputation, and pay.json
    # land in later PRs — keeping the field here means callers can wire
    # the URL once and pick up those features without a constructor change.
    facilitator_url: str = Field(default="https://xenarch.dev")

    # --- HTTP client ----------------------------------------------------
    http_timeout: float = Field(default=10.0)
    max_response_bytes: int = Field(default=1_000_000)

    # --- Internals ------------------------------------------------------
    # Built in `model_post_init` so pydantic entry points that skip
    # `__init__` (model_copy, model_validate) still produce a live pair
    # of clients. Clients are stateful w.r.t. registered schemes, so we
    # intentionally do NOT share one instance across tools.
    _x402_sync: x402ClientSync = PrivateAttr(default=None)  # type: ignore[assignment]
    _x402_async: x402Client = PrivateAttr(default=None)  # type: ignore[assignment]
    _signer_address: str = PrivateAttr(default="")

    def model_post_init(self, __context: Any) -> None:
        # Import here so `eth_account` is only required when the tool is
        # actually constructed — keeps the `xenarch[langchain]` optional
        # extra usable without the x402 signer stack.
        from eth_account import Account

        account = Account.from_key(self.private_key)
        signer = EthAccountSigner(account)

        self._signer_address = account.address
        self._x402_sync = x402ClientSync()
        register_exact_evm_client(self._x402_sync, signer)
        self._x402_async = x402Client()
        register_exact_evm_client(self._x402_async, signer)

    # -------------------------------------------------------------------
    # Shared pre/post logic — kept sync-only; the async path calls the
    # same helpers with an httpx.AsyncClient and awaits the async SDK.
    # -------------------------------------------------------------------

    def _parse_402(self, response: httpx.Response) -> PaymentRequired | None:
        """Return the parsed PaymentRequired (V2) or None if V1/invalid."""
        try:
            parsed = parse_payment_required(response.content)
        except Exception:
            return None
        # Minimal 5b scope only handles V2. V1 is still widely deployed but
        # needs different scheme selection; defer to a later PR.
        if not isinstance(parsed, PaymentRequired):
            return None
        return parsed

    def _budget_gate(
        self,
        *,
        url: str,
        accept: PaymentRequirements,
        price: Decimal,
    ) -> dict[str, Any] | None:
        """Run the budget check + optional approval. Caller holds the lock."""
        budget_error = self.budget_policy.check(price)
        if budget_error is not None:
            return budget_error

        plan = {
            "url": url,
            "price_usd": str(price),
            "pay_to": accept.pay_to,
            "asset": accept.asset,
            "network": accept.network,
            "scheme": accept.scheme,
        }
        approval_error = self.budget_policy.request_approval(plan)
        if approval_error is not None:
            return approval_error
        return None

    def _success_response(
        self,
        *,
        url: str,
        response: httpx.Response,
        accept: PaymentRequirements,
        price: Decimal,
    ) -> str:
        body = _truncate_body(response.text, self.max_response_bytes)
        return json.dumps(
            {
                "success": True,
                "url": url,
                "amount_usd": str(price),
                "pay_to": accept.pay_to,
                "asset": accept.asset,
                "network": accept.network,
                "payment_response": response.headers.get(_X_PAYMENT_RESPONSE_HEADER),
                "body": body,
                "session_spent_usd": str(self.budget_policy.session_spent),
            }
        )

    # -------------------------------------------------------------------
    # Sync entry point
    # -------------------------------------------------------------------

    def _run(self, url: str) -> str:
        try:
            with httpx.Client(timeout=self.http_timeout) as client:
                initial = client.get(url)

                if initial.status_code != 402:
                    return json.dumps(
                        {
                            "status": "no_payment_required",
                            "url": url,
                            "http_status": initial.status_code,
                            "body": _truncate_body(
                                initial.text, self.max_response_bytes
                            ),
                        }
                    )

                payment_required = self._parse_402(initial)
                if payment_required is None:
                    return json.dumps(
                        {
                            "error": "x402_parse_failed",
                            "url": url,
                            "body": _truncate_body(initial.text, 500),
                        }
                    )

                accept = _select_accept(payment_required)
                if accept is None:
                    return json.dumps(
                        {
                            "error": "no_supported_scheme",
                            "url": url,
                            "accepts": [
                                {"scheme": a.scheme, "network": a.network}
                                for a in payment_required.accepts
                            ],
                        }
                    )

                price = _price_usd(accept)

                # Hold the lock from budget check through commit so two
                # concurrent calls on the same tool can't both pass a
                # session-cap check when only one would fit.
                with self.budget_policy.lock():
                    gate_error = self._budget_gate(
                        url=url, accept=accept, price=price
                    )
                    if gate_error is not None:
                        return json.dumps(gate_error)

                    payload = self._x402_sync.create_payment_payload(
                        payment_required
                    )
                    header_value = _encode_payment_header(payload)

                    paid = client.get(
                        url, headers={_X_PAYMENT_HEADER: header_value}
                    )

                    if paid.status_code != 200:
                        return json.dumps(
                            {
                                "error": "x402_retry_failed",
                                "url": url,
                                "http_status": paid.status_code,
                                "body": _truncate_body(paid.text, 500),
                            }
                        )

                    # Commit the moment the paid GET returns 200. Any
                    # later post-payment work (receipts, etc.) must not
                    # revert this — if it raises, the caller still sees
                    # the spend on the session budget.
                    self.budget_policy.commit(price)

                    return self._success_response(
                        url=url, response=paid, accept=accept, price=price
                    )
        except httpx.HTTPError as exc:
            return json.dumps({"error": "http_error", "details": str(exc)})
        except Exception as exc:  # noqa: BLE001 — tool contract is JSON-string
            return json.dumps({"error": "unexpected_error", "details": str(exc)})

    # -------------------------------------------------------------------
    # Async entry point — real implementation, not `sync_to_async`.
    # -------------------------------------------------------------------

    async def _arun(self, url: str) -> str:
        try:
            async with httpx.AsyncClient(timeout=self.http_timeout) as client:
                initial = await client.get(url)

                if initial.status_code != 402:
                    return json.dumps(
                        {
                            "status": "no_payment_required",
                            "url": url,
                            "http_status": initial.status_code,
                            "body": _truncate_body(
                                initial.text, self.max_response_bytes
                            ),
                        }
                    )

                payment_required = self._parse_402(initial)
                if payment_required is None:
                    return json.dumps(
                        {
                            "error": "x402_parse_failed",
                            "url": url,
                            "body": _truncate_body(initial.text, 500),
                        }
                    )

                accept = _select_accept(payment_required)
                if accept is None:
                    return json.dumps(
                        {
                            "error": "no_supported_scheme",
                            "url": url,
                            "accepts": [
                                {"scheme": a.scheme, "network": a.network}
                                for a in payment_required.accepts
                            ],
                        }
                    )

                price = _price_usd(accept)

                with self.budget_policy.lock():
                    gate_error = self._budget_gate(
                        url=url, accept=accept, price=price
                    )
                    if gate_error is not None:
                        return json.dumps(gate_error)

                    payload = await self._x402_async.create_payment_payload(
                        payment_required
                    )
                    header_value = _encode_payment_header(payload)

                    paid = await client.get(
                        url, headers={_X_PAYMENT_HEADER: header_value}
                    )

                    if paid.status_code != 200:
                        return json.dumps(
                            {
                                "error": "x402_retry_failed",
                                "url": url,
                                "http_status": paid.status_code,
                                "body": _truncate_body(paid.text, 500),
                            }
                        )

                    self.budget_policy.commit(price)

                    return self._success_response(
                        url=url, response=paid, accept=accept, price=price
                    )
        except httpx.HTTPError as exc:
            return json.dumps({"error": "http_error", "details": str(exc)})
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": "unexpected_error", "details": str(exc)})

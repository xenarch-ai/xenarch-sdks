"""Vendor-neutral x402 payment tool for LangChain agents.

``XenarchPay`` speaks the public x402 protocol (HTTP 402 + EIP-3009 USDC on
Base) via the official ``x402`` PyPI SDK. It is not tied to the Xenarch
facilitator — the default ``facilitator_url`` points at ``xenarch.dev`` but
the payment path works against any spec-compliant x402 resource server.

Flow per call:

  1. If ``discover_via_pay_json`` is on, fetch the host's pay.json and
     match the URL path. If the rule advertises ``budget_hints`` that
     exceed the caller's budget policy, refuse without hitting the URL
     — saves a network round-trip on resources we could never afford.
  2. GET the resource.
  3. If the response is not 402, return the body (resource is free).
  4. Parse the 402 body into ``PaymentRequired`` via the x402 SDK.
  5. Select the first ``scheme=="exact"`` accept entry whose network
     matches a scheme registered on the SDK client (the tool pre-registers
     the EVM-exact scheme for EIP-3009 USDC).
  6. Convert the atomic ``amount`` to a ``Decimal`` USD price using the
     asset's ``decimals`` (6 for USDC).
  7. Under ``budget_policy.lock()``: budget check → optional approval →
     ``create_payment_payload`` → retry the GET with ``X-PAYMENT`` → commit
     the session spend BEFORE post-payment work (so a later failure cannot
     silently re-open the budget).
  8. Return a JSON string with the body and transaction metadata.

After a successful payment, the tool optionally fetches a signed receipt
from the facilitator (``GET /v1/receipts/{tx_hash}``) and verifies its
Ed25519 signature against the facilitator's published public key. Receipt
fetch is auto-on for ``xenarch.dev`` / ``xenarch.com`` hosts and off for
other facilitators unless explicitly requested — this preserves the
vendor-neutral story for upstream LangChain usage.

The tool also supports an opt-in reputation gate: set
``require_reputation_score`` to a ``Decimal`` and the tool will fetch
``GET /v1/reputation/{pay_to}`` before paying and refuse if the receiver
scores below the threshold. Unknown receivers (404) score ``0.0`` — the
gate fails closed for untrusted addresses.

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

import asyncio
import base64
import ipaddress
import json
import socket
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

import httpx
from langchain_core.tools import BaseTool
from pydantic import Field, PrivateAttr, ValidationError

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


def _split_host_path(url: str) -> tuple[str, str]:
    """Split a URL into (host, path) for pay.json resolution.

    Returns the host as ``hostname[:port]`` with any userinfo stripped,
    so error echoes and pay.json fetches never leak credentials embedded
    in a URL like ``https://user:pass@example.com/foo``. Path falls back
    to ``"/"`` when empty so the rule matcher always has something to
    glob against — ``match_rule("")`` is ill-defined.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    host = f"{hostname}:{parsed.port}" if parsed.port else hostname
    path = parsed.path or "/"
    return host, path


def _is_public_host(host: str) -> bool:
    """True iff ``host`` resolves only to globally-routable IP addresses.

    Blocks SSRF to loopback, RFC1918 private ranges, link-local (including
    AWS/GCP IMDS at 169.254.169.254), multicast, and reserved/unspecified
    space. An agent-provided URL like ``http://169.254.169.254/latest``
    would otherwise let a prompt-injection attack read cloud metadata into
    the LLM's context.

    Best-effort only: a TOCTOU window exists between this resolve and the
    actual connect, and DNS rebinding can defeat it. Treat as defence-in-
    depth on top of network-level egress rules.
    """
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    if not infos:
        return False
    for _family, _type, _proto, _canon, sockaddr in infos:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_unspecified
            or ip.is_reserved
        ):
            return False
    return True


async def _is_public_host_async(host: str) -> bool:
    """Async variant of ``_is_public_host`` that doesn't block the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _is_public_host, host)


def _budget_hint_exceeds(
    rule_hints: dict[str, Any],
    policy: XenarchBudgetPolicy,
) -> dict[str, Any] | None:
    """Return an error dict if rule-advertised caps exceed the local policy.

    We compare on two knobs: per-call and per-session. The publisher's
    hint is advisory (`recommended_max_per_call`), not authoritative —
    we use it only to short-circuit hopeless fetches. When hints are
    malformed or missing, treat as "no guidance" and fall through to the
    live 402 price check.
    """
    per_call_hint = rule_hints.get("recommended_max_per_call")
    per_session_hint = rule_hints.get("recommended_max_per_session")

    def _as_decimal(raw: Any) -> Decimal | None:
        if not isinstance(raw, str):
            return None
        try:
            value = Decimal(raw)
        except Exception:
            return None
        return value if value.is_finite() and value >= 0 else None

    per_call = _as_decimal(per_call_hint)
    if per_call is not None and per_call > policy.max_per_call:
        return {
            "error": "budget_hint_exceeded",
            "reason": "recommended_max_per_call",
            "hint_usd": str(per_call),
            "limit_usd": str(policy.max_per_call),
        }

    per_session = _as_decimal(per_session_hint)
    if per_session is not None and per_session > policy.max_per_session:
        return {
            "error": "budget_hint_exceeded",
            "reason": "recommended_max_per_session",
            "hint_usd": str(per_session),
            "limit_usd": str(policy.max_per_session),
        }

    return None


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

    # --- Facilitator hooks ---------------------------------------------
    facilitator_url: str = Field(default="https://xenarch.dev")

    # Auto-on for Xenarch-operated facilitators, off for everyone else —
    # protects the vendor-neutral upstream story. Set True explicitly to
    # force fetches against a third-party facilitator that implements the
    # same wire format, or False to skip even on Xenarch hosts.
    fetch_receipts: bool | None = Field(default=None)
    verify_receipts: bool = Field(default=True)
    facilitator_public_key_url: str | None = Field(default=None)
    receipts_timeout: float = Field(default=5.0)

    # Opt-in receiver-address gate. Unknown receivers (404 on
    # ``/v1/reputation/...``) are treated as ``0.0`` so the gate fails
    # closed for new publishers rather than throwing on them.
    require_reputation_score: Decimal | None = Field(default=None)
    reputation_timeout: float = Field(default=5.0)

    # --- pay.json pre-discovery ----------------------------------------
    # When on, the tool fetches `/.well-known/pay.json` on the target host
    # before hitting the resource. If the matched rule's `budget_hints`
    # exceed the budget policy's caps, the call refuses early. When off
    # (or when the host serves no pay.json), we fall through to the 402
    # path — pay.json is a hint, not a gate.
    discover_via_pay_json: bool = Field(default=True)
    pay_json_timeout: float = Field(default=5.0)

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
    # Public-key cache is per-tool, not module-level: tests can rotate
    # keys by constructing a fresh tool, and production callers can force
    # a refresh the same way.
    _facilitator_pubkey: Any = PrivateAttr(default=None)

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

        The header is base64-encoded JSON matching the x402 ``SettleResponse``
        schema; ``transaction`` is the on-chain hash we use to look up the
        signed receipt. Missing header or garbage payload → None (receipts
        are best-effort, never raise on a paid GET that already succeeded).
        """
        header = response.headers.get(_X_PAYMENT_RESPONSE_HEADER)
        if not header:
            return None
        try:
            decoded = json.loads(base64.b64decode(header).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            return None
        tx = decoded.get("transaction")
        return tx if isinstance(tx, str) else None

    def _reputation_gate(self, pay_to: str) -> dict[str, Any] | None:
        """Run the opt-in reputation check. Returns an error dict to abort."""
        if self.require_reputation_score is None:
            return None
        from xenarch import _reputation  # defer: optional path; keeps import cheap

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
            try:
                self._facilitator_pubkey = await _receipts.fetch_public_key_async(
                    self._public_key_url(),
                    timeout=self.receipts_timeout,
                )
            except (httpx.HTTPError, ValueError):
                return False
        return _receipts.verify_signature(self._facilitator_pubkey, receipt)

    def _pay_json_pre_check(self, url: str) -> dict[str, Any] | None:
        """Fetch pay.json for the URL's host; return an error dict to abort,
        or ``None`` to continue to the 402 flow.

        Three refusal cases bubble up:
          - ``pay_json_invalid`` — document exists but is malformed. We
            treat this as a hard stop rather than a fallthrough because a
            broken pay.json usually means the publisher is misconfigured
            and the live 402 is likely to be broken too.
          - ``budget_hint_exceeded`` — advertised caps exceed the policy.
          - ``pay_json_error`` — transport failure; logged for debugging
            but we fall through to the live 402 on timeouts/connection
            errors so a flaky pay.json endpoint doesn't disable payments.

        The 404 case (``PayJsonNotFound``) is expected and silent: most
        hosts do not yet serve pay.json. Fall straight through to 402.
        """
        if not self.discover_via_pay_json:
            return None

        # Import locally so callers who don't install the `[x402]` extra
        # (and therefore don't have pay-json) never hit a hard import
        # error at `xenarch.tools.x402_pay` module load.
        from pay_json import PayJson, PayJsonInvalid, PayJsonNotFound

        host, path = _split_host_path(url)
        if not host:
            # Malformed URL — let the live GET surface the real error
            # rather than synthesizing one here.
            return None

        try:
            doc = PayJson.fetch(host, timeout=self.pay_json_timeout)
        except PayJsonNotFound:
            return None
        except PayJsonInvalid as exc:
            return {
                "error": "pay_json_invalid",
                "host": host,
                "details": str(exc),
            }
        except Exception:
            # Transport errors, schema edge cases, etc. — fall through.
            # The live 402 is the authoritative price source anyway.
            return None

        rule = doc.match_rule(path)
        if rule is None or rule.budget_hints is None:
            return None

        return _budget_hint_exceeds(rule.budget_hints, self.budget_policy)

    def _parse_402(self, response: httpx.Response) -> PaymentRequired | None:
        """Return the parsed PaymentRequired (V2) or None if V1/invalid."""
        try:
            parsed = parse_payment_required(response.content)
        except (ValueError, TypeError, ValidationError, json.JSONDecodeError):
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
    ) -> dict[str, Any]:
        body = _truncate_body(response.text, self.max_response_bytes)
        return {
            "success": True,
            "url": url,
            "amount_usd": str(price),
            "pay_to": accept.pay_to,
            "asset": accept.asset,
            "network": accept.network,
            "payment_response": response.headers.get(
                _X_PAYMENT_RESPONSE_HEADER
            ),
            "body": body,
            "session_spent_usd": str(self.budget_policy.session_spent),
        }

    # -------------------------------------------------------------------
    # Sync entry point
    # -------------------------------------------------------------------

    def _run(self, url: str) -> str:
        try:
            hostname = urlparse(url).hostname or ""
            if not _is_public_host(hostname):
                return json.dumps(
                    {"error": "unsafe_host", "host": hostname}
                )

            pre_check = self._pay_json_pre_check(url)
            if pre_check is not None:
                return json.dumps(pre_check)

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

                # Reputation gate runs before the budget lock: a failing
                # lookup must not block other concurrent payments from
                # acquiring the session budget.
                rep_error = self._reputation_gate(accept.pay_to)
                if rep_error is not None:
                    return json.dumps(rep_error)

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

                    result = self._success_response(
                        url=url, response=paid, accept=accept, price=price
                    )
                    self._attach_receipt(result, paid)
                    return json.dumps(result)
        except httpx.HTTPError as exc:
            return json.dumps(
                {"error": "http_error", "kind": type(exc).__name__}
            )
        except Exception as exc:  # noqa: BLE001 — tool contract is JSON-string
            return json.dumps(
                {"error": "unexpected_error", "kind": type(exc).__name__}
            )

    # -------------------------------------------------------------------
    # Async entry point — real implementation, not `sync_to_async`.
    # -------------------------------------------------------------------

    async def _arun(self, url: str) -> str:
        try:
            hostname = urlparse(url).hostname or ""
            if not await _is_public_host_async(hostname):
                return json.dumps(
                    {"error": "unsafe_host", "host": hostname}
                )

            # PayJson.fetch is sync. Run it off the event loop so agents
            # with high-throughput async chains aren't blocked on a
            # third-party host serving pay.json.
            pre_check = await asyncio.to_thread(self._pay_json_pre_check, url)
            if pre_check is not None:
                return json.dumps(pre_check)

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

                rep_error = await self._reputation_gate_async(accept.pay_to)
                if rep_error is not None:
                    return json.dumps(rep_error)

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

                    result = self._success_response(
                        url=url, response=paid, accept=accept, price=price
                    )
                    await self._attach_receipt_async(result, paid)
                    return json.dumps(result)
        except httpx.HTTPError as exc:
            return json.dumps(
                {"error": "http_error", "kind": type(exc).__name__}
            )
        except Exception as exc:  # noqa: BLE001
            return json.dumps(
                {"error": "unexpected_error", "kind": type(exc).__name__}
            )

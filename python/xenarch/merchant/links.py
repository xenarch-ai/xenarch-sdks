"""Pay-link CRUD — list, get, create (validate → sign → create), revoke.

Create mirrors the CLI / MCP flow exactly:
1. ``POST /v1/links/validate`` collects every missing/invalid field up front,
   so "validate ok ⇒ create ok" (modulo signature).
2. The merchant wallet signs the link template (EIP-712, see ``_signing``).
3. ``POST /v1/links`` with an auto-generated ``Idempotency-Key``.

Signing and revoking are gated by the client's confirm policy: both move real
money or are irreversible, so they need an explicit ``confirm=True`` unless the
client was built with ``require_confirm=False``.
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from xenarch.merchant import _idempotency, _signing

if TYPE_CHECKING:
    from xenarch.merchant import MerchantClient


class PayLinkValidationError(Exception):
    """``create()``/``validate()`` found missing or invalid params.

    ``missing`` and ``errors`` carry the platform's field-level issues
    (``[{field, message, prompt}]``) so a caller — human or agent — can ask
    for exactly the fields it still needs.
    """

    def __init__(
        self, missing: list[dict[str, Any]], errors: list[dict[str, Any]]
    ) -> None:
        self.missing = missing
        self.errors = errors
        problems = [i.get("message", i.get("field", "?")) for i in missing + errors]
        super().__init__("pay-link params invalid: " + "; ".join(problems))


class LinksAPI:
    def __init__(self, client: MerchantClient) -> None:
        self._c = client

    def list(
        self, *, limit: int = 25, starting_after: str | None = None
    ) -> dict[str, Any]:
        """List your pay-links, newest-first. ``{links, has_more, next_cursor}``."""
        return self._c._transport.request(
            "GET",
            "/links",
            params={"limit": limit, "starting_after": starting_after},
        )

    def get(self, link_id: str) -> dict[str, Any]:
        """Full owner detail for one link (params, status, stats, webhook config)."""
        return self._c._transport.request("GET", f"/links/{link_id}")

    def schema(self) -> dict[str, Any]:
        """Versioned create-body field descriptor (``GET /v1/links/schema``).

        Auth-free. Describes every param group the create body accepts —
        iterate it to drive a prompt loop or build a form.
        """
        return self._c._transport.request("GET", "/links/schema")

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        """Check a (partial or complete) params tree before signing.

        Returns ``{ok, missing, errors}`` without signing or persisting —
        the same validator ``create`` runs, so a passing validate guarantees
        create will accept the params.
        """
        return self._c._transport.request(
            "POST", "/links/validate", json_body={"params": params}
        )

    def create(self, params: dict[str, Any], *, confirm: bool = False) -> dict[str, Any]:
        """Sign and create a pay-link.

        Validates first (raises ``PayLinkValidationError`` with field-level
        issues if anything is missing/invalid), then signs the template with
        the merchant wallet and creates the link. The response includes the
        one-time ``webhook_secret`` — store it now; it is never shown again.

        Each call sends an auto-generated ``Idempotency-Key``, which dedupes a
        network-level retry of *this* request. Re-running ``create`` mints a
        fresh nonce (a new link), so it is not a cross-call dedupe.

        Signing commits the wallet to the link's payment terms, so this is
        confirm-gated: pass ``confirm=True`` (or build the client with
        ``require_confirm=False``).
        """
        self._c._ensure_confirmed(confirm, "create (sign) a pay-link")

        result = self.validate(params)
        if not result.get("ok", False):
            raise PayLinkValidationError(
                missing=result.get("missing", []),
                errors=result.get("errors", []),
            )

        private_key = self._c._require_signing_key()
        created_at = int(time.time())
        nonce = _signing.generate_nonce()
        signed_params = _signing.sign_params(
            params, private_key=private_key, created_at=created_at, nonce=nonce
        )

        key = _idempotency.new_key()
        _idempotency.record(key, created_at=created_at, config_dir=self._c._config_dir)

        return self._c._transport.request(
            "POST",
            "/links",
            json_body={
                "params": params,
                "nonce": "0x" + nonce.hex(),
                "created_at": created_at,
                "signed_params": signed_params,
            },
            extra_headers={"Idempotency-Key": key},
        )

    def revoke(self, link_id: str, *, confirm: bool = False) -> dict[str, Any]:
        """Revoke a link. Irreversible — live customers can no longer pay it.

        Confirm-gated: pass ``confirm=True`` (or build the client with
        ``require_confirm=False``).
        """
        self._c._ensure_confirmed(confirm, f"revoke link {link_id}")
        return self._c._transport.request("DELETE", f"/links/{link_id}")

"""``xenarch.merchant`` — the get-paid side of the SDK.

Manage pay-links, read payments and subscribers, and edit your merchant
profile — everything the dashboard does, callable from a script or an AI
agent. Authentication reuses the SIWE session the CLI establishes
(``xenarch agent login``); signing pay-links uses the merchant wallet's
private key.

    from xenarch.merchant import MerchantClient

    # explicit credentials
    mc = MerchantClient(session_token=tok, private_key=pk)

    # or reuse the CLI's logged-in session + wallet
    mc = MerchantClient.from_config()

    links = mc.links.list(limit=10)
    link = mc.links.create(params, confirm=True)   # signs with the wallet
    mc.links.revoke(link["link_id"], confirm=True)

Signing (create) and revoking are confirm-gated by default so a stray agent
call can't commit funds or kill a live link. Trusted scripts can opt out with
``MerchantClient(..., require_confirm=False)``.
"""
from __future__ import annotations

from pathlib import Path

from xenarch.merchant._session import (
    ConfirmationRequired,
    MerchantAPIError,
    MerchantError,
    SessionExpiredError,
    _Transport,
    load_config,
)
from xenarch.merchant._signing import SigningError, signer_address
from xenarch.merchant.links import LinksAPI, PayLinkValidationError
from xenarch.merchant.payments import PaymentsAPI
from xenarch.merchant.profile import ProfileAPI
from xenarch.merchant.subscribers import SubscribersAPI

__all__ = [
    "MerchantClient",
    "MerchantError",
    "MerchantAPIError",
    "SessionExpiredError",
    "ConfirmationRequired",
    "PayLinkValidationError",
    "SigningError",
]


class MerchantClient:
    """Sync client for merchant operations against the Xenarch platform.

    Args:
        session_token: the ``xen_session`` cookie value from ``xenarch agent
            login``. Required.
        private_key: the merchant wallet's private key (hex). Required only for
            ``links.create`` (which signs the pay-link template). Read-only ops
            work without it.
        api_base: platform base URL. Defaults to ``https://api.xenarch.dev``.
        require_confirm: when True (default), ``links.create`` and
            ``links.revoke`` require ``confirm=True``. Set False for trusted
            scripts.
        timeout: per-request timeout in seconds.
    """

    def __init__(
        self,
        session_token: str,
        *,
        private_key: str | None = None,
        api_base: str = "https://api.xenarch.dev",
        require_confirm: bool = True,
        timeout: float = 15.0,
        config_dir: str | Path | None = None,
    ) -> None:
        self._transport = _Transport(
            session_token=session_token,
            api_base=api_base,
            private_key=private_key,
            timeout=timeout,
        )
        self._require_confirm = require_confirm
        self._config_dir = config_dir

        self.links = LinksAPI(self)
        self.payments = PaymentsAPI(self)
        self.subscribers = SubscribersAPI(self)
        self.profile = ProfileAPI(self)

    @classmethod
    def from_config(
        cls,
        *,
        config_dir: str | Path | None = None,
        require_confirm: bool = True,
        timeout: float = 15.0,
    ) -> MerchantClient:
        """Build a client from the CLI's ``~/.xenarch/config.json``.

        Pulls the SIWE ``session_token``, ``api_base``, and (for a local
        wallet) the signing key. Raises ``SessionExpiredError`` if no session
        is stored.
        """
        cfg = load_config(config_dir)
        session_token = cfg.get("session_token")
        if not session_token:
            raise SessionExpiredError(
                "no session in config — run `xenarch agent login` first"
            )
        wallet = cfg.get("wallet") or {}
        private_key = wallet.get("private_key") if wallet.get("type") == "local" else None
        return cls(
            session_token,
            private_key=private_key,
            api_base=cfg.get("api_base", "https://api.xenarch.dev"),
            require_confirm=require_confirm,
            timeout=timeout,
            config_dir=config_dir,
        )

    # --- internal helpers used by the resource APIs ------------------------

    def _ensure_confirmed(self, confirm: bool, action: str) -> None:
        if self._require_confirm and not confirm:
            raise ConfirmationRequired(
                f"refusing to {action} without confirmation — pass confirm=True "
                "(or build the client with require_confirm=False)"
            )

    def _require_signing_key(self) -> str:
        key = self._transport.private_key
        if not key:
            raise SigningError(
                "no signing key — pass private_key= to create pay-links "
                "(the merchant wallet must sign the link template)"
            )
        # Surface a clearer error than a downstream eth-account failure.
        try:
            signer_address(key)
        except Exception as exc:  # noqa: BLE001
            raise SigningError(f"invalid private_key: {exc}") from exc
        return key

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> MerchantClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

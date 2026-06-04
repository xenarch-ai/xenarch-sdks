"""Merchant profile — issuer identity shown on checkout + receipts, and
domain verification.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from xenarch.merchant import MerchantClient


class ProfileAPI:
    def __init__(self, client: MerchantClient) -> None:
        self._c = client

    def show(self) -> dict[str, Any] | None:
        """Your merchant profile, or ``None`` if you haven't set one up yet."""
        return self._c._transport.request("GET", "/merchant-profile")

    def update(self, **fields: Any) -> dict[str, Any]:
        """Create or update your merchant profile.

        Accepts the editable fields (e.g. ``issuer_name``, ``merchant_site``,
        ``issuer_email``, ``issuer_address``, ``issuer_tax_id``, ``brand_color``,
        ``issuer_logo_url``, ``collection_rhythm``). Only the fields you pass
        are sent.
        """
        return self._c._transport.request(
            "PUT", "/merchant-profile", json_body=fields
        )

    def verify_domain(self) -> dict[str, Any]:
        """Run domain verification for the profile's ``merchant_site``.

        The platform fetches the well-known proof from your site and marks the
        profile verified on success. Returns the updated profile.
        """
        return self._c._transport.request(
            "POST", "/merchant-profile/verify-domain"
        )

"""Live-endpoint contract tests (XEN-148 PR 5d).

These tests are marked ``@pytest.mark.contract`` and *auto-skip* unless the
target endpoints are reachable — so ``pytest`` stays green on a laptop with
no local platform running, and CI only runs them when a compose stack or
a reference server is explicitly up.

Targets:

1. **Local xenarch-platform** — ``http://localhost:8000`` by default. Overrides
   via ``XENARCH_PLATFORM_URL``. Proves our ``parse_payment_required`` and
   ``_select_accept`` logic matches what our own server actually emits. If
   the platform ships a 402 body shape we can't parse, nothing further
   works — this test is the tripwire.

2. **Coinbase reference x402 server** — opt-in via
   ``COINBASE_X402_URL=<full url to a gated endpoint>``. Proves the same
   parsing path works against an independent implementation of the spec.
   Skipped unless the env var is set, because the reference server's paths
   move — a hard-coded URL would rot and produce false failures. We do
   NOT actually sign and submit a payment here; we only verify the
   challenge can be parsed and an accept entry selected.

Neither test spends real USDC. The first one is parse-only; the second one
stops before calling ``create_payment_payload``.
"""

from __future__ import annotations

import os

import httpx
import pytest

from x402_agent import select_accept as _select_accept
from x402.schemas import parse_payment_required, PaymentRequired


pytestmark = pytest.mark.contract


PLATFORM_URL = os.getenv("XENARCH_PLATFORM_URL", "http://localhost:8000")
# No default for Coinbase — reference server paths change; require an
# explicit URL pointing at a 402-gated endpoint to run this test.
COINBASE_URL = os.getenv("COINBASE_X402_URL")
PROBE_TIMEOUT = 2.0


def _reachable(url: str) -> bool:
    """Return True if the endpoint answers anything (even an error) quickly.

    Fast probe so the whole suite doesn't pay a 30s connection timeout on
    every CI run that happens to not have the server up.
    """
    try:
        httpx.get(url, timeout=PROBE_TIMEOUT, follow_redirects=False)
    except httpx.HTTPError:
        return False
    return True


def _parse_402(content: bytes) -> PaymentRequired:
    parsed = parse_payment_required(content)
    assert isinstance(parsed, PaymentRequired), (
        f"expected V2 PaymentRequired, got {type(parsed).__name__}"
    )
    return parsed


@pytest.fixture(scope="module")
def platform_up() -> bool:
    if not _reachable(PLATFORM_URL):
        pytest.skip(f"platform not reachable at {PLATFORM_URL}")
    return True


@pytest.fixture(scope="module")
def coinbase_up() -> str:
    if not COINBASE_URL:
        pytest.skip(
            "COINBASE_X402_URL unset — point it at a 402-gated reference URL "
            "to run this test."
        )
    if not _reachable(COINBASE_URL):
        pytest.skip(
            f"Coinbase reference x402 server not reachable at {COINBASE_URL}"
        )
    return COINBASE_URL


class TestLocalPlatformContract:
    """Our own platform's 402 must parse with our SDK. If this breaks, we
    broke our own wire format — catch it before a real agent does."""

    def test_402_parses_and_selects_accept(self, platform_up: bool) -> None:
        gated_url = f"{PLATFORM_URL.rstrip('/')}/demo/gated"
        resp = httpx.get(gated_url, timeout=5.0)
        assert resp.status_code == 402, (
            f"expected 402 from {gated_url}, got {resp.status_code}"
        )
        parsed = _parse_402(resp.content)
        accept = _select_accept(parsed)
        assert accept is not None, "no supported scheme in local platform 402"
        assert accept.scheme == "exact"
        assert accept.network.startswith("eip155:")


class TestCoinbaseReferenceContract:
    """Cross-implementation check: the public reference server's 402 must
    also parse + match our scheme selector. If this fails, either the
    reference broke, or our parser drifted from spec."""

    def test_402_parses_and_selects_accept(self, coinbase_up: str) -> None:
        # coinbase_up is the full URL of a 402-gated reference endpoint.
        resp = httpx.get(coinbase_up, timeout=5.0)
        assert resp.status_code == 402, (
            f"expected 402 from reference server, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )
        parsed = _parse_402(resp.content)
        accept = _select_accept(parsed)
        assert accept is not None, "reference 402 had no eip155 accept entry"

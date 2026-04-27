"""Phase A facilitator smoke test.

De-risks the no-splitter pivot by paying a real 402-gated endpoint on Base
mainnet via x402-agent's ``X402Payer``. The resource server's choice of
facilitator (PayAI, xpay, ...) is observed in the X-PAYMENT-RESPONSE
header — this script does not select facilitators, the gated endpoint does.

Two modes:

* **Probe** (``MODE=probe``, default when ``PRIVATE_KEY`` is unset):
  Hits the endpoint with no payment, parses the 402 challenge, and reports
  whatever spec drift x402-agent would hit (V1 vs V2, network IDs, header
  names, asset, payTo, price). No signing, no funds, runs anywhere. This
  is what Phase A item A3 ("confirm V2 schema compatibility, capture spec
  drift") actually checks.

* **Pay** (``MODE=pay`` or ``PRIVATE_KEY`` set):
  Full settlement attempt against Base mainnet. Requires a funded wallet.

Usage::

    # Probe mode — safe, no key:
    TARGET_URL=https://x402.payai.network/api/base/paid-content \\
    FACILITATOR_LABEL=payai \\
    uv run python scripts/smoke_test_facilitator.py

    # Pay mode — needs a funded Base USDC wallet:
    PRIVATE_KEY=0x...                                           \\
    TARGET_URL=https://x402.payai.network/api/base/paid-content \\
    FACILITATOR_LABEL=payai                                     \\
    MODE=pay                                                    \\
    uv run python scripts/smoke_test_facilitator.py

Exit codes:
    0  probe succeeded (drift report printed) OR settlement tx returned
    1  pay-mode attempt failed to produce settlement evidence
    2  configuration / env-var error
    3  probe found a blocking spec gap (e.g. no compatible scheme/network)
"""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any

import httpx

from x402_agent import X402Payer
from x402_agent._helpers import (
    X_PAYMENT_HEADER,
    X_PAYMENT_RESPONSE_HEADER,
    select_accept,
)


BASESCAN_TX = "https://basescan.org/tx/{}"


def _require(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        print(f"ERROR: {name} env var is required", file=sys.stderr)
        sys.exit(2)
    return val


def _decode_payment_response(b64: str) -> dict[str, Any] | None:
    try:
        decoded = json.loads(base64.b64decode(b64).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    return decoded if isinstance(decoded, dict) else None


def _redact(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if k != "body"}


def _probe(target_url: str, label: str) -> int:
    """Hit the URL with no payment, parse the 402, report drift. No signing."""
    print(f"[probe] facilitator label : {label}")
    print(f"[probe] target URL        : {target_url}")
    print(f"[probe] x402-agent sends  : header '{X_PAYMENT_HEADER}', "
          f"expects response in '{X_PAYMENT_RESPONSE_HEADER}'")

    try:
        response = httpx.get(target_url, timeout=10.0)
    except httpx.HTTPError as exc:
        print(f"[probe] FAIL — HTTP error reaching endpoint: {exc}")
        return 1

    print(f"[probe] HTTP status       : {response.status_code}")
    if response.status_code != 402:
        print("[probe] FAIL — endpoint did not return 402, cannot smoke-test.")
        return 1

    # Header-name drift surface: PayAI V2 advertises PAYMENT-SIGNATURE /
    # PAYMENT-RESPONSE (no X- prefix); x402-agent uses the X- variants.
    cors_allow = response.headers.get("access-control-allow-headers", "")
    cors_expose = response.headers.get("access-control-expose-headers", "")
    print(f"[probe] CORS allow-headers : {cors_allow}")
    print(f"[probe] CORS expose-headers: {cors_expose}")
    server_uses_x_prefix = X_PAYMENT_HEADER.lower() in cors_allow.lower()
    server_uses_unprefixed = (
        "payment-signature" in cors_allow.lower()
        and X_PAYMENT_HEADER.lower() not in cors_allow.lower()
    )
    if server_uses_unprefixed:
        print(
            "[probe] DRIFT — server expects unprefixed PAYMENT-SIGNATURE; "
            f"x402-agent sends '{X_PAYMENT_HEADER}'. "
            "Likely root cause if pay mode 4xx's on retry."
        )
    elif not server_uses_x_prefix and cors_allow:
        print(
            "[probe] WARN — server CORS does not advertise "
            f"'{X_PAYMENT_HEADER}'. May reject the retry."
        )
    else:
        print("[probe] OK — server CORS accepts X-PAYMENT header family.")

    # Parse-level drift surface: scheme + network compatibility.
    payer = X402Payer(private_key="0x" + "00" * 32)
    parsed = payer._parse_402(response)
    if parsed is None:
        print("[probe] FAIL — x402-agent could not parse 402 body. Body:")
        print(response.text[:500])
        return 3

    accepts = parsed.accepts
    print(f"[probe] x402Version        : {getattr(parsed, 'x402_version', '?')}")
    print(f"[probe] accepts ({len(accepts)}):")
    for entry in accepts:
        print(
            f"  - scheme={entry.scheme} "
            f"network={entry.network} "
            f"pay_to={getattr(entry, 'pay_to', '?')} "
            f"asset={getattr(entry, 'asset', '?')}"
        )

    chosen = select_accept(parsed)
    if chosen is None:
        print(
            "[probe] FAIL — no accept entry matches x402-agent's registered "
            "scheme/network. Phase A pivot blocked here until the SDK adds "
            "support."
        )
        return 3
    print(
        f"[probe] OK — x402-agent would settle with: scheme={chosen.scheme}, "
        f"network={chosen.network}, pay_to={chosen.pay_to}, asset={chosen.asset}"
    )
    return 0


def _pay(target_url: str, private_key: str, label: str) -> int:
    """Real settlement attempt. Requires funded wallet."""
    payer = X402Payer(private_key=private_key)
    print(f"[pay]   facilitator label : {label}")
    print(f"[pay]   target URL        : {target_url}")
    print(f"[pay]   payer address     : {payer._signer_address}")

    result = payer.pay(target_url)
    print("[pay]   pay() result (body redacted):")
    print(json.dumps(_redact(result), indent=2, default=str))

    if result.get("error"):
        print(f"[pay]   FAIL — payer returned error: {result['error']}")
        return 1
    if not result.get("success"):
        print("[pay]   FAIL — payer did not report success.")
        return 1

    payment_response_b64 = result.get("payment_response")
    if not payment_response_b64:
        print(
            "[pay]   FAIL — paid response missing X-PAYMENT-RESPONSE; "
            "cannot confirm settlement."
        )
        return 1

    decoded = _decode_payment_response(payment_response_b64)
    if not decoded:
        print("[pay]   FAIL — X-PAYMENT-RESPONSE could not be decoded.")
        return 1

    print("[pay]   X-PAYMENT-RESPONSE decoded:")
    print(json.dumps(decoded, indent=2))

    tx = decoded.get("transaction")
    # V2 servers (PayAI) report network as CAIP-2 'eip155:8453'; V1 as 'base'.
    network = decoded.get("network") or result.get("network") or ""
    success_field = decoded.get("success", True)

    if not isinstance(tx, str) or not tx:
        print("[pay]   FAIL — no transaction hash in X-PAYMENT-RESPONSE.")
        return 1
    if success_field is False:
        print(f"[pay]   FAIL — facilitator reported success=false (tx={tx}).")
        return 1
    if network and network not in ("base", "eip155:8453"):
        print(
            f"[pay]   FAIL — settlement on network={network}, "
            "expected Base ('base' V1 or 'eip155:8453' V2)."
        )
        return 1

    print(f"[pay]   PASS — paid {result.get('amount_usd')} USDC")
    print(f"[pay]   PASS — pay_to        : {result.get('pay_to')}")
    print(f"[pay]   PASS — settlement tx : {BASESCAN_TX.format(tx)}")
    return 0


def main() -> int:
    target_url = _require("TARGET_URL")
    label = os.environ.get("FACILITATOR_LABEL", "unknown").strip() or "unknown"
    private_key = os.environ.get("PRIVATE_KEY", "").strip()
    mode = os.environ.get("MODE", "").strip().lower()
    if not mode:
        mode = "pay" if private_key else "probe"

    if mode == "probe":
        return _probe(target_url, label)
    if mode == "pay":
        if not private_key:
            print("ERROR: pay mode requires PRIVATE_KEY env var", file=sys.stderr)
            return 2
        return _pay(target_url, private_key, label)

    print(f"ERROR: unknown MODE={mode!r}; use 'probe' or 'pay'", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())

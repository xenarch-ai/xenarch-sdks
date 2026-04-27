"""One-off Phase A end-to-end test against PayAI Echo Merchant.

Monkey-patches x402-agent's X_PAYMENT_HEADER to the V2 name PayAI expects
(`PAYMENT-SIGNATURE`) before calling pay(). If this returns a settlement
tx hash on Base mainnet, the no-splitter pivot premise is fully validated:
third-party x402 facilitators settle real USDC, and the only blocker is
the SDK's hardcoded V1 header.

Reads PRIVATE_KEY from env. Writes a Basescan tx URL on success.
"""

from __future__ import annotations

import base64
import json
import os
import sys

import x402_agent._payer as _payer_mod

# Patch BEFORE constructing X402Payer so the retry uses V2's header name.
_payer_mod.X_PAYMENT_HEADER = "PAYMENT-SIGNATURE"

from x402_agent import X402Payer  # noqa: E402


TARGET = "https://x402.payai.network/api/base/paid-content"


def main() -> int:
    private_key = os.environ.get("PRIVATE_KEY", "").strip()
    if not private_key:
        print("ERROR: PRIVATE_KEY env var required", file=sys.stderr)
        return 2
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key

    print(f"[shim] x402_agent._payer.X_PAYMENT_HEADER = "
          f"{_payer_mod.X_PAYMENT_HEADER!r}")
    payer = X402Payer(private_key=private_key)
    print(f"[shim] payer address : {payer._signer_address}")
    print(f"[shim] target URL    : {TARGET}")

    result = payer.pay(TARGET)
    redacted = {k: v for k, v in result.items() if k != "body"}
    print("[shim] pay() result (body redacted):")
    print(json.dumps(redacted, indent=2, default=str))
    body = result.get("body") or ""
    print(f"[shim] body length: {len(body)} chars")
    # Body is HTML; extract anything that looks like a 0x-prefixed tx hash.
    import re
    tx_hashes = sorted(set(re.findall(r"0x[a-fA-F0-9]{64}", body)))
    print(f"[shim] tx hashes in body ({len(tx_hashes)}):")
    for h in tx_hashes:
        print(f"  https://basescan.org/tx/{h}")

    if not result.get("success"):
        print("[shim] FAIL — pay() did not report success.")
        return 1

    pr = result.get("payment_response")
    if not pr:
        print("[shim] FAIL — no payment_response header.")
        return 1
    try:
        decoded = json.loads(base64.b64decode(pr).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        print("[shim] FAIL — could not decode payment_response.")
        return 1

    print("[shim] X-PAYMENT-RESPONSE decoded:")
    print(json.dumps(decoded, indent=2))

    tx = decoded.get("transaction") if isinstance(decoded, dict) else None
    if not isinstance(tx, str) or not tx:
        print("[shim] FAIL — no transaction hash in payment_response.")
        return 1

    print(f"[shim] PASS — settlement tx: https://basescan.org/tx/{tx}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

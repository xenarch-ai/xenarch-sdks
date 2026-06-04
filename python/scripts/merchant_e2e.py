#!/usr/bin/env python3
"""Live end-to-end check for the merchant SDK against api.xenarch.dev.

Exercises the whole `xenarch.merchant` surface plus `xenarch.webhooks` against
the real platform. Nothing here moves USDC — it creates/reads/revokes a
pay-link (a signed template + REST calls), so it is free and safe to run
against production. The create call is the signing-parity proof: the platform
recovers the EIP-712 signature and rejects any mismatch, so a green create
means the SDK signs byte-identically to the platform.

Prerequisites:
  1. Log in with the CLI so the session + wallet land in ~/.xenarch/config.json:
         xenarch agent login
  2. Run this:
         cd xenarch-sdks/python && uv run python scripts/merchant_e2e.py
     (or: python scripts/merchant_e2e.py, with the package importable)

Flags:
  --amount 0.10     amount (USDC) for the test link (default 0.10)
  --keep            don't revoke the created link (so you can pay-test it)
  --api-base URL    override the platform base URL
"""
from __future__ import annotations

import argparse
import sys

from xenarch import webhooks
from xenarch.merchant import MerchantClient, SessionExpiredError
from xenarch.merchant._session import load_config

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
SKIP = "\033[33mSKIP\033[0m"

_passed = 0
_failed = 0


def step(label: str, fn):
    """Run one E2E step, print PASS/FAIL, return its result (or None on error)."""
    global _passed, _failed
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001 - this is a test harness
        _failed += 1
        print(f"  [{FAIL}] {label}\n         {type(exc).__name__}: {exc}")
        return None
    _passed += 1
    print(f"  [{PASS}] {label}")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--amount", default="0.10", help="USDC amount for the test link")
    ap.add_argument("--keep", action="store_true", help="don't revoke the test link")
    ap.add_argument("--api-base", default=None, help="override platform base URL")
    args = ap.parse_args()

    # --- session + wallet from the CLI's config ---------------------------
    cfg = load_config()
    wallet = (cfg.get("wallet") or {})
    wallet_addr = wallet.get("address")
    api_base = args.api_base or cfg.get("api_base", "https://api.xenarch.dev")

    print(f"Platform: {api_base}")
    print(f"Wallet:   {wallet_addr or '(none in config)'}")
    print(f"Session:  {'present' if cfg.get('session_token') else 'MISSING'}")
    if wallet.get("type") and wallet.get("type") != "local":
        print(f"Note:     wallet type is {wallet['type']!r} — no local signing key, "
              "create will be skipped.")
    print()

    try:
        mc = MerchantClient.from_config(config_dir=None)
    except SessionExpiredError as exc:
        print(f"[{FAIL}] no session — run `xenarch agent login` first ({exc})")
        return 1

    if args.api_base:  # rebuild against the override
        mc = MerchantClient(
            mc._transport.session_token,
            private_key=mc._transport.private_key,
            api_base=args.api_base,
        )

    print("── Read-only merchant surface ──")
    step("profile.show()", lambda: _show(mc.profile.show(), "profile"))
    step("links.list(limit=5)", lambda: _show_count(mc.links.list(limit=5), "links"))
    step("payments.list(limit=5)",
         lambda: _show_count(mc.payments.list(limit=5), "payments"))
    step("subscribers.list(limit=5)",
         lambda: _show_count(mc.subscribers.list(limit=5), "subscribers"))
    step("links.schema()", lambda: _show_schema(mc.links.schema()))

    # confirm-gate sanity: refused before any signing/network, so it runs
    # regardless of wallet type.
    print("\n── Confirm gate ──")
    step("create without confirm is refused (ConfirmationRequired)",
         lambda: _expect_confirm_block(mc, _MINIMAL_PARAMS(wallet_addr or
                "0x0000000000000000000000000000000000000001", args.amount)))

    # --- create → get → revoke (the signing-parity proof) -----------------
    can_sign = mc._transport.private_key and wallet_addr
    if not can_sign:
        print(f"\n[{SKIP}] create/get/revoke — no local signing key in config")
        return _report()

    params = _MINIMAL_PARAMS(wallet_addr, args.amount)

    print("\n── Validate → sign → create (signing parity) ──")
    step("links.validate(params)", lambda: _show_validate(mc.links.validate(params)))

    created = step(
        "links.create(confirm=True)  ← platform verifies the EIP-712 signature",
        lambda: _show_create(mc.links.create(params, confirm=True)),
    )
    if not created:
        print("\nCreate failed — if it's a signature error, signing parity is broken.")
        return _report()

    link_id = created["link_id"]
    secret = created.get("webhook_secret", "")

    step(f"links.get({link_id})", lambda: _show(mc.links.get(link_id), "detail",
                                                keys=("link_id", "status", "kind")))

    # webhook secret round-trip: prove the returned whsec_* verifies
    if secret:
        step("webhooks.verify() round-trip on returned secret",
             lambda: _verify_webhook(secret))

    if args.keep:
        print(f"\n[{SKIP}] revoke — --keep set. Test link left live: {created.get('link')}")
    else:
        step(f"links.revoke({link_id}, confirm=True)",
             lambda: mc.links.revoke(link_id, confirm=True) or True)

    return _report()


# --- helpers ---------------------------------------------------------------


def _MINIMAL_PARAMS(addr: str, amount: str) -> dict:
    """A minimal valid one-time checkout link template."""
    return {
        "to":       {"state": "lit", "value": addr},
        "amount":   {"state": "lit", "value": amount},
        "currency": {"state": "lit", "value": "USDC"},
        "network":  {"state": "lit", "value": "base"},
        "kind":     {"state": "lit", "value": "checkout"},
    }


# --- pretty-printers -------------------------------------------------------


def _show(obj, label, keys=None):
    if obj is None:
        print(f"         {label}: none set")
        return obj
    if keys:
        shown = {k: obj.get(k) for k in keys if isinstance(obj, dict)}
        print(f"         {label}: {shown}")
    else:
        print(f"         {label}: {_truncate(obj)}")
    return obj


def _show_count(resp, label):
    items = resp.get(label, resp.get("data", []))
    more = resp.get("has_more")
    print(f"         {len(items)} {label}"
          + (f" (has_more={more})" if more is not None else ""))
    return resp


def _show_schema(resp):
    fields = resp.get("fields", [])
    print(f"         schema: {len(fields)} fields, version={resp.get('version')}")
    return resp


def _show_validate(resp):
    print(f"         ok={resp.get('ok')} "
          f"missing={len(resp.get('missing', []))} "
          f"errors={len(resp.get('errors', []))}")
    if not resp.get("ok"):
        for issue in resp.get("missing", []) + resp.get("errors", []):
            print(f"           - {issue.get('field')}: {issue.get('message')}")
    return resp


def _show_create(resp):
    print(f"         link_id={resp.get('link_id')}")
    print(f"         link={resp.get('link')}")
    print(f"         webhook_secret={'whsec_…' if resp.get('webhook_secret') else 'none'}")
    return resp


def _verify_webhook(secret: str):
    body = b'{"event_type":"payment.received","link_id":"e2e","data":{}}'
    sig = webhooks.compute_signature(body, secret)
    if not webhooks.verify(body, sig, secret):
        raise AssertionError("verify() rejected a signature it just computed")
    if webhooks.verify(body, sig, "whsec_wrong"):
        raise AssertionError("verify() accepted a wrong secret")
    return True


def _expect_confirm_block(mc, params):
    from xenarch.merchant import ConfirmationRequired
    try:
        mc.links.create(params)  # no confirm=True
    except ConfirmationRequired:
        return True
    raise AssertionError("create() should have raised ConfirmationRequired")


def _truncate(obj, n=200):
    s = str(obj)
    return s if len(s) <= n else s[:n] + "…"


def _report() -> int:
    print(f"\n{'─'*48}\nE2E: {_passed} passed, {_failed} failed")
    return 0 if _failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

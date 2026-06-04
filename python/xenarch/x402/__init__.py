"""``xenarch.x402`` — the pure-protocol buyer surface.

Pay for any HTTP 402-gated resource on the open web — the seller never has to
have heard of Xenarch. This namespace gathers the pay-side primitives that
already shipped at the package root; importing them here makes the
buyer ⇄ merchant split explicit (``xenarch.x402.*`` pays, ``xenarch.merchant.*``
gets paid).

    from xenarch.x402 import XenarchPayer

    payer = XenarchPayer(private_key="0x...")
    result = payer.pay(url)            # sync; use payer.pay_async(url) in async code

The agent wallet only ever holds USDC — payments are gasless, no gas coin
needed.

Framework adapters (LangChain, CrewAI, AutoGen, LangGraph) live under
``xenarch.tools`` and wrap ``XenarchPayer`` for each agent framework.
"""
from __future__ import annotations


def __getattr__(name: str):
    # Lazy so importing the namespace doesn't pull httpx / the x402 extra
    # unless the buyer surface is actually used.
    if name in {"XenarchPayer",}:
        from xenarch._payer import XenarchPayer

        return XenarchPayer
    if name == "XenarchClient":
        from xenarch.client import XenarchClient

        return XenarchClient
    if name == "XenarchAPIError":
        from xenarch.client import XenarchAPIError

        return XenarchAPIError
    raise AttributeError(f"module 'xenarch.x402' has no attribute {name!r}")


__all__ = ["XenarchPayer", "XenarchClient", "XenarchAPIError"]

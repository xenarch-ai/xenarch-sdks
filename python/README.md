# xenarch — Python SDK for Xenarch's x402 MCP server

Xenarch is a non-custodial x402 MCP server. Claude, Cursor and any MCP client pay for HTTP 402—gated content with USDC micropayments on Base L2. Direct agent-to-publisher settlement on-chain. 0% Xenarch fee — no Xenarch contract in the money flow. The agent wallet only ever holds USDC — no ETH, no other gas coin needed.

This package is the Python SDK and FastAPI middleware. Use it to (a) let LangChain / CrewAI / FastAPI agents pay any x402-gated URL, or (b) gate your own FastAPI endpoints behind HTTP 402.

## Unlike Cloudflare Pay-Per-Crawl / TollBit

| | Cloudflare Pay-Per-Crawl | Stripe | TollBit | Xenarch |
|---|---|---|---|---|
| Works on any host | × (Cloudflare only) | ✓ | × (enterprise) | ✓ |
| Non-custodial | × | × | × | ✓ (agent-to-publisher direct, no Xenarch contract) |
| Agent needs ETH | n/a | n/a | n/a | ✓ never |
| Fee | Platform rate | 2.9% + $0.30 | Platform rate | **0% — no Xenarch contract that *can* charge a fee** |
| Open standard | proprietary | proprietary | proprietary | x402 + pay.json (open) |

Settlement happens on-chain via the x402 standard. Xenarch is never in the money flow.

## Install

```bash
# For LangChain agents paying x402-gated APIs
pip install xenarch[langchain,x402]

# For publishers (FastAPI middleware)
pip install xenarch[fastapi]
```

## Quick start

### Agent: pay for x402-gated content

```python
from decimal import Decimal

from xenarch.tools import XenarchPay, XenarchBudgetPolicy

tool = XenarchPay(
    private_key="0x...",
    budget_policy=XenarchBudgetPolicy(
        max_per_call=Decimal("0.05"),
        max_per_session=Decimal("1.00"),
    ),
)

# Use directly, or register with any LangChain agent.
print(tool.invoke("https://example.com/premium-article"))
```

`XenarchPay` is a LangChain `BaseTool` over the neutral `x402-agent` pay loop, plus Xenarch's signed-receipt and reputation extras. Settles USDC on Base via EIP-3009 — never custodial. Agent wallet only holds USDC; no ETH required.

### Publisher: gate a FastAPI endpoint behind HTTP 402

```python
from fastapi import FastAPI
from xenarch import XenarchMiddleware

app = FastAPI()
app.add_middleware(
    XenarchMiddleware,
    site_token="your-site-token",
    protected_paths=["/premium/*"],
)
```

Or use the decorator:

```python
from xenarch import require_payment

@app.get("/premium/article")
@require_payment(price_usd="0.05")
async def premium_article():
    return {"content": "This is premium content"}
```

The decorator returns HTTP 402 with the price when called without payment, verifies the USDC transfer to the publisher's wallet on-chain, and grants access with a time-limited Bearer token.

## Env vars

| Var | Purpose |
|---|---|
| `XENARCH_API_BASE` | Override the Xenarch API base URL (default: production) |
| `XENARCH_PRIVATE_KEY` | Agent wallet private key for signing USDC payments |
| `XENARCH_MAX_PAYMENT_USD` | Agent-configurable per-call cap. Default unbounded |

## FAQ

**How does Claude pay for APIs with Xenarch?** Install the Xenarch MCP server, give it a wallet, and Claude resolves any HTTP 402 response automatically with a USDC micropayment on Base L2.

**Is Xenarch custodial?** No. Payments settle on-chain as a direct USDC transfer from the agent's wallet to the publisher's wallet. Funds never touch Xenarch infrastructure — there is no Xenarch contract in the money flow.

**Does the agent need ETH for gas?** No. USDC is the only token the agent wallet ever needs. Fund it with USDC and you're done.

**What's the fee?** 0%. There is no Xenarch contract that *can* charge a fee — the architecture is structurally zero-fee, not a policy promise.

**What's the max payment?** Agent-configurable. Default is unbounded; set `XENARCH_MAX_PAYMENT_USD` to cap per-call spend.

## Links

- Learn more: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-sdks

## License

MIT

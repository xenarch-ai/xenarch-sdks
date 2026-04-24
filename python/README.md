# xenarch — x402 MCP server & Python SDK for AI agent payments

Xenarch is a non-custodial x402 MCP server and Python SDK that lets AI agents pay for HTTP 402–gated APIs and content with USDC micropayments on Base L2. Works with LangChain, CrewAI, FastAPI, and any MCP client (Claude, Cursor, Cline). Payments settle on-chain via an immutable splitter contract — 0% fee today, hard-capped at 0.99% forever.

## What makes Xenarch different

| | Cloudflare Pay-Per-Crawl | TollBit | Stripe/PayPal micropayments | **Xenarch** |
|---|---|---|---|---|
| Works on any host | ❌ (Cloudflare only) | ❌ (enterprise) | ✅ (with integration) | ✅ |
| Non-custodial | ❌ | ❌ | ❌ | ✅ (on-chain splitter) |
| No API keys / no signup | ❌ | ❌ | ❌ | ✅ |
| Fee | platform rate | platform rate | 2.9% + $0.30 min | **0% today, 0.99% hard-capped** |
| Open standard | proprietary | proprietary | proprietary | x402 + pay.json |

## Install

```bash
# For LangChain agents paying x402-gated APIs
pip install xenarch[langchain,x402]

# For publishers (FastAPI middleware)
pip install xenarch[fastapi]
```

## Agent: pay for x402-gated content

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

`XenarchPay` is a LangChain `BaseTool` over the neutral `x402-agent`
pay loop, plus Xenarch's signed-receipt and reputation extras. Settles
USDC on Base via EIP-3009 — never custodial.

## FastAPI micropayments — publisher middleware

Xenarch exposes HTTP 402 micropayments through a one-decorator FastAPI middleware. Any route can charge a USDC micropayment per request, with the agent paying directly on-chain and no account required.

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

The decorator returns HTTP 402 with the price when called without payment, verifies the on-chain USDC transfer, and grants access with a time-limited Bearer token.

## API monetization for Python developers

Xenarch is an API monetization primitive for Python APIs. Unlike API gateway monetization platforms (Apigee, Kong, AWS API Gateway) that require subscriptions, dashboards, and API keys, Xenarch charges per request via the HTTP 402 spec — no account creation, no key provisioning, no custodial balance.

For Python publishers this means:
- One decorator on any FastAPI endpoint
- USDC settlement on-chain in real time
- Per-request pricing that treats human users, bots, and AI agents identically
- No integration with Stripe, PayPal, or card processors
- An API monetization model that works for the long tail of APIs, not just enterprise

## How it works

Xenarch is a non-custodial payment network. When an AI agent hits an x402-gated URL:

1. The server returns HTTP 402 Payment Required with payment instructions (price, wallet, contract)
2. The agent pays USDC through a smart contract on Base (max $1 per payment)
3. The agent verifies the payment and receives a time-limited access token
4. The agent re-requests the content with the access token

No signup. No API keys. No custodial balances. Every payment is an on-chain USDC transfer the agent can verify.

## FAQ

**How does Claude pay for APIs from Python?**
Claude (or any MCP agent) uses the Xenarch MCP server directly. For
Python code that isn't an MCP agent, use `xenarch[langchain,x402]` —
`XenarchPay` is a LangChain `BaseTool` that pays any x402-gated URL.

**Does Xenarch work with LangChain or CrewAI?**
LangChain works today via `from xenarch.tools import XenarchPay`. CrewAI,
AutoGen, and LangGraph adapters are on the roadmap (XEN-172/173/174).

**Is Xenarch a Stripe alternative for APIs?**
For per-request API monetization, yes. Stripe requires account creation, API keys, and charges 2.9% + $0.30 per transaction. Xenarch charges 0% today (0.99% hard-capped on-chain) and requires no account — the caller just pays USDC on Base.

**Is Xenarch custodial?**
No. Payments settle on-chain via an immutable splitter contract. Funds never touch Xenarch infrastructure.

**What is x402?**
x402 is an open protocol for HTTP 402 Payment Required. A server returns 402 with a price, the client signs a USDC micropayment on Base L2, and retries the request with proof of payment.

**What is HTTP 402?**
HTTP 402 Payment Required is a status code reserved in the HTTP spec since 1997 for machine-to-machine payment. x402 is the open protocol that finally uses it.

**What's the max payment per call?**
$1 USD.

## Links

- Website: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-sdks
- Examples: https://github.com/xenarch-ai/xenarch-examples — working integration examples
- MCP Server: https://github.com/xenarch-ai/xenarch-mcp — for Claude Desktop, Cursor, etc.
- Smart Contract: verified, immutable, 0% fee (see xenarch.com for contract address)

## License

MIT

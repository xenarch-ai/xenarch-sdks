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
# For AI agents (wallet + on-chain payments)
pip install xenarch[agent]

# For LangChain agents
pip install xenarch[agent,langchain]

# For CrewAI agents
pip install xenarch[agent,crewai]

# For publishers (FastAPI middleware)
pip install xenarch[fastapi]
```

## Agent: pay for gated content

```python
from xenarch.agent_client import check_gate, verify_payment
from xenarch.wallet import load_wallet_or_create
from xenarch.payment import execute_payment

# Auto-creates wallet on first run (saved to ~/.xenarch/wallet.json)
wallet = load_wallet_or_create()

# 1. Check if a URL is gated
gate = check_gate("https://example.com/premium-article")
if gate:
    # 2. Pay via USDC on Base (max $1 per payment)
    result = execute_payment(
        wallet=wallet,
        splitter_address=gate.splitter,
        collector_address=gate.collector,
        price_usd=gate.price_usd,
    )
    # 3. Verify payment, get access token
    access = verify_payment(gate.verify_url, result.tx_hash)
    print(f"Access token: {access['access_token']}")
```

## LangChain integration

```python
from xenarch.tools.langchain import CheckGateTool, PayTool, GetHistoryTool

tools = [CheckGateTool(), PayTool(), GetHistoryTool()]

# Use with any LangChain agent
from langchain.agents import initialize_agent
agent = initialize_agent(tools=tools, llm=llm, agent="zero-shot-react-description")
agent.run("Check if example.com has a paywall and pay for access if needed")
```

## CrewAI integration

```python
from xenarch.tools.crewai import check_gate, pay, get_history
from crewai import Agent

researcher = Agent(
    role="Web Researcher",
    tools=[check_gate, pay, get_history],
    goal="Access premium content by paying micropayments when needed",
)
```

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

## Wallet management

On first use, `load_wallet_or_create()` generates a wallet automatically and saves it to `~/.xenarch/wallet.json`. No signup, no API key.

To fund your wallet, send USDC and a small amount of ETH (for gas) to your wallet address on Base.

You can also configure via environment variables:

```bash
export XENARCH_PRIVATE_KEY=0x...     # Wallet private key
export XENARCH_RPC_URL=...           # Base RPC (default: https://mainnet.base.org)
export XENARCH_API_BASE=...          # API base (default: https://api.xenarch.dev)
export XENARCH_NETWORK=base          # base or base-sepolia
```

## How it works

Xenarch is a non-custodial payment network. When an AI agent hits an x402-gated URL:

1. The server returns HTTP 402 Payment Required with payment instructions (price, wallet, contract)
2. The agent pays USDC through a smart contract on Base (max $1 per payment)
3. The agent verifies the payment and receives a time-limited access token
4. The agent re-requests the content with the access token

No signup. No API keys. No custodial balances. Every payment is an on-chain USDC transfer the agent can verify.

## FAQ

**How does Claude pay for APIs from Python?**
Claude (or any MCP agent) uses the Xenarch MCP server directly. For Python code that isn't an MCP agent, use `xenarch[agent]` — `load_wallet_or_create()` + `execute_payment()` — to pay any x402-gated URL.

**Does Xenarch work with LangChain or CrewAI?**
Yes. Import `xenarch.tools.langchain` or `xenarch.tools.crewai` and register the provided tools (`check_gate`, `pay`, `get_history`) with your agent.

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

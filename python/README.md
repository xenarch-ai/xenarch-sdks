# xenarch

Python SDK for [Xenarch](https://xenarch.dev), the payment network for AI agents. Pay for any x402-gated content or API with USDC micropayments on Base.

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

## Publisher: gate your content

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

1. The server returns HTTP 402 with payment instructions (price, wallet, contract)
2. The agent pays USDC through a smart contract on Base (max $1 per payment)
3. The agent verifies the payment and receives a time-limited access token
4. The agent re-requests the content with the access token

No signup. No API keys. No custodial balances. Every payment is an on-chain USDC transfer the agent can verify.

## Links

- [Xenarch](https://xenarch.dev)
- [GitHub](https://github.com/xenarch-ai/xenarch-sdks)
- [MCP Server](https://github.com/xenarch-ai/xenarch-mcp) (for Claude Desktop, Cursor, etc.)
- [Smart Contract](https://basescan.org/address/0x...) (verified, immutable, 0% fee)

## License

MIT

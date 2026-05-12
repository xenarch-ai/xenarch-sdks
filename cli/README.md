# xenarch — CLI for Xenarch's x402 MCP server

Xenarch is a non-custodial x402 MCP server. Claude, Cursor and any MCP client pay for HTTP 402–gated content with USDC micropayments on Base L2. Direct agent-to-publisher settlement on-chain. 0% Xenarch fee. The agent wallet only ever holds USDC — no ETH, no gas coin needed.

This package is the `xenarch` command-line tool. Use it from a terminal to manage an agent wallet, pay x402-gated URLs by hand, and (for publishers) register sites and check stats against the Xenarch API.

## What it does

Agent commands:

- `xenarch wallet` — create / inspect / export the local agent wallet
- `xenarch check <url>` — probe a URL for an x402 challenge without paying
- `xenarch pay <url>` — pay an x402-gated URL with USDC on Base L2 and fetch the content
- `xenarch history` — list past payments made from this wallet

Publisher commands:

- `xenarch login` / `xenarch register` — authenticate with the Xenarch API
- `xenarch site-add` / `xenarch sites` — register and list publisher sites
- `xenarch stats` — view per-site payment stats
- `xenarch payout` — manage payout settings

Global flags: `--json` for machine-readable output, `--api-base` to override the API URL, `--rpc-url` to override the Base RPC endpoint.

## Install

```bash
npm install -g xenarch
```

Requires Node.js 18 or later.

## Quick start

```bash
# Create an agent wallet (stored locally)
xenarch wallet create

# See what an x402-gated URL would charge
xenarch check https://example.com/premium-article

# Pay and fetch in one step
xenarch pay https://example.com/premium-article

# List your payment history
xenarch history --json
```

Set `XENARCH_PRIVATE_KEY` to use an existing wallet instead of the local one, and `XENARCH_MAX_PAYMENT_USD` to cap per-call spend (default unbounded).

## Links

- Learn more: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-sdks
- MCP server (for Claude Desktop, Cursor, Cline): [`@xenarch/agent-mcp`](https://www.npmjs.com/package/@xenarch/agent-mcp)

Learn more: https://xenarch.com

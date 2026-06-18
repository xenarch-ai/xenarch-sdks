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

## Paying anything that speaks x402

`xenarch pay <url>` works against **any** x402 endpoint, not just Xenarch's. If a URL returns a standard x402 `402` with payment requirements, the CLI signs an EIP-3009 USDC voucher and settles it — a universal x402 client. It pays whatever the seller gates that way: an **API call, content, metered usage, or a one-time invoice/checkout**.

Two boundaries:

- **x402 only.** It pays the x402 protocol, not other payment schemes — a Stripe-link / MPP invoice, for example, won't be paid.
- **One-time only.** A single `pay` is one payment. Recurring **subscriptions** are a Xenarch-platform feature (permit / reminder pay-links), not something the CLI sets up against third parties.

**0% fee and gasless apply only to Xenarch.** On a non-Xenarch endpoint, that server and its own settlement provider set the fees and pay the gas — Xenarch guarantees nothing there (not gaslessness, fees, or uptime). The "no ETH / no gas, 0% Xenarch fee" experience holds only when the gate is part of the Xenarch platform, where invoices, checkouts and subscriptions are first-class pay-link types.

## Agent control plane (required to pay)

**`XENARCH_API_TOKEN` is required.** Autonomous agent payments are meant to be capped, so the CLI **refuses to pay without it** — an unlinked agent has no caps or scope. Create an `xa_live_*` token from the Xenarch dashboard at https://dash.xenarch.dev/agent/settings (or run `xenarch agent login`) and set it as the `XENARCH_API_TOKEN` env var. Every `xenarch pay` then:

1. **Preflight** with the platform — server-enforced caps (per-tx, daily, monthly), scope rules (allow/deny domain patterns), and a fleet-wide kill switch. Refused payments stop before any USDC is signed.
2. **Settle** on chain via a third-party x402 settlement provider (PayAI, xpay, Heurist, etc.) — same as before.
3. **Report the receipt** back to the dashboard so you see spend, hit counters, and refusal audits in one place.

```bash
export XENARCH_API_TOKEN=xa_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
xenarch pay https://example.com/premium-article
```

Without the env var, the CLI refuses to pay (fail-closed) — set the token so payments are capped. Network failures during receipt POST queue offline at `~/.xenarch/receipts-queue.jsonl` and retry on next invocation.

### What refusals look like

When the control plane refuses a payment, the CLI prints the reason and exits with code 1. No USDC is signed and no transaction is sent.

```
$ xenarch pay https://api.openai.com/v1/chat
Refused by Xenarch control plane: daily cap exceeded ($1.00 spent of $1.00). Resets in 18h 22m.
Edit cap at https://dash.xenarch.dev/agent/caps
```

```
$ xenarch pay https://api.openai.com/v1/audio/speech
Refused by Xenarch control plane: per-transaction cap exceeded (max $0.50).
Raise the cap at https://dash.xenarch.dev/agent/caps
```

```
$ xenarch pay https://api.scammer.com/x
Refused by Xenarch control plane: scope rule '*.scammer.com' ("phish") matched this URL.
Edit rules at https://dash.xenarch.dev/agent/scope
```

```
$ xenarch pay https://example.com/anything
Refused by Xenarch control plane: agent is paused.
Toggle the kill switch off at https://dash.xenarch.dev/agent/scope
```

If the platform itself is unreachable (control plane down, network error), the CLI fails closed: refuses to pay rather than risk bypassing a cap or kill switch you configured. Brief platform outages briefly stall payments; the fail-closed default protects budgets over throughput.

## Links

- Learn more: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-sdks
- MCP server (for Claude Desktop, Cursor, Cline): [`@xenarch/agent-mcp`](https://www.npmjs.com/package/@xenarch/agent-mcp)

Learn more: https://xenarch.com

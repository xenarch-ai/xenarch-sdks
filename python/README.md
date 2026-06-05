# xenarch — Python SDK for the agentic internet

Xenarch is the non-custodial payment SDK for the agentic internet. Pay for and get paid through HTTP 402 + USDC micropayments on Base L2. Direct, on-chain settlement. 0% Xenarch fee — no Xenarch contract in the money flow. Gasless: the wallet only ever holds USDC — no other gas coin needed.

One package, two sides of the market — for both humans in scripts and AI agents in workflows:

- **`xenarch.x402`** — *pay* any HTTP 402-gated resource on the open web (pure protocol; the seller never has to have heard of Xenarch).
- **`xenarch.merchant`** — *get paid*: create and manage pay-links, read payments and subscribers, manage your merchant profile.
- **`xenarch.webhooks`** — verify incoming webhook signatures on your backend.

Plus FastAPI middleware to gate your own endpoints behind HTTP 402.

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

### Agent control plane (optional)

If you've created an `xa_live_*` token from https://dash.xenarch.dev/agent/settings, set it as `XENARCH_API_TOKEN` (or pass `xenarch_token=...` to `XenarchPay`). Every `pay()` then:

1. **Preflights** with the platform — server-enforced caps (per-tx, daily, monthly), scope rules (allow/deny domain patterns), and a fleet-wide kill switch. Refused payments stop before any USDC is signed.
2. **Settles** the USDC payment on Base — gasless, no gas coin needed.
3. **Reports the receipt** back to the dashboard.
4. **On settle failure** (settlement unavailable, replay rejected by the gate), POSTs a `status='failed'` receipt with the preflight's auth_token so the platform refunds the cap charge. Operators don't lose budget for payments that didn't land.

```bash
export XENARCH_API_TOKEN=xa_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Reporting is fire-and-forget; network failures are queued in-memory and retried on the next payment. Without the env var, the SDK behaves as before — no preflight, no receipt reporting.

#### What refusals look like

`pay()` returns a dict. When the control plane refuses, the dict has an `error` key with a `control_plane_*` value and a `hint` URL pointing at the dashboard:

```python
result = tool.invoke("https://api.openai.com/v1/chat")
# {'error': 'control_plane_daily_cap',
#  'reason': 'daily_cap',
#  'url': 'https://api.openai.com/v1/chat',
#  'cap_daily': '1.0000',
#  'remaining_today': '0.0000',
#  'resets_today_at': '2026-05-28T00:00:00Z',
#  'hint': 'Raise or reset the daily cap at https://dash.xenarch.dev/agent/caps'}
```

Other refusal shapes:

| `error` | `reason` | When |
|---|---|---|
| `control_plane_per_tx_cap` | `per_tx_cap` | Single payment exceeds per-tx cap |
| `control_plane_daily_cap` | `daily_cap` | Daily cap exhausted; payload includes `cap_daily`, `remaining_today`, `resets_today_at` |
| `control_plane_monthly_cap` | `monthly_cap` | Monthly cap exhausted; payload includes `cap_monthly`, `remaining_month`, `resets_month_at` |
| `control_plane_scope_denied` | `scope` | URL matched a deny rule (or didn't match an allow rule under deny-by-default); payload includes `matched_rule` |
| `control_plane_paused` | `paused` | Kill switch is on |
| `control_plane_unreachable` | n/a | Network / platform error; `detail` includes the kind. Fail-closed — no payment made |

If the gate publishes a malformed `pay.json` (some WordPress plugin versions emit empty `receiver` / `seller_wallet` fields), the SDK refuses with `error='pay_json_invalid'` before even reaching preflight. Pass `discover_via_pay_json=False` to skip the pre-check and go straight to the gate's 402 response:

```python
tool = XenarchPay(
    private_key="0x...",
    xenarch_token="xa_live_...",
    discover_via_pay_json=False,  # bypass pay.json optimization
)
```

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

## Get paid: `xenarch.merchant`

Everything the dashboard does — callable from a script or an AI agent. Merchant ops reuse the SIWE session you establish with the CLI (`xenarch agent login`); creating a pay-link signs the link template with your wallet.

```python
from xenarch.merchant import MerchantClient

# Reuse the CLI's logged-in session + wallet from ~/.xenarch/config.json
mc = MerchantClient.from_config()
# ...or pass credentials explicitly:
# mc = MerchantClient(session_token="...", private_key="0x...")

# Read-only ops need no signing key
links = mc.links.list(limit=10)
payments = mc.payments.list(limit=20)
subs = mc.subscribers.list(status="active")
profile = mc.profile.show()
```

### Create a pay-link (validate → sign → create)

```python
params = {
    "to":       {"state": "lit", "value": "0xYourWallet..."},
    "amount":   {"state": "lit", "value": "50.00"},
    "currency": {"state": "lit", "value": "USDC"},
    "network":  {"state": "lit", "value": "base"},
    "kind":     {"state": "lit", "value": "checkout"},
    # ...plus any other fields from mc.links.schema()
}

# Check before signing — returns {ok, missing, errors} with field-level prompts
mc.links.validate(params)

# Signing commits your wallet to the terms, so it's confirm-gated:
link = mc.links.create(params, confirm=True)
print(link["link"])            # the hosted checkout URL
secret = link["webhook_secret"]  # shown once — store it now

mc.links.revoke(link["link_id"], confirm=True)
```

`create` always validates first, so "validate ok ⇒ create ok". An `Idempotency-Key` is generated per create, which dedupes a network-level retry of that one request (re-running `create` mints a fresh nonce, so it makes a new link).

Signing and revoking require `confirm=True` by default — a guard against a stray agent call committing funds or killing a live link. Trusted scripts can opt out once with `MerchantClient(..., require_confirm=False)`.

## Verify webhooks: `xenarch.webhooks`

Both **pay-links** and **agents** POST events to your server. Each delivery is signed with a Stripe-style timestamped signature:

```
X-Xenarch-Signature: t=<unix_seconds>,v1=<hex>     # v1 = HMAC_SHA256(secret, "<t>.<raw_body>")
X-Xenarch-Event:     <event_type>                  # payment.confirmed, cap.exceeded, ...
X-Xenarch-Delivery:  <uuid>                         # idempotency key — dedupe retries on this
```

Signing the timestamp makes a captured delivery un-replayable: `verify` rejects any request whose `t` is more than 5 minutes (default) from now. `verify` works for **either** surface — one call.

```python
from xenarch import webhooks

@app.post("/xenarch-webhook")            # FastAPI
async def hook(request):
    body = await request.body()             # raw bytes — don't re-serialize
    sig = request.headers["X-Xenarch-Signature"]
    if not webhooks.verify(body, sig, secret):
        return Response(status_code=401)
    event = json.loads(body)                # event["event_type"] tells you which
    ...
```

The `secret` is the pay-link's `whsec_...` (from link create / the dashboard webhook card) or the agent's `whsec_...` (rotate it on `/agent/settings`). Tune the replay window with `webhooks.verify(body, sig, secret, tolerance_seconds=600)`.

### Event taxonomy

| Surface | Events |
|---|---|
| Pay-link | `payment.confirmed`, `payment.underpaid`, `payment.overpaid`, `subscription.renewed` |
| Agent | `payment.confirmed`, `cap.exceeded`, `scope.denied`, `key.rotated` |

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

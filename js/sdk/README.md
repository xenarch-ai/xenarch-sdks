# @xenarch/sdk — TypeScript SDK for the agentic internet

Isomorphic TypeScript/JavaScript SDK for Xenarch. Pay for and get paid through HTTP 402 + USDC micropayments on Base L2. Direct, on-chain settlement. 0% Xenarch fee. Gasless: the wallet only ever holds USDC — no other gas coin needed.

One package, two sides of the market — for both human devs and AI agents:

- **`sdk.x402`** — *pay* any HTTP 402-gated resource on the open web (pure protocol; the seller never has to have heard of Xenarch).
- **`sdk.merchant`** — *get paid*: pay-links, **metered usage**, payments, subscribers, orders, services, assets, earnings, and your merchant profile.
- **`sdk.agent`** — the agent control plane: spend caps, scope rules, API keys, receipts.
- **`sdk.info`** — unauthenticated public reads: receipts, reputation, USDC/USD rate, wallet whois.
- **`sdk.webhooks`** — verify incoming webhook signatures on your backend.

Runs on Node, Bun, Deno, and edge runtimes (Cloudflare Workers, Vercel Edge) — it's just `fetch` + Web Crypto + [viem](https://viem.sh).

## Install

```bash
npm i @xenarch/sdk
```

## Quick start

```ts
import { createXenarch } from "@xenarch/sdk";

// Explicit credentials...
const sdk = createXenarch({ sessionToken, privateKey });

// ...or reuse the CLI's logged-in session + wallet (Node only):
// const sdk = await Xenarch.fromConfig();
```

`sessionToken` is the SIWE session from `xenarch agent login` (the `xen_session` cookie). `privateKey` is the merchant/agent wallet key — needed only for signing (`links.create`) and paying (`x402.pay`); read-only ops work without it.

## Get paid: `sdk.merchant`

```ts
const links = await sdk.merchant.links.list({ limit: 10 });
const payments = await sdk.merchant.payments.list({ limit: 20 });
const subs = await sdk.merchant.subscribers.list({ status: "active" });
const profile = await sdk.merchant.profile.show();
```

### Create a pay-link (validate → sign → create)

```ts
const params = {
  to:       { state: "lit", value: "0xYourWallet..." },
  amount:   { state: "lit", value: "50.00" },
  currency: { state: "lit", value: "USDC" },
  network:  { state: "lit", value: "base" },
  kind:     { state: "lit", value: "checkout" },
  // ...plus any other fields from sdk.merchant.links.schema()
};

// Check before signing — returns { ok, missing, errors } with field-level prompts
await sdk.merchant.links.validate(params);

// Signing commits your wallet to the terms, so it's confirm-gated:
const link = await sdk.merchant.links.create(params, { confirm: true });
console.log(link.link);            // hosted checkout URL
const secret = link.webhook_secret; // shown once — store it now

await sdk.merchant.links.revoke(link.link_id, { confirm: true });
```

`create` always validates first, so "validate ok ⇒ create ok". It throws `PayLinkValidationError` (with `.missing` / `.errors`) when the params are incomplete. An `Idempotency-Key` is generated per create (dedupes a network-level retry of that one request).

Signing and revoking require `{ confirm: true }` by default — a guard against a stray agent call committing funds or killing a live link. Trusted scripts can opt out once with `createXenarch({ ..., requireConfirm: false })`.

### Metered subscriptions (usage-based billing)

For a per-unit metered subscription where **you count usage yourself** (the
`merchant_reported` source), report increments as they happen. Usage reporting
authenticates with the **link's `webhook_secret`** — not your merchant session —
so a thin reporting service in your backend only needs the secret:

```ts
// One client per reporting service; no privateKey/session needed for reporting.
const sdk = createXenarch();

// Each subscriber signs ONE spending-cap permit at signup (hosted checkout),
// which gives you their `subscription_id`. Report usage increments against it:
await sdk.merchant.usage.report(
  linkId,
  {
    subscriptionId,            // the subscriber's id
    units: 1,                  // a positive INCREMENT (e.g. calls), not a running total
    idempotencyKey: callId,    // stable per increment → retries dedupe to a no-op
  },
  { secret: webhookSecret },   // the link's whsec_... from links.create
);
```

Xenarch accrues the units and books a charge against the signed permit when the
billing threshold is crossed. Settle the booked charges on-chain (you broadcast
the `transferFrom`; Xenarch never moves money):

```ts
const { collectable } = await sdk.merchant.subscribers.meteredCollectable();
// → each row has { transfer_from: { owner, spender, value }, ... } to settle.
// After broadcasting the USDC.transferFrom tx, record it:
await sdk.merchant.subscribers.meteredCollect(subscriptionId, { txHash });
```

## Agent control plane: `sdk.agent`

```ts
await sdk.agent.setCaps({ /* per-tx / per-day spend caps */ });
await sdk.agent.setScope("deny", [{ /* allow/deny rules */ }]);
const key = await sdk.agent.keys.create("ci-bot");  // plaintext secret returned once
await sdk.agent.setPaused(true);                     // emergency stop
```

## Pay: `sdk.x402`

```ts
// Pay any 402-gated URL and get the unlocked response
const { txHash, response } = await sdk.x402.pay("https://example.com/paywalled");
const data = await response.json();

// Or just inspect the gate without paying
const { gated, gate } = await sdk.x402.checkGate("https://example.com/paywalled");
```

Settles USDC on Base, agent wallet to seller wallet, gasless. The agent wallet only ever holds USDC.

## Verify webhooks: `sdk.webhooks`

Both **pay-links** and **agents** POST events to your server. Each delivery is signed with a Stripe-style timestamped signature:

```
X-Xenarch-Signature: t=<unix_seconds>,v1=<hex>     // v1 = HMAC_SHA256(secret, "<t>.<raw_body>")
X-Xenarch-Event:     <event_type>                  // payment.confirmed, cap.exceeded, ...
X-Xenarch-Delivery:  <uuid>                         // idempotency key — dedupe retries on this
```

Signing the timestamp makes a captured delivery un-replayable: `verify` rejects any request whose `t` is more than 5 minutes (default) from now. `verify` works for **either** surface — one call. Isomorphic (Web Crypto), so it runs on edge too.

```ts
import { webhooks } from "@xenarch/sdk";

// e.g. inside an Express / Hono / Next route handler
const raw = await request.text();                 // raw body, not a parsed object
const sig = request.headers.get("X-Xenarch-Signature");
if (!(await webhooks.verify(raw, sig, secret))) {
  return new Response("bad signature", { status: 401 });
}
const event = JSON.parse(raw);                     // event.event_type tells you which
```

The `secret` is the pay-link's `whsec_...` (from link create / the dashboard webhook card) or the agent's `whsec_...` (rotate it on `/agent/settings`). Tune the replay window with `webhooks.verify(raw, sig, secret, { toleranceSeconds: 600 })`.

### Event taxonomy

| Surface | Events |
|---|---|
| Pay-link | `payment.confirmed`, `payment.underpaid`, `payment.overpaid`, `subscription.renewed` |
| Agent | `payment.confirmed`, `cap.exceeded`, `scope.denied`, `key.rotated` |

## Links

- Learn more: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-sdks
- Python SDK: [`pip install xenarch`](https://pypi.org/project/xenarch/)

## License

MIT

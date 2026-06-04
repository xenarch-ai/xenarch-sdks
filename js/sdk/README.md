# @xenarch/sdk — TypeScript SDK for the agentic internet

Isomorphic TypeScript/JavaScript SDK for Xenarch. Pay for and get paid through HTTP 402 + USDC micropayments on Base L2. Direct, on-chain settlement. 0% Xenarch fee. Gasless: the wallet only ever holds USDC — no other gas coin needed.

One package, two sides of the market — for both human devs and AI agents:

- **`sdk.x402`** — *pay* any HTTP 402-gated resource on the open web (pure protocol; the seller never has to have heard of Xenarch).
- **`sdk.merchant`** — *get paid*: create and manage pay-links, read payments and subscribers, manage your merchant profile.
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

Each pay-link can POST events to your server, signed with `X-Xenarch-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body, keyed by the link's `whsec_...` secret). Verify before trusting the payload — the same shape as Stripe / GitHub webhooks. Isomorphic (Web Crypto), so it runs on edge too.

```ts
import { webhooks } from "@xenarch/sdk";

// e.g. inside a Hono / Next route handler
const raw = await request.text();                 // raw body, not a parsed object
const sig = request.headers.get("X-Xenarch-Signature");
if (!(await webhooks.verify(raw, sig, secret))) {
  return new Response("bad signature", { status: 401 });
}
const event = JSON.parse(raw);
```

## Links

- Learn more: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-sdks
- Python SDK: [`pip install xenarch`](https://pypi.org/project/xenarch/)

## License

MIT

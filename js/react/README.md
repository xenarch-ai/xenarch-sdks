# @xenarch/react

React component for [Xenarch](https://xenarch.com) pay links — drop in a `<XenarchCheckout/>` and you're done.

## Install

```bash
npm install @xenarch/react
```

Peer deps: `react >= 18`, `react-dom >= 18`.

For drop-on-any-page (no React) use cases, see [`@xenarch/embed`](https://www.npmjs.com/package/@xenarch/embed) — it's vanilla JS, zero deps.

## Usage

### Redirect mode (default — safest)

```tsx
import { XenarchCheckout } from "@xenarch/react";

<XenarchCheckout linkId="abc123def456">
  Pay 0.99 USDC
</XenarchCheckout>
```

Renders an `<a>` styled like a button. Click → navigates to `pay.xenarch.com/l/<id>?return_url=<current page>`. After payment, the customer is sent back to your page with `?xenarch_paid=1&link_id=...&tx_hash=...` query params.

### Modal mode

```tsx
<XenarchCheckout
  linkId="abc123def456"
  mode="modal"
  onPaid={({ linkId, txHash, network, token }) => {
    console.log("paid", linkId, txHash, token, network);
    // show your thank-you UI
  }}
  onClose={() => console.log("modal dismissed")}
>
  Pay 0.99 USDC
</XenarchCheckout>
```

Renders a `<button>`. Click → opens a modal overlay containing an iframe of the hosted checkout. The modal auto-closes on payment confirmation; `onPaid` fires with `{linkId, txHash, network, token}`. Backdrop click, X button, and Esc all dismiss.

### Inline mode

```tsx
<XenarchCheckout
  linkId="abc123def456"
  mode="inline"
  inlineHeight="720px"
  onPaid={({ linkId, txHash }) => { /* … */ }}
/>
```

Renders the checkout iframe directly in place, no button wrapper. You set the height; the SDK does not auto-resize the iframe in v1.

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `linkId` | string | required | The pay-link ID (the part after `pay.xenarch.com/l/`). |
| `mode` | `"redirect" \| "modal" \| "inline"` | `"redirect"` | Which surface. |
| `returnUrl` | string | `window.location.href` | After-pay URL for redirect mode. Modal/inline ignore. |
| `onPaid` | `(event) => void` | — | Fires on PAID / CONFIRMED. Modal closes automatically. |
| `onTerminal` | `(event) => void` | — | Fires on UNDERPAID / OVERPAID / EXPIRED / REVOKED. |
| `onClose` | `() => void` | — | Modal only — fires when user dismisses without paying. |
| `inlineHeight` | string \| number | `"min(900px, 80vh)"` | Inline only — iframe height. |
| `className`, `style` | — | — | Pass-through to the rendered element. |
| `children` | ReactNode | `"Pay"` | Button label (redirect/modal). Inline ignores. |

## Event payload

```ts
type XenarchEvent = {
  type:
    | "xenarch:paid"
    | "xenarch:underpaid"
    | "xenarch:overpaid"
    | "xenarch:expired"
    | "xenarch:revoked"
    | "xenarch:close";
  linkId: string;
  txHash?: string;   // present on `xenarch:paid` after on-chain confirmation
  network?: string;  // "base" | "ethereum" | "bnb" | "monad" | "tron"
  token?: string;    // "USDC" | "USDT" (Monad's USDT0 arrives as "USDT")
};
```

A link can take USDC on Base, Ethereum, BNB Chain and Monad, and USDT on Ethereum, BNB Chain, Monad (USDT0) and Tron, as its owner picks. `network` and `token` say which one paid. `xenarch:underpaid` carries them too when the amount arrived short.

## Security

- The component only acts on `postMessage` events whose `event.origin === "https://pay.xenarch.com"`. Messages from other origins are silently ignored.
- The `linkId` on incoming messages must match the prop on the rendered component, so a different iframe on the same page firing events can't trigger callbacks on this one.
- `txHash` is only surfaced when it matches `/^(0x)?[0-9a-fA-F]{64}$/` (Tron hashes carry no `0x`); `network` and `token` only when they are short plain identifiers. The hash is for UX only — for crediting customers or fulfilling orders, verify against your dashboard or a webhook, not the postMessage payload.
- The iframe (modal and inline) is rendered with `allow="clipboard-write https://pay.xenarch.com"`, which grants one permission, to the hosted checkout's origin only. Without it, browsers block the clipboard inside a cross-origin iframe, so the checkout's "Copy" buttons (address, amount, WalletConnect link) silently write nothing. No other permission is granted. Wallet payments over WalletConnect (QR or deep link) need none: they were verified end-to-end from both embed modes on Base mainnet (XEN-690).
- If your page sets a `Permissions-Policy` header, allow `clipboard-write` for `https://pay.xenarch.com` (for example `Permissions-Policy: clipboard-write=(self "https://pay.xenarch.com")`), or the iframe's grant can't take effect.

## Lower-level escape hatches

If the component doesn't fit your shape, the building blocks are exported:

```ts
import {
  buildHostedUrl,           // (linkId, {returnUrl?, embed?}) => string
  attachXenarchListener,    // (linkId, {onPaid, onTerminal, onClose}) => unsubscribe
  isValidLinkId,            // (string) => boolean
  HOSTED_ORIGIN,            // "https://pay.xenarch.com"
} from "@xenarch/react";
```

## Build output

- `dist/index.js` — ESM bundle. React is `external` (peer dep — your bundler dedupes).
- `dist/index.cjs` — CJS bundle. Same external React.
- `dist/index.d.ts` — TypeScript declarations.

## License

MIT

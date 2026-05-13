# @xenarch/embed

Drop-in `<script>` snippet that upgrades any element with `data-xenarch-link` into a Xenarch Pay button. Vanilla JavaScript, no dependencies, no framework, no build step on the merchant side.

## Usage

```html
<script src="https://cdn.xenarch.dev/pay/v1.js" defer></script>

<button data-xenarch-link="JJjIwDyV4N1CG9g8AHMxfdJ9">
  Pay 0.99 USDC
</button>
```

That's it. Click the button → customer is sent to `pay.xenarch.com/l/<id>` with `return_url` pointing back to the merchant page. Pay → auto-returned to the merchant page with success query params.

## Data attributes

| Attribute | Type | Required | Description |
|---|---|---|---|
| `data-xenarch-link` | string | yes | Payment-link ID (the part after `pay.xenarch.com/l/`) |
| `data-xenarch-return-url` | URL | no | Override the auto-detected return URL. Defaults to the current page. |

## After payment

When the customer completes payment, Xenarch redirects them back to your page with these query params:

| Param | Value |
|---|---|
| `xenarch_paid` | `1` |
| `link_id` | the link they paid |
| `tx_hash` | Base L2 transaction hash |

You can show a thank-you page by checking these on load. The signal is **best-effort UX only** — for crediting customers or fulfilling orders, verify against your dashboard or webhook (L16, coming soon).

## CDN versions

- `https://cdn.xenarch.dev/pay/v1.js` — moving pointer, gets non-breaking fixes automatically.
- `https://cdn.xenarch.dev/pay/v1.0.0.js` — frozen version, never changes. Pin if you need byte-stable behavior.

## Spec

See `Information/design/embed-snippet-spec.md` in the main Xenarch repo for the full contract.

## License

MIT

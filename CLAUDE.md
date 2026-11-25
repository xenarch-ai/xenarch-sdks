# xenarch-sdks

SDKs and middleware for integrating with the Xenarch payment network. Polyglot repo with packages for multiple ecosystems.

## Structure

```
js/       — npm packages (TypeScript)
python/   — PyPI packages
cli/      — Command-line tools
```

## Design Principle

All packages are thin HTTP clients to the xenarch.dev API. No business logic — just typed wrappers around REST endpoints.

**Keep SDKs in sync when the platform API changes.**

## Commands

### JavaScript
- Build: `cd js && npm run build`
- Test: `cd js && npm test`
- Publish: `cd js && npm publish`

### Python
- Build: `cd python && uv build`
- Test: `cd python && uv run pytest`
- Publish: `cd python && uv publish`

## Workflow

See root `../CLAUDE.md` for branching, PR, and commit conventions.

## First Run Check

On first interaction with a contributor, verify git hooks are set up by checking `git config core.hooksPath`. If it doesn't return `.githooks`, tell the contributor:

> "This project requires git hooks for commit message enforcement. Can I run `git config core.hooksPath .githooks` to enable them?"

Do not proceed with any code changes until hooks are confirmed active.

## Architecture

See `../Information/design/api-design.md` for the API these SDKs wrap.

## Dev workflow & prod deploy baton

Follow the canonical workspace workflow in `../Information/workflow.md` (Retasc issue → claim → worktree → PR → deploy → validate on prod → merge-commit, never squash).

**Parallel sessions:** before any `kamal deploy` of platform or dashboard, claim the per-service deploy baton in Retasc issue **XEN-524** (via its append-only CLAIM/RELEASE comment log) and merge `main` into your branch first — one session validates on a given prod service at a time. See `../Information/workflow.md` → "Parallel sessions — prod deploy baton".

## Parity guard: no hard-coded Base (XEN-716)

Pay links take USDC and USDT on Base, Ethereum, BNB Chain, Monad and Tron. Name a payment's coin, network and explorer from the networks registry (`GET /v1/networks`, XEN-708) or the payment's own `network` / `token` / `explorer_url`, never a hard-coded Base.

- CI (`.github/workflows/parity-guard.yml`) fails a PR that **adds** a `basescan.org` URL, the words "USDC on Base", the Base USDC contract address or a `USDC_ADDRESS`-style constant outside `.github/parity-guard/allowlist.txt`. Existing lines on main are not checked.
- The allowlist holds only the parts that are Base-only by design: x402 agent payments, bot gating, permit subscriptions, signed link params, Coinbase cash-out, XenPay and the chain registry. Add a path there only for that reason.
- One deliberate line elsewhere can opt out with a trailing `parity-guard: allow <reason>` comment.

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

## Architecture

See `../Information/design/api-design.md` for the API these SDKs wrap.

## Dev workflow & prod deploy baton

Follow the canonical workspace workflow in `../Information/workflow.md` (Linear → branch → PR → deploy → validate on prod → squash-merge).

**Parallel sessions:** before any `kamal deploy` of platform or dashboard, claim the per-service deploy baton in Linear **XEN-524** and merge `main` into your branch first — one session validates on a given prod service at a time. See `../Information/workflow.md` → "Parallel sessions — prod deploy baton".

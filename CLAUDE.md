# xenarch-sdks

SDKs and middleware for integrating with the Xenarch payment network. Polyglot repo with packages for multiple ecosystems.

## Structure

```
js/       — npm packages (TypeScript)
python/   — PyPI packages
cli/      — Command-line tools
```

## Design Principle

All packages are thin HTTP clients to the xenarch.bot API. No business logic — just typed wrappers around REST endpoints.

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

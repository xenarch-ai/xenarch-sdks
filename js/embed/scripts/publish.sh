#!/usr/bin/env bash
# Publish js/embed/dist/v1.js to cdn.xenarch.dev via Cloudflare R2.
#
# Requires:
#   - CLOUDFLARE_DEPLOY_TOKEN with R2 write scope on bucket `xenarch-cdn`
#   - wrangler CLI installed (`npm i -g wrangler`)
#   - dist/v1.js built (`npm run build` in this directory)
#
# Two uploads per release:
#   1. /pay/v<X.Y.Z>.js — immutable, 1 year cache. Frozen pin URL for merchants.
#   2. /pay/v1.js       — moving pointer, 60s browser / 1d edge / 7d SWR.
#
# Verify after publish with:
#   curl -I https://cdn.xenarch.dev/pay/v1.js
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
BUCKET="xenarch-cdn"
SRC="dist/v1.js"

if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC — run 'npm run build' first" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_DEPLOY_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_DEPLOY_TOKEN unset — see Information/secrets.md" >&2
  exit 1
fi

export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_DEPLOY_TOKEN"

echo "→ uploading versioned twin /pay/v${VERSION}.js (immutable, 1y cache)"
wrangler r2 object put "${BUCKET}/pay/v${VERSION}.js" \
  --file="$SRC" \
  --content-type="application/javascript" \
  --cache-control="public, max-age=31536000, immutable" \
  --remote

echo "→ uploading moving pointer /pay/v1.js (60s browser, 1d edge, 7d SWR)"
wrangler r2 object put "${BUCKET}/pay/v1.js" \
  --file="$SRC" \
  --content-type="application/javascript" \
  --cache-control="public, max-age=60, s-maxage=86400, stale-while-revalidate=604800" \
  --remote

echo
echo "published. verify headers:"
echo "  curl -I https://cdn.xenarch.dev/pay/v1.js"
echo "  curl -I https://cdn.xenarch.dev/pay/v${VERSION}.js"

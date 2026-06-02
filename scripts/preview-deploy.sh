#!/usr/bin/env bash
# Seamless Cloudflare Workers *preview* deploy for OpenShaper.
#
# Uploads the current build as a new Worker *version* with a stable preview alias,
# WITHOUT touching production (openshaper.com / openshaper.jarbid101.workers.dev).
# The preview is served at  https://<alias>-openshaper.jarbid101.workers.dev
# (the account's "Preview URLs" pattern: *-openshaper.jarbid101.workers.dev).
#
# Usage:
#   CLOUDFLARE_API_TOKEN=xxx ./scripts/preview-deploy.sh [alias] [--no-build]
#
#   alias       Optional. Defaults to the sanitized current git branch.
#   --no-build  Skip `pnpm build` and deploy the existing apps/web/dist.
#
# Promote a preview to production (only when asked):
#   npx wrangler versions deploy          # interactive: pick the version → 100%
set -euo pipefail

WORKER_NAME="openshaper"
WORKERS_SUBDOMAIN="jarbid101"   # <subdomain>.workers.dev

cd "$(dirname "$0")/.."

# --- preconditions --------------------------------------------------------
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN is not set." >&2
  echo "  Create a token with the 'Edit Cloudflare Workers' template (Workers Scripts: Edit)" >&2
  echo "  at https://dash.cloudflare.com/profile/api-tokens and export it, e.g.:" >&2
  echo "    export CLOUDFLARE_API_TOKEN=...   (or add it to the remote env's secrets)" >&2
  exit 1
fi

# --- args -----------------------------------------------------------------
ALIAS_ARG=""
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *)          ALIAS_ARG="$arg" ;;
  esac
done

RAW_ALIAS="${ALIAS_ARG:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo preview)}"
# Sanitize to a valid DNS label: lowercase, [a-z0-9-] only, collapse/trim hyphens,
# cap length so "<alias>-openshaper" stays under the 63-char subdomain-label limit.
ALIAS="$(printf '%s' "$RAW_ALIAS" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-//; s/-$//' \
  | cut -c1-40 | sed -E 's/-$//')"
[[ -z "$ALIAS" ]] && ALIAS="preview"

SHORTSHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

echo "==> Worker:  $WORKER_NAME"
echo "==> Alias:   $ALIAS   (from '$RAW_ALIAS')"

# --- build ----------------------------------------------------------------
if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "==> Building (pnpm build)…"
  pnpm build
else
  echo "==> Skipping build (--no-build); using existing apps/web/dist"
fi

# --- upload preview version ----------------------------------------------
echo "==> Uploading preview version…"
OUT="$(npx wrangler versions upload \
  --preview-alias "$ALIAS" \
  --message "preview: $RAW_ALIAS @ $SHORTSHA" 2>&1)"
echo "$OUT"

# Prefer the URL wrangler reports; fall back to the known pattern.
URL="$(printf '%s\n' "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | tail -n1 || true)"
[[ -z "$URL" ]] && URL="https://${ALIAS}-${WORKER_NAME}.${WORKERS_SUBDOMAIN}.workers.dev"

echo
echo "✅ Preview deployed (production untouched):"
echo "   $URL"

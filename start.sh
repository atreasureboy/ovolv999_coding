#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f dist/bin/ovogogogo.js ]; then
  pnpm install --frozen-lockfile
  pnpm run build
fi
exec node dist/bin/ovogogogo.js "$@"

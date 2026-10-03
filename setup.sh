#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null
if ! command -v pnpm >/dev/null; then
  echo 'Install the pnpm version declared in package.json, then run setup again.' >&2
  exit 1
fi
exec pnpm run setup:local

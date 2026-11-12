#!/usr/bin/env bash
# Start the Quizmaster server and open it in the default browser.
# Usage: ./start.sh [--port 8765] [--no-browser]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v pixi >/dev/null 2>&1; then
  echo "pixi is not installed. See https://pixi.sh (curl -fsSL https://pixi.sh/install.sh | bash)" >&2
  exit 1
fi

exec pixi run start "$@"

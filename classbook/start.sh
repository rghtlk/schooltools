#!/usr/bin/env bash
# Start classbook.
#
#   ./start.sh                  this computer at http://127.0.0.1:8000,
#                               phone at https://<this-mac>.local:8443
#   ./start.sh --no-https       this computer only; nothing listens on the network
#   ./start.sh --port 8080 --https-port 9443
#
# Ctrl+C stops the server.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

case "${1:-}" in
  -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# Ask a yes/no question; anything but yes is no. Without a terminal to ask
# (started from a script, say) the answer is no, and nothing gets installed.
ask() {
  local reply
  if [ ! -t 0 ]; then
    return 1
  fi
  printf '%s [y/N] ' "$1"
  read -r reply || return 1
  case "$reply" in
    y|Y|yes|Yes|YES|j|J|ja|Ja) return 0 ;;
    *) return 1 ;;
  esac
}

# --- pixi: the tool that installs Python and everything classbook needs ------
# Installed per user into ~/.pixi (no admin rights); a shell started before the
# install may not have it on its PATH yet.
[ -x "$HOME/.pixi/bin/pixi" ] && export PATH="$HOME/.pixi/bin:$PATH"
if ! command -v pixi >/dev/null 2>&1; then
  echo "classbook needs pixi, which installs Python and the packages it uses"
  echo "into this folder (nothing system-wide; https://pixi.sh)."
  if ask "pixi is not installed. Install it now?"; then
    curl -fsSL https://pixi.sh/install.sh | bash
    export PATH="$HOME/.pixi/bin:$PATH"
    if ! command -v pixi >/dev/null 2>&1; then
      echo "pixi did not install — see https://pixi.sh for other ways." >&2
      exit 1
    fi
  else
    echo "Not started. Install pixi yourself with:" >&2
    echo "  curl -fsSL https://pixi.sh/install.sh | bash" >&2
    exit 1
  fi
fi

# --- the environment: Python and the packages, in .pixi/ ---------------------
if [ ! -x .pixi/envs/default/bin/python ]; then
  echo "The environment is not installed yet: Python and the packages classbook"
  echo "uses (a few hundred MB in .pixi/), plus the headless Chromium for PDFs."
  if ask "Install it now?"; then
    pixi install
    pixi run postinstall
  else
    echo "Not started. Install it yourself with:  pixi install && pixi run postinstall" >&2
    exit 1
  fi
fi
RUN=(pixi run)

PORT=8000
prev=""
for a in "$@"; do
  [ "$prev" = "--port" ] && PORT="$a"
  case "$a" in --port=*) PORT="${a#--port=}" ;; esac
  prev="$a"
done
# Only a listener counts: a browser tab still holding a connection to the port
# is not a server. (Without lsof — some Linux systems — the server itself will
# say so if the port is taken.)
if command -v lsof >/dev/null 2>&1 && lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use — is classbook already running?" >&2
  exit 1
fi

# Open the browser once the server answers.
(
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/manifest.webmanifest"; then
      command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${PORT}"
      exit 0
    fi
    sleep 0.5
  done
) &

exec "${RUN[@]}" python -m app.serve "$@"

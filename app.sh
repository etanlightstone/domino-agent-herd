#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec python3 -m gunicorn --bind "0.0.0.0:${SESSION_HUB_PORT:-8888}" --threads 32 --timeout 90 session_hub:app

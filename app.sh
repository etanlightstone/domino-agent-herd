#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
app_env="$(mktemp -d "${TMPDIR:-/tmp}/workspace-sessions-app.XXXXXX")"
python3 -m venv --system-site-packages "$app_env"
"$app_env/bin/python" -m pip install --disable-pip-version-check -r requirements.txt
exec "$app_env/bin/python" -m gunicorn --bind "0.0.0.0:${SESSION_HUB_PORT:-8888}" --threads 32 --timeout 90 session_hub:app

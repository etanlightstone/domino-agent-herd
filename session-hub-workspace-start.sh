#!/usr/bin/env bash
# Domino environment pre-run hook for the private Workspace Sessions environment.
if [[ "${DOMINO_RUN_HOST_PATH:-}" == */notebookSession/* ]] &&
   [[ "${DOMINO_STARTING_USERNAME:-}" == etan_lightstone ]]; then
  workspace_hub_dir="$HOME/.cache/domino-herdr"
  (umask 077; mkdir -p "$workspace_hub_dir")
  nohup python3 - "$workspace_hub_dir" >>"$workspace_hub_dir/connector.log" 2>&1 </dev/null <<'PY' &
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

cache = Path(sys.argv[1])
project = "6afdfebd01335c0badcb0a4c"
app_path = "/modelproducts/6afe02f801335c0badcb0ab9/"
api = os.environ["DOMINO_API_HOST"].rstrip("/")
app_origin = os.environ["DOMINO_URL"].replace("https://", "https://apps.", 1)
for attempt in range(30):
    try:
        token = requests.get("http://127.0.0.1:8899/access-token", timeout=5)
        token.raise_for_status()
        headers = {"Authorization": "Bearer " + token.text.strip()}
        head = requests.get(f"{api}/v4/projects/{project}/commits/head", headers=headers, timeout=10)
        head.raise_for_status()
        for name in ("session_hub_agent.py", "herdr-workspace.sh"):
            url = f"{api}/api/projects/v1/projects/{project}/files/{head.json()['id']}/{name}/content"
            response = requests.get(url, headers=headers, timeout=15)
            response.raise_for_status()
            candidate = cache / (name + ".download")
            candidate.write_bytes(response.content)
            candidate.replace(cache / name)
        break
    except (ValueError, OSError, requests.RequestException):
        time.sleep(5)
else:
    raise SystemExit("Could not load the Workspace Sessions connector from Domino.")

os.execv(sys.executable, [
    sys.executable, str(cache / "session_hub_agent.py"), app_origin + app_path,
    str(cache / "herdr-workspace.sh"),
])
PY
fi

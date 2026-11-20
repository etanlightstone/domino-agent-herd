#!/usr/bin/env bash
# Set SESSION_HUB_OWNER and SESSION_HUB_APP_URL above this script in the pre-run hook.
if [[ "${DOMINO_RUN_HOST_PATH:-}" == */notebookSession/* ]] &&
   [[ -n "${SESSION_HUB_APP_URL:-}" && -n "${SESSION_HUB_OWNER:-}" ]] &&
   [[ "${DOMINO_STARTING_USERNAME:-}" == "$SESSION_HUB_OWNER" ]]; then
  workspace_hub_dir="$HOME/.cache/domino-herdr"
  (umask 077; mkdir -p "$workspace_hub_dir")
  # The App may also start the connector over SSH. The lock keeps one connector per workspace.
  nohup flock -n "$workspace_hub_dir/connector.lock" \
    python3 - "$workspace_hub_dir" "$SESSION_HUB_APP_URL" >>"$workspace_hub_dir/connector.log" 2>&1 </dev/null <<'PY' &
import os
import sys
import time
from pathlib import Path

import requests

cache = Path(sys.argv[1])
app_url = sys.argv[2].rstrip("/") + "/"
if not app_url.startswith("https://"):
    raise SystemExit("Set SESSION_HUB_APP_URL to the private Domino App's HTTPS URL.")
last_failure = None
for attempt in range(30):
    stage = "Requesting a Domino workspace token"
    try:
        identity = requests.get("http://127.0.0.1:8899/access-token", timeout=5)
        identity.raise_for_status()
        token = identity.text.strip()
        headers = {"Authorization": "Bearer " + token}
        for name in ("session_hub_agent.py", "herdr-workspace.sh"):
            stage = f"Downloading {name} from the published App"
            url = app_url + "api/connector/files/" + name
            response = requests.post(url, headers=headers, json={"token": token}, timeout=15, allow_redirects=False)
            if response.is_redirect:
                raise requests.HTTPError(response=response)
            response.raise_for_status()
            stage = f"Saving {name} in the workspace"
            candidate = cache / (name + ".download")
            candidate.write_bytes(response.content)
            candidate.replace(cache / name)
        break
    except (ValueError, OSError, requests.RequestException) as error:
        if isinstance(error, requests.HTTPError) and error.response is not None:
            reason = f"HTTP {error.response.status_code}"
        else:
            reason = type(error).__name__
        failure = f"{stage} failed ({reason})."
        if failure != last_failure:
            print(failure, file=sys.stderr, flush=True)
            last_failure = failure
        time.sleep(5)
else:
    raise SystemExit("Could not load the Workspace Sessions connector from the private Domino App. Check SESSION_HUB_APP_URL and App access.")

os.execv(sys.executable, [
    sys.executable, str(cache / "session_hub_agent.py"), app_url,
    str(cache / "herdr-workspace.sh"),
])
PY
fi

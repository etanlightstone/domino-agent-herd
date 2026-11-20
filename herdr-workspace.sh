#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
mode=${1:-attach}
# codex-auth applies CODEX_AUTH_JSON_B64 only. The connector uses it for sign-in renewed in the App.
if [[ "$mode" != attach && "$mode" != prepare && "$mode" != codex-auth ]]; then
  printf 'Usage: bash herdr-workspace.sh [attach|prepare]\n' >&2
  exit 2
fi

umask 077
cache="$HOME/.cache/domino-herdr"
mkdir -p "$cache" "$HOME/.local/bin"
if [[ -n ${CODEX_AUTH_JSON_B64:-} ]]; then
  python3 - <<'PY'
import base64
import json
import os
import re
from datetime import datetime
from pathlib import Path
from tempfile import NamedTemporaryFile


def refreshed(auth):
    """When Codex last refreshed this login, or None."""
    value = auth.get("last_refresh") if isinstance(auth, dict) else None
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?",
                         value.strip() if isinstance(value, str) else "")
    if not match:
        return None
    zone = "+00:00" if match[3] in (None, "Z") else match[3]
    return datetime.fromisoformat(f"{match[1]}.{(match[2] or '0')[:6].ljust(6, '0')}{zone}")


directory = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
target = directory / "auth.json"
try:
    contents = base64.b64decode(os.environ["CODEX_AUTH_JSON_B64"], validate=True)
    saved = json.loads(contents)
    if not isinstance(saved, dict):
        raise ValueError
except ValueError:
    raise SystemExit("Codex auth setup failed. Check CODEX_AUTH_JSON_B64 in Domino.")
try:
    current = json.loads(target.read_bytes())
except (OSError, ValueError):
    current = None
# Keep a login Codex refreshed in this workspace. Replace it with a newer one saved in Domino.
newer, older = refreshed(saved), refreshed(current)
if isinstance(current, dict) and (newer is None or (older is not None and newer <= older)):
    raise SystemExit(0)
with NamedTemporaryFile(dir=directory, delete=False) as output:
    output.write(contents)
os.replace(output.name, target)
PY
fi
if [[ "$mode" == codex-auth ]]; then
  exit 0
fi

prepare() (
  flock 9
  run_id=${DOMINO_RUN_ID:-}
  needs_update() {
    local agent=$1 stamp="$cache/$1-updated"
    [[ -z "$run_id" || ! -f "$stamp" || $(cat "$stamp") != "$run_id" ]] ||
      ! command -v "$agent" >/dev/null
  }
  if needs_update codex; then
    if curl -fsSL --retry 2 https://releases.openai.com/codex/install.sh |
       CODEX_NON_INTERACTIVE=1 bash; then
      printf '%s\n' "$run_id" > "$cache/codex-updated"
    else
      printf 'Codex update failed. The next attach will retry.\n' >&2
    fi
  fi
  if needs_update claude; then
    update_claude() {
      if command -v claude >/dev/null; then
        claude update
      else
        curl -fsSL --retry 2 https://claude.ai/install.sh | bash -s -- latest
      fi
    }
    if update_claude; then
      printf '%s\n' "$run_id" > "$cache/claude-updated"
    else
      printf 'Claude Code update failed. The next attach will retry.\n' >&2
    fi
  fi

  if ! command -v herdr >/dev/null; then
    python3 - <<'PY'
import hashlib
import json
import os
import platform
from pathlib import Path
from tempfile import NamedTemporaryFile
import subprocess

architecture = platform.machine()
if architecture not in {"x86_64", "aarch64"} or platform.system() != "Linux":
    raise SystemExit("This installer supports Domino workspaces on Linux x86_64 or aarch64.")
asset = f"linux-{architecture}"
release = json.loads(subprocess.check_output([
    "curl", "-fsSL", "--retry", "2", "https://herdr.dev/latest.json"
]))
version = release["version"]
url = f"https://github.com/herdrdev/herdr/releases/download/v{version}/herdr-{asset}"
target = Path.home() / ".local" / "bin" / "herdr"
with NamedTemporaryFile(dir=target.parent, delete=False) as output:
    candidate = Path(output.name)
    try:
        subprocess.run(["curl", "-fsSL", "--retry", "2", "-o", str(candidate), url], check=True)
        with candidate.open("rb") as binary:
            digest = hashlib.file_digest(binary, "sha256").hexdigest()
        if digest != release["sha256"][asset]:
            raise SystemExit("Herdr release checksum did not match.")
        os.fchmod(output.fileno(), 0o700)
        os.replace(candidate, target)
    finally:
        candidate.unlink(missing_ok=True)
PY
  fi
) 9>"$cache/prepare.lock"

prepare
if [[ "$mode" == prepare ]]; then
  herdr --version
  codex --version
  claude --version
else
  exec herdr
fi

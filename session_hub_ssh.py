"""Start workspace connectors through Domino's workspace SSH gateway.

Domino's gateway accepts keyboard-interactive logins that answer a "Token" prompt with the
user's Domino access token and a "RunId" prompt with the workspace execution ID. The App
already holds its owner's token, so it can start the connector in any of the owner's
SSH-enabled workspaces without a custom compute environment.
"""

import base64
import os
import shlex
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

import paramiko

ROOT = Path(__file__).resolve().parent
CONNECTOR_FILES = ("session_hub_agent.py", "herdr-workspace.sh")
LOGIN_USER = os.environ.get("SESSION_HUB_SSH_USER", "ubuntu")
GATEWAY_PORT = int(os.environ.get("SESSION_HUB_SSH_PORT", "2222"))
HOST_CERTIFICATE = 2
# Domino starts sshd with the workspace. Allow slow image pulls and startup before giving up.
SSHD_GRACE_SECONDS = 300
# A started connector registers within seconds unless it cannot reach the App.
REGISTRATION_GRACE_SECONDS = 120


class GatewayError(Exception):
    """A user-facing explanation of why the gateway connection failed."""


def read_host_certificate(blob):
    """Parse an OpenSSH RSA host certificate. Returns its fields and the signed bytes."""
    message = paramiko.Message(blob)
    key_type = message.get_text()
    if key_type != "ssh-rsa-cert-v01@openssh.com":
        raise GatewayError(f"Domino's SSH gateway presented an unexpected key type ({key_type}).")
    message.get_binary()  # nonce
    message.get_mpint()  # e
    message.get_mpint()  # n
    message.get_int64()  # serial
    certificate_type = message.get_int()
    message.get_text()  # key ID
    principals_message = paramiko.Message(message.get_binary())
    principals = []
    while principals_message.get_remainder():
        principals.append(principals_message.get_text())
    valid_after = message.get_int64()
    valid_before = message.get_int64()
    message.get_binary()  # critical options
    message.get_binary()  # extensions
    message.get_binary()  # reserved
    signature_key = message.get_binary()
    signed = blob[:message.packet.tell()]
    signature = message.get_binary()
    return {
        "type": certificate_type, "principals": principals, "valid_after": valid_after,
        "valid_before": valid_before, "signature_key": signature_key, "signed": signed,
        "signature": signature,
    }


def verify_host_certificate(blob, ca_public_key, hostname, now=None):
    """Require a current host certificate for hostname signed by Domino's host CA."""
    if not blob:
        raise GatewayError("Domino's SSH gateway did not present a host certificate.")
    certificate = read_host_certificate(blob)
    ca_fields = ca_public_key.split()
    if len(ca_fields) < 2:
        raise GatewayError("Domino returned an invalid SSH host CA key.")
    ca_blob = base64.b64decode(ca_fields[1])
    now = time.time() if now is None else now
    if certificate["signature_key"] != ca_blob:
        raise GatewayError("Domino's SSH gateway certificate was not signed by Domino's host CA.")
    if certificate["type"] != HOST_CERTIFICATE or hostname not in certificate["principals"]:
        raise GatewayError(f"Domino's SSH gateway certificate does not cover {hostname}.")
    if not certificate["valid_after"] <= now < certificate["valid_before"]:
        raise GatewayError("Domino's SSH gateway certificate is outside its validity period.")
    ca_key = paramiko.RSAKey(data=ca_blob)
    if not ca_key.verify_ssh_sig(certificate["signed"], paramiko.Message(certificate["signature"])):
        raise GatewayError("Domino's SSH gateway certificate signature is invalid.")


def bootstrap_script(app_url, project_id, run_id):
    """Shell script, read by bash -s in the workspace, that starts one connector."""
    quote = shlex.quote
    lines = [
        "set -eu",
        "umask 077",
        'cache="$HOME/.cache/domino-herdr"',
        'mkdir -p "$cache"',
        # A connector from this App, or one started by a connector environment's pre-run hook.
        'if command -v pgrep >/dev/null && pgrep -u "$(id -u)" -f "session_hub_agent[.]py https://" >/dev/null; then',
        "  echo SESSION_HUB=running; exit 0",
        "fi",
        "for tool in python3 flock setsid base64; do",
        '  command -v "$tool" >/dev/null || { echo "SESSION_HUB=missing:$tool"; exit 0; }',
        "done",
        "python3 -c 'import requests' 2>/dev/null || { echo SESSION_HUB=missing:requests; exit 0; }",
    ]
    for name in CONNECTOR_FILES:
        encoded = base64.encodebytes((ROOT / name).read_bytes()).decode()
        lines += [
            f"base64 -d > \"$cache/{name}.download\" <<'SESSION_HUB_FILE'",
            encoded.rstrip("\n"),
            "SESSION_HUB_FILE",
            f'mv -f "$cache/{name}.download" "$cache/{name}"',
        ]
    lines += [
        f"export DOMINO_PROJECT_ID={quote(project_id)} DOMINO_RUN_ID={quote(run_id)}",
        # flock keeps one connector per workspace. setsid -f detaches it from the SSH session.
        'setsid -f flock -n "$cache/connector.lock" python3 "$cache/session_hub_agent.py" '
        f'{quote(app_url)} "$cache/herdr-workspace.sh" >>"$cache/connector.log" 2>&1 </dev/null',
        "echo SESSION_HUB=started",
    ]
    return "\n".join(lines) + "\n"


def run_over_gateway(host, run_id, token, ca_public_key, script, timeout=60):
    """Log in to the workspace through Domino's gateway, run script with bash, and return its output."""
    try:
        sock = socket.create_connection((host, GATEWAY_PORT), timeout=10)
    except OSError as error:
        raise GatewayError(f"Could not reach Domino's SSH gateway at {host}:{GATEWAY_PORT}.") from error
    transport = paramiko.Transport(sock)
    try:
        transport.start_client(timeout=20)
        key = transport.get_remote_server_key()
        blob = key.public_blob.key_blob if getattr(key, "public_blob", None) else None
        verify_host_certificate(blob, ca_public_key, host)

        def answer(_title, _instructions, prompts):
            replies = []
            for prompt, _echo in prompts:
                label = prompt.strip().lower().replace(" ", "")
                replies.append(token if label.startswith("token") else run_id if label.startswith("runid") else "")
            return replies

        try:
            transport.auth_interactive(LOGIN_USER, answer)
        except paramiko.AuthenticationException as error:
            raise GatewayError("Domino's SSH gateway rejected this App's login for the workspace.") from error
        channel = transport.open_session(timeout=20)
        channel.settimeout(timeout)
        channel.exec_command("bash -s")
        channel.sendall(script.encode())
        channel.shutdown_write()
        output = bytearray()
        while True:
            chunk = channel.recv(65536)
            if not chunk:
                break
            output += chunk
        status = channel.recv_exit_status()
        if status != 0:
            raise GatewayError(f"The workspace connector bootstrap exited with status {status}.")
        return output.decode(errors="replace")
    except (paramiko.SSHException, OSError) as error:
        raise GatewayError(f"The SSH connection to the workspace failed ({type(error).__name__}).") from error
    finally:
        transport.close()


@dataclass
class Attempt:
    state: str = "waiting"
    detail: str = "Waiting for the workspace’s SSH server."
    first_seen: float = field(default_factory=time.monotonic)
    next_try: float = 0.0
    started_at: float = 0.0
    failures: int = 0
    busy: bool = False


MISSING = {
    "requests": "The workspace’s python3 needs the requests package for agent sessions.",
    "python3": "The workspace environment needs python3 for agent sessions.",
}


class Bootstrapper:
    """Tracks connector startup for each running workspace execution."""

    def __init__(self):
        self.attempts = {}
        self.lock = Lock()

    def status(self, run):
        with self.lock:
            attempt = self.attempts.get(run)
            return {"state": attempt.state, "detail": attempt.detail} if attempt else None

    def forget_except(self, runs):
        with self.lock:
            for run in list(self.attempts):
                if run not in runs:
                    del self.attempts[run]

    def connected(self, run):
        with self.lock:
            self.attempts.pop(run, None)

    def claim(self, run, *, wait_for_hook=False):
        """Return the Attempt if a bootstrap should run now, otherwise None."""
        now = time.monotonic()
        with self.lock:
            attempt = self.attempts.setdefault(run, Attempt())
            if attempt.busy or now < attempt.next_try:
                return None
            if wait_for_hook and now - attempt.first_seen < 90:
                attempt.detail = "Waiting for the environment’s connector hook."
                return None
            attempt.busy = True
            return attempt

    def update(self, run, attempt, state, detail, retry_in):
        with self.lock:
            attempt.state, attempt.detail, attempt.busy = state, detail, False
            attempt.next_try = time.monotonic() + retry_in

    def record_ssh_unavailable(self, run, attempt, ssh_enabled_for_run):
        if not ssh_enabled_for_run:
            self.update(run, attempt, "ssh-off",
                        "SSH was off when this workspace started. Restart it from this App to connect agent sessions.", 60)
        elif time.monotonic() - attempt.first_seen > SSHD_GRACE_SECONDS:
            self.update(run, attempt, "no-sshd",
                        "Domino can’t reach an SSH server in this workspace. Its environment may be missing "
                        "openssh-server.", 60)
        else:
            self.update(run, attempt, "waiting", "Waiting for the workspace’s SSH server.", 10)

    def record_output(self, run, attempt, output):
        marker = next((line.split("=", 1)[1] for line in output.splitlines()
                       if line.startswith("SESSION_HUB=")), "")
        now = time.monotonic()
        if marker == "started":
            attempt.started_at = now
            self.update(run, attempt, "started", "Starting the workspace connector.", REGISTRATION_GRACE_SECONDS)
        elif marker == "running":
            stuck = attempt.started_at and now - attempt.started_at > REGISTRATION_GRACE_SECONDS
            self.update(run, attempt, "running",
                        "The workspace connector is running but hasn’t reached this App. Check "
                        "~/.cache/domino-herdr/connector.log in the workspace." if stuck or not attempt.started_at
                        else "Starting the workspace connector.", 60)
        elif marker.startswith("missing:"):
            tool = marker.split(":", 1)[1]
            self.update(run, attempt, "unsupported",
                        MISSING.get(tool, f"The workspace environment needs {tool} for agent sessions."), 300)
        else:
            self.record_failure(run, attempt, "The workspace connector bootstrap returned an unexpected result.")

    def record_failure(self, run, attempt, detail):
        attempt.failures += 1
        self.update(run, attempt, "failed", detail, min(300, 15 * 2 ** min(attempt.failures, 5)))

"""In-memory message relay between the private app and workspace connectors."""

from collections import deque
from dataclasses import dataclass, field
from secrets import compare_digest, token_urlsafe
from threading import Condition
from time import monotonic

from flask import abort


@dataclass
class Workspace:
    key: str
    project: str
    seen: float = field(default_factory=monotonic)
    commands: deque = field(default_factory=deque)
    replies: dict = field(default_factory=dict)
    ready: bool = False
    detail: str = "Preparing Herdr and the agent CLIs."
    version: str | None = None


@dataclass
class Terminal:
    run: str
    seen: float = field(default_factory=monotonic)
    frames: deque = field(default_factory=lambda: deque(maxlen=128))
    sequence: int = 0
    closed: bool = False


class Broker:
    def __init__(self, version=None):
        # Fingerprint of the connector files this App ships. Connectors report theirs at registration.
        self.version = version
        self.workspaces = {}
        self.terminals = {}
        self.changed = Condition()

    def register(self, run, project, version=None):
        with self.changed:
            self.prune()
            worker = Workspace(token_urlsafe(32), project, version=version)
            self.workspaces[run] = worker
            self.changed.notify_all()
            return worker.key

    def prune(self):
        now = monotonic()
        for run, worker in list(self.workspaces.items()):
            if now - worker.seen > 24:
                del self.workspaces[run]
        for channel, terminal in list(self.terminals.items()):
            if now - terminal.seen > 45 or terminal.run not in self.workspaces:
                worker = self.workspaces.get(terminal.run)
                if worker and not terminal.closed:
                    worker.commands.append({"operation": "detach", "channel": channel})
                del self.terminals[channel]
        self.changed.notify_all()

    def status(self, run):
        with self.changed:
            self.prune()
            worker = self.workspaces.get(run)
            # Connectors from before versioning report none, so they count as outdated too.
            return {"connected": bool(worker), "ready": bool(worker and worker.ready),
                    "detail": worker.detail if worker else None,
                    "outdated": bool(worker and self.version and worker.version != self.version)}

    def poll(self, run, key, data, *, commands=True, wait=0):
        with self.changed:
            self.prune()
            worker = self.workspaces.get(run)
            if not worker or not compare_digest(worker.key, key):
                abort(401, "Reconnect the workspace connector.")
            worker.seen = monotonic()
            worker.ready = data.get("ready") is True
            worker.detail = str(data.get("detail", ""))[:220]
            for event in data.get("events", [])[:100]:
                if event.get("request") in worker.replies:
                    worker.replies[event["request"]] = event
                channel = event.get("channel")
                terminal = self.terminals.get(channel)
                if terminal and terminal.run == run:
                    if isinstance(event.get("bytes"), str) and len(event["bytes"]) <= 130_000:
                        terminal.sequence += 1
                        terminal.frames.append({"seq": terminal.sequence, "bytes": event["bytes"]})
                    if event.get("closed") is True:
                        terminal.closed = True
            self.changed.notify_all()
            if not commands:
                return []
            if wait and not worker.commands:
                self.changed.wait_for(
                    lambda: worker.commands or self.workspaces.get(run) is not worker, timeout=wait
                )
            if self.workspaces.get(run) is not worker:
                abort(401, "Reconnect the workspace connector.")
            worker.seen = monotonic()
            return [worker.commands.popleft() for _ in range(min(100, len(worker.commands)))]

    def require_worker(self, run, *, require_ready=True):
        self.prune()
        worker = self.workspaces.get(run)
        if not worker or (require_ready and not worker.ready):
            abort(409, (worker.detail if worker else None) or "The workspace connector is unavailable.")
        return worker

    def call(self, run, operation, *, timeout=22, require_ready=True, **values):
        with self.changed:
            worker = self.require_worker(run, require_ready=require_ready)
            if len(worker.commands) >= 128:
                abort(429, "The workspace is busy. Try again shortly.")
            tag = token_urlsafe(12)
            worker.replies[tag] = None
            command = {"operation": operation, "request": tag, **values}
            worker.commands.append(command)
            self.changed.notify_all()
            try:
                if not self.changed.wait_for(lambda: worker.replies[tag] is not None, timeout=timeout):
                    if command in worker.commands:
                        worker.commands.remove(command)
                    abort(504, "The workspace did not respond. Reopen the session to retry.")
                reply = worker.replies[tag]
                if reply.get("error"):
                    abort(409, str(reply["error"])[:300])
                return reply.get("value")
            finally:
                del worker.replies[tag]

    def connect_terminal(self, run, pane):
        channel = token_urlsafe(20)
        with self.changed:
            self.require_worker(run)
            if sum(terminal.run == run and not terminal.closed for terminal in self.terminals.values()) >= 8:
                abort(429, "Close an attached terminal and try again.")
            self.terminals[channel] = Terminal(run)
        try:
            self.call(run, "attach", pane=pane, channel=channel)
        except Exception:
            with self.changed:
                self.terminals.pop(channel, None)
            raise
        return channel

    def terminal(self, channel, after=0, action=None, wait=0):
        with self.changed:
            self.prune()
            terminal = self.terminals.get(channel)
            if not terminal:
                abort(404, "The terminal connection expired. Attach again to continue.")
            terminal.seen = monotonic()
            if action:
                worker = self.require_worker(terminal.run)
                if len(worker.commands) >= 256:
                    abort(429, "The terminal is busy. Try again shortly.")
                worker.commands.append({"operation": "terminal", "channel": channel, "action": action})
                self.changed.notify_all()
            if wait and terminal.sequence <= after and not terminal.closed:
                self.changed.wait_for(
                    lambda: terminal.sequence > after or terminal.closed or channel not in self.terminals, timeout=wait
                )
                if channel not in self.terminals:
                    abort(404, "The terminal connection expired. Attach again to continue.")
            return {"frames": [frame for frame in terminal.frames if frame["seq"] > after],
                    "closed": terminal.closed}

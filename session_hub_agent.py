"""Workspace-side connector for managing Herdr Codex and Claude Code sessions."""

import base64
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from queue import Empty, Queue
from tempfile import NamedTemporaryFile
from threading import Event, Lock, Thread
from uuid import uuid4

import requests

APP_URL = sys.argv[1]
BOOTSTRAP = sys.argv[2]
PROJECT = os.environ["DOMINO_PROJECT_ID"]
RUN = os.environ["DOMINO_RUN_ID"]
CODE_ROOT = Path("/mnt/code")
ROOT = CODE_ROOT if (CODE_ROOT / ".git").exists() else Path("/mnt")
TERMINALS = {}
PENDING_PANES = {}
HISTORY_CACHE = (0, [])
RUNNING_LABELS = {}
EVENTS = Queue(maxsize=100)
MANAGE = Lock()
VSCODE_SETTINGS = Lock()
GIT_SYNC = Lock()
HERDR = ["herdr", "--session", "domino-hub"]
AGENT_FLAGS = {
    # Give session hooks the current pane's environment instead of the daemon's startup environment.
    "codex": ("--no-daemon", "--yolo"),
    "claude": ("--dangerously-skip-permissions",),
}
ENTRY = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
os.environ["PATH"] = str(Path.home() / ".local/bin") + ":" + os.environ["PATH"]


def herdr(*args):
    result = subprocess.run([*HERDR, *args], capture_output=True, text=True, timeout=10)
    try:
        payload = json.loads(result.stdout)
        return payload["result"]
    except (KeyError, ValueError) as failure:
        raise RuntimeError("Herdr could not complete that action.") from failure


def agent_restore_environment():
    # Herdr's native cold restore invokes the agent by name with its saved session ID.
    # Give this Herdr server its own launchers and leave each workspace's CLI installs intact.
    directory = Path.home() / ".cache/domino-herdr/agent-bin"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for kind, flags in AGENT_FLAGS.items():
        executable = shutil.which(kind)
        target = directory / kind
        if not executable:
            target.unlink(missing_ok=True)
            continue
        command = shlex.quote(executable)
        script = "#!/bin/sh\nunset NO_COLOR\n"
        for flag in reversed(flags):
            option = shlex.quote(flag)
            script += f"""arg=
for arg in "$@"; do
  if [ "$arg" = {option} ]; then
    break
  fi
done
if [ "$arg" != {option} ]; then
  set -- {option} "$@"
fi
"""
        script += f'exec {command} "$@"\n'
        with NamedTemporaryFile(dir=directory, mode="w", delete=False) as launcher:
            candidate = Path(launcher.name)
            try:
                launcher.write(script)
                launcher.flush()
                os.fchmod(launcher.fileno(), 0o700)
                candidate.replace(target)
            finally:
                candidate.unlink(missing_ok=True)
    return {**os.environ, "PATH": f"{directory}:{os.environ['PATH']}"}


def ensure_server():
    try:
        return herdr("api", "snapshot")
    except RuntimeError:
        log = Path.home() / ".cache/domino-herdr/herdr-server.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("ab") as output:
            subprocess.Popen([*HERDR, "server"], cwd=ROOT, start_new_session=True,
                             env=agent_restore_environment(), stdin=subprocess.DEVNULL,
                             stdout=output, stderr=output)
        for _ in range(30):
            time.sleep(.2)
            try:
                return herdr("api", "snapshot")
            except RuntimeError:
                continue
        raise RuntimeError("The Herdr server could not start in this workspace.")


def history_title(*values):
    for value in values:
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:145]
    return "Untitled conversation"


def json_lines(path, limit):
    with path.open(encoding="utf-8", errors="replace") as stream:
        for index, line in enumerate(stream):
            if index >= limit:
                break
            if len(line) <= 600_000:
                try:
                    row = json.loads(line)
                    if isinstance(row, dict):
                        yield row
                except ValueError:
                    continue


def history_cwd(value):
    if isinstance(value, str) and Path(value).is_absolute():
        directory = Path(value).resolve()
        if directory.is_relative_to(ROOT.resolve()) and directory.is_dir():
            return str(directory)
    return None


def codex_index(directory):
    index = {}
    try:
        for row in json_lines(directory / "session_index.jsonl", 4000):
            if isinstance(row.get("id"), str):
                index[row["id"]] = row
    except OSError:
        pass

    for path in sorted(directory.glob("state_*.sqlite"), key=lambda path: path.stat().st_mtime, reverse=True):
        try:
            with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=.2) as db:
                db.row_factory = sqlite3.Row
                columns = {row["name"] for row in db.execute("PRAGMA table_info(threads)")}
                fields = ["id", "title", "first_user_message", "updated_at", "archived", "name"]
                selected = ", ".join(field for field in fields if field in columns)
                if not {"id", "updated_at"}.issubset(columns):
                    continue
                for row in db.execute(f"SELECT {selected} FROM threads ORDER BY updated_at DESC LIMIT 500"):
                    index.setdefault(row["id"], {}).update(dict(row))
            break
        except sqlite3.Error:
            continue
    return index


def codex_saved():
    directory = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").resolve()
    index = codex_index(directory)
    for file in sorted((directory / "sessions").glob("*/*/*/*.jsonl"), reverse=True)[:220]:
        try:
            rows = json_lines(file, 85)
            first = next(rows, {})
            meta = first.get("payload") or {}
            session = meta.get("id")
            cwd = history_cwd(meta.get("cwd"))
            if not isinstance(session, str) or not ENTRY.fullmatch(session) or not cwd:
                continue
            item = index.get(session, {})
            if item.get("archived"):
                continue
            prompt = item.get("first_user_message")
            if not any(item.get(field) for field in ("thread_name", "name", "title")) and not prompt:
                for row in rows:
                    payload = row.get("payload") or {}
                    if payload.get("type") == "user_message":
                        prompt = payload.get("message")
                        if prompt:
                            break
            title = history_title(item.get("name"), item.get("thread_name"), item.get("title"), prompt)
            yield {"id": session, "kind": "codex", "label": title, "cwd": cwd,
                   "updated": item.get("updated_at") or file.stat().st_mtime}
        except (OSError, TypeError, ValueError, AttributeError):
            continue


def claude_saved():
    directory = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
    root_prefix = str(ROOT).replace("/", "-")
    files = []
    index = {}
    for project in directory.glob(root_prefix + "*"):
        if project.name == root_prefix or project.name.startswith(root_prefix + "-"):
            try:
                metadata = json.loads((project / "sessions-index.json").read_text())
                for entry in metadata.get("entries", []):
                    if isinstance(entry, dict) and isinstance(entry.get("sessionId"), str):
                        index[entry["sessionId"]] = entry
            except (OSError, ValueError, AttributeError):
                pass
            for file in project.glob("*.jsonl"):
                if ENTRY.fullmatch(file.stem):
                    try:
                        files.append((file.stat().st_mtime, file))
                    except OSError:
                        continue
    for modified, file in sorted(files, reverse=True)[:120]:
        try:
            entry = index.get(file.stem, {})
            cwd = history_cwd(entry.get("projectPath"))
            prompt = entry.get("firstPrompt")
            title = entry.get("customTitle")
            summary = entry.get("summary")
            slug = None
            for row in json_lines(file, 160):
                cwd = cwd or history_cwd(row.get("cwd"))
                slug = slug or row.get("slug")
                if row.get("type") == "custom-title":
                    title = row.get("customTitle") or title
                elif row.get("type") == "summary":
                    summary = row.get("summary") or summary
                elif not prompt and row.get("type") == "user" and not row.get("isMeta") and not row.get("isSidechain"):
                    message = (row.get("message") or {}).get("content")
                    if isinstance(message, list):
                        message = next((block.get("text") for block in message
                                        if isinstance(block, dict) and block.get("type") == "text"), None)
                    if isinstance(message, str) and not message.lstrip().startswith(("<", "/")):
                        prompt = message
                if cwd and title and prompt:
                    break
            if cwd:
                yield {"id": file.stem, "kind": "claude", "label": history_title(title, summary, prompt, slug),
                       "updated": modified, "cwd": cwd}
        except (OSError, TypeError, ValueError, AttributeError):
            continue


def session_history(refresh=False):
    global HISTORY_CACHE
    now = time.monotonic()
    loaded, rows = HISTORY_CACHE
    if refresh or now - loaded > 10:
        rows = sorted([*codex_saved(), *claude_saved()], key=lambda item: item["updated"], reverse=True)
        HISTORY_CACHE = (now, rows)
    return rows


def running_agents():
    agents = {agent["pane_id"]: agent for agent in herdr("agent", "list")["agents"]}
    panes = herdr("pane", "list")["panes"]
    labels = {tab["tab_id"]: tab["label"] for tab in herdr("tab", "list")["tabs"]}
    running = []
    for pane in panes:
        title = labels.get(pane["tab_id"], "")
        name, _, hint = title.partition(" · ")
        if name not in {"Codex", "Claude Code"}:
            continue
        pane_id = pane["pane_id"]
        kind = "codex" if name == "Codex" else "claude"
        agent = agents.get(pane_id) or {}
        launching = PENDING_PANES.get(pane_id, 0) > time.monotonic()
        nav_session = (agent.get("agent_session") or pane.get("agent_session") or {}).get("value")
        session = nav_session if isinstance(nav_session, str) and ENTRY.fullmatch(nav_session) else None
        if not session and (agent or pane.get("agent") == kind or launching):
            try:
                foreground = herdr("pane", "process-info", "--pane", pane_id)["process_info"]
                for process in foreground["foreground_processes"]:
                    if process.get("name") != kind:
                        continue
                    argv = process.get("argv") or []
                    for position, value in enumerate(argv[:-1]):
                        if value in {"resume", "--resume", "--session-id"} and ENTRY.fullmatch(argv[position + 1]):
                            session = argv[position + 1]
                            break
                    if session:
                        break
            except (RuntimeError, OSError, KeyError, subprocess.TimeoutExpired):
                pass
        if agent or pane.get("agent") == kind or launching:
            status = agent.get("agent_status") or pane.get("agent_status")
            running.append({"pane": pane_id, "label": title, "kind": kind, "session": session,
                            "prefix": hint if re.fullmatch(r"[a-f0-9]{8}", hint) else None,
                            "status": "Starting" if launching and status == "unknown" else status})
    return running


def is_running(item, running):
    return any(
        pane["kind"] == item["kind"]
        and (pane["session"] == item["id"] or
             (not pane["session"] and pane["prefix"] and item["id"].startswith(pane["prefix"])))
        for pane in running
    )


def inventory(include_history=True):
    running = running_agents()
    rows = session_history(refresh=include_history)
    indexed = {(row["kind"], row["id"]): row["label"] for row in rows}
    live = []
    for pane in running:
        label = indexed.get((pane["kind"], pane["session"])) or RUNNING_LABELS.get(pane["pane"])
        live.append({"pane": pane["pane"], "label": pane["label"], "kind": pane["kind"],
                     "title": label or pane["label"], "status": pane["status"]})
    saved = [item for item in rows if not is_running(item, running)] if include_history else []
    return {"running": live, "saved": saved[:100]}


def launch(kind, conversation):
    if kind not in AGENT_FLAGS:
        raise RuntimeError("Choose Codex or Claude Code.")
    snapshot = ensure_server()["snapshot"]
    cwd = str(ROOT)
    saved = None
    if conversation:
        if not isinstance(conversation, str) or not ENTRY.fullmatch(conversation):
            raise RuntimeError("Select a saved conversation.")
        if is_running({"kind": kind, "id": conversation}, running_agents()):
            raise RuntimeError("This conversation is already running. Attach to its pane.")
        saved = next((row for row in session_history(refresh=True)
                      if row["kind"] == kind and row["id"] == conversation), None)
        if not saved:
            raise RuntimeError("This conversation is no longer available in the workspace.")
        cwd = saved["cwd"]
    agent = [kind, *AGENT_FLAGS[kind]]
    if conversation:
        agent.extend(["resume", conversation] if kind == "codex" else ["--resume", conversation])
    elif kind == "claude":
        agent.extend(["--session-id", str(uuid4())])
    name = "Codex" if kind == "codex" else "Claude Code"
    label = f"{name} · {conversation[:8] if conversation else time.strftime('%H:%M:%S')}"
    snapshot = ensure_server()["snapshot"]
    if not snapshot.get("workspaces"):
        herdr("workspace", "create", "--cwd", str(ROOT), "--label", "Workspace Sessions")
    title = saved["label"] if saved else label
    pane = herdr("tab", "create", "--cwd", cwd, "--label", label)["root_pane"]["pane_id"]
    # Claude Code otherwise opens file diffs in the workspace IDE's side panel.
    extra_env = ["CLAUDE_CODE_AUTO_CONNECT_IDE=false"] if kind == "claude" else []
    process = subprocess.run([*HERDR, "pane", "run", pane, "env", "-u", "NO_COLOR", "--", *extra_env, *agent], timeout=10,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.returncode:
        raise RuntimeError("Herdr could not start the CLI in this workspace.")
    now = time.monotonic()
    for expired in [key for key, deadline in PENDING_PANES.items() if deadline <= now]:
        del PENDING_PANES[expired]
    PENDING_PANES[pane] = now + 30
    RUNNING_LABELS[pane] = title
    return {"pane": pane, "label": title}


def read_terminal(channel, child):
    try:
        for line in child.stdout:
            record = json.loads(line)
            if record.get("type") == "terminal.frame" and isinstance(record.get("bytes"), str):
                frame = record["bytes"]
                for offset in range(0, len(frame), 60_000):
                    EVENTS.put({"channel": channel, "bytes": frame[offset:offset + 60_000]})
    except (OSError, ValueError):
        pass
    finally:
        EVENTS.put({"channel": channel, "closed": True})
        if TERMINALS.get(channel) is child:
            TERMINALS.pop(channel, None)
        child.wait()


def attach(pane, channel):
    current = next((row for row in herdr("pane", "list")["panes"] if row["pane_id"] == pane), None)
    tabs = herdr("tab", "list")["tabs"]
    if not current or not any(tab["tab_id"] == current["tab_id"] and
                              tab["label"].startswith(("Codex · ", "Claude Code · ")) for tab in tabs):
        raise RuntimeError("That agent pane has closed.")
    child = subprocess.Popen([*HERDR, "terminal", "session", "control", pane,
                              "--takeover", "--cols", "100", "--rows", "30"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, bufsize=1)
    TERMINALS[channel] = child
    Thread(target=read_terminal, args=(channel, child), daemon=True).start()


IMAGE_TYPES = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF8", "gif"))
PASTE_DIR = Path(tempfile.gettempdir()) / "session-hub-pastes"


def save_pasted_image(encoded):
    """Store a browser-pasted image in the workspace and return a bracketed-paste of its path."""
    data = base64.b64decode(encoded, validate=True)
    extension = next((ext for magic, ext in IMAGE_TYPES if data.startswith(magic)), None)
    if not extension and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        extension = "webp"
    if not extension or len(data) > 700_000:
        return None
    PASTE_DIR.mkdir(mode=0o700, exist_ok=True)
    cutoff = time.time() - 86_400
    for old in PASTE_DIR.glob("paste-*"):
        try:
            if old.stat().st_mtime < cutoff:
                old.unlink()
        except OSError:
            pass
    path = PASTE_DIR / f"paste-{uuid4().hex[:12]}.{extension}"
    path.write_bytes(data)
    text = f"\x1b[200~{path}\x1b[201~ "
    return {"type": "terminal.input", "bytes": base64.b64encode(text.encode()).decode(), "encoding": "base64"}


def terminal_input(channel, action):
    if action.get("type") == "terminal.image":
        try:
            action = save_pasted_image(action.get("bytes", ""))
        except (ValueError, OSError):
            action = None
        if not action:
            return
    child = TERMINALS.get(channel)
    if child and child.poll() is None:
        try:
            child.stdin.write(json.dumps(action) + "\n")
            child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass


def update_jsonc_settings(source, updates):
    # Mask comments and trailing commas so decoded values still point into the original file.
    tokens = re.compile(r'"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/')
    masked = tokens.sub(
        lambda token: re.sub(r"[^\r\n]", " ", token[0]) if token[0].startswith("/") else token[0],
        source,
    )
    masked = re.sub(r'"(?:\\.|[^"\\])*"|,(?=\s*[}\]])',
                    lambda token: " " if token[0] == "," else token[0], masked)
    settings = json.loads(masked)
    if not isinstance(settings, dict):
        raise ValueError("VS Code settings must contain an object.")

    remaining = dict(updates)
    edits = []
    decoder = json.JSONDecoder()
    whitespace = re.compile(r"\s*")
    separator = re.compile(r"\s*:\s*")
    start = masked.index("{") + 1
    index = whitespace.match(masked, start).end()
    while masked[index] != "}":
        key, end = decoder.raw_decode(masked, index)
        value_start = separator.match(masked, end).end()
        value, index = decoder.raw_decode(masked, value_start)
        if key in updates and value != updates[key]:
            edits.append((value_start, index, json.dumps(updates[key])))
        remaining.pop(key, None)
        index = whitespace.match(masked, index).end()
        if masked[index] == ",":
            index = whitespace.match(masked, index + 1).end()

    for first, last, value in reversed(edits):
        source = source[:first] + value + source[last:]
    if remaining:
        newline = "\r\n" if "\r\n" in source else "\n"
        fields = ("," + newline).join(f"    {json.dumps(key)}: {json.dumps(value)}"
                                       for key, value in remaining.items())
        suffix = "," if settings else ""
        if not source[start:].startswith(("\n", "\r\n")):
            suffix += newline
        source = source[:start] + newline + fields + suffix + source[start:]
    return source


def set_vscode_theme(theme):
    themes = {"dark": "Dark Modern", "light": "Light Modern"}
    if theme not in themes:
        raise RuntimeError("Choose a light or dark VS Code theme.")
    # Domino's VS Code launcher starts code-server with --user-data-dir "$HOME/.vscode".
    path = Path.home() / ".vscode/Machine/settings.json"
    with VSCODE_SETTINGS:
        try:
            source = path.read_bytes().decode("utf-8-sig")
        except FileNotFoundError:
            source = "{\n}\n"
        try:
            updated = update_jsonc_settings(source, {
                "workbench.colorTheme": themes[theme],
                "window.autoDetectColorScheme": False,
            })
        except ValueError as error:
            raise RuntimeError("VS Code remote settings contain invalid JSON.") from error
        if updated == source:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=path.parent, delete=False) as settings:
            candidate = Path(settings.name)
            try:
                settings.write(updated.encode("utf-8"))
                settings.close()
                candidate.replace(path)
            finally:
                candidate.unlink(missing_ok=True)


def git(*args, timeout=5):
    return subprocess.run(
        ["git", *args], cwd=CODE_ROOT, text=True, errors="replace", capture_output=True,
        stdin=subprocess.DEVNULL, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        check=True, timeout=timeout,
    ).stdout.rstrip("\n")


def git_worktree_status():
    rebase_merge, rebase_apply, *operation_paths = git(
        "rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply",
        "--git-path", "MERGE_HEAD", "--git-path", "CHERRY_PICK_HEAD",
        "--git-path", "REVERT_HEAD", "--git-path", "sequencer", "--git-path", "BISECT_START",
    ).splitlines()
    # git am also uses rebase-apply, but it needs git am --continue or --abort.
    if (CODE_ROOT / rebase_merge).is_dir() or (CODE_ROOT / rebase_apply / "rebasing").exists():
        return {"state": "error", "detail": "A Git rebase is in progress. Resolve the conflicts and run git rebase --continue, or run git rebase --abort to return to your local commits. Then sync again."}
    changes = git("--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal").splitlines()
    if any((CODE_ROOT / name).exists() for name in [rebase_apply, *operation_paths]) or any(
        line[:2] in {"DD", "AU", "UD", "UA", "DU", "AA", "UU"} for line in changes
    ):
        return {"state": "error", "detail": "Finish the Git operation or resolve the conflicts in the workspace first."}
    if changes:
        return {"state": "dirty", "detail": "Sync Git will commit your changes and any new, non-ignored files, then sync the branch."}
    return None


def workspace_git(sync):
    if not GIT_SYNC.acquire(blocking=False):
        return {"state": "busy", "detail": "Another Git check or sync is running. Try again in a moment."}
    try:
        if not (CODE_ROOT / ".git").exists():
            return {"state": "error", "detail": "The project’s Git checkout is missing from this workspace."}
        status = git_worktree_status()
        if status and (not sync or status["state"] == "error"):
            return status
        try:
            branch = git("symbolic-ref", "--quiet", "HEAD")
        except subprocess.CalledProcessError:
            return {"state": "error", "detail": "The workspace is on a Git commit instead of a branch. Switch to a branch to sync."}
        tracking = git("for-each-ref", "--format=%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)",
                       branch).split("\t")
        if len(tracking) != 3 or not tracking[0].startswith("refs/remotes/") or not tracking[1] or not tracking[2].startswith("refs/heads/"):
            return {"state": "error", "detail": "This branch has no remote branch set up for syncing. Set an upstream branch in the workspace."}
        upstream, remote, remote_branch = tracking
        head = git("rev-parse", "HEAD")
        if status:
            try:
                git("add", "--all", timeout=10)
                if git("symbolic-ref", "--quiet", "HEAD") != branch or git("rev-parse", "HEAD") != head:
                    return {"state": "busy", "detail": "The workspace branch changed while staging. Check the staged files and try again."}
                git("commit", "-m", "Sync workspace changes", timeout=15)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                return {"state": "error", "detail": "Git could not commit the workspace changes. Check git status, your Git identity, and any commit hooks."}
            head = git("rev-parse", "HEAD")
        try:
            git("fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
                "--", remote, f"+{remote_branch}:{upstream}", timeout=20)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return {"state": "error", "detail": "Could not fetch the remote branch. Check Git credentials, network access, and the branch in the workspace."}
        status = git_worktree_status()
        if status:
            return status
        tip = git("rev-parse", upstream)
        ahead, behind = map(int, git("rev-list", "--left-right", "--count", f"{head}...{tip}").split())
        if git("symbolic-ref", "--quiet", "HEAD") != branch or git("rev-parse", "HEAD") != head:
            return {"state": "busy", "detail": "The workspace branch changed during the check. Try again."}
        if not sync:
            if ahead and behind:
                return {"state": "dirty", "detail": "Both branches have new commits. Sync Git will rebase your local commits onto the remote branch, then push."}
            if behind:
                return {"state": "dirty", "detail": "The remote branch has new commits. Sync Git pulls them into this workspace."}
            if ahead:
                return {"state": "dirty", "detail": "You have local commits to push. Sync Git sends them to the remote branch."}
            return {"state": "clean", "detail": "Your branch is up to date. Sync Git checks for new commits to pull or push.", "synced": False}
        if ahead and behind:
            try:
                git("merge-base", head, tip)
                git("-c", "rebase.updateRefs=false", "rebase", "--no-autostash", "--no-autosquash",
                    "--rebase-merges", tip, timeout=25)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                status = git_worktree_status()
                return status or {"state": "error", "detail": "Git could not rebase your local commits onto the remote branch. Check the branch in the workspace before syncing again."}
            head = git("rev-parse", "HEAD")
        elif behind:
            try:
                git("-c", "submodule.recurse=false", "merge", "--ff-only", "--no-autostash", tip, timeout=25)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                return {"state": "error", "detail": "Git could not pull the remote commits. Check the branch and files in the workspace."}
        status = git_worktree_status()
        if status:
            return status
        if ahead and head != tip:
            if git("symbolic-ref", "--quiet", "HEAD") != branch or git("rev-parse", "HEAD") != head:
                return {"state": "busy", "detail": "The workspace branch changed before the push. Try again."}
            try:
                git("-c", "push.followTags=false", "push", "--recurse-submodules=no",
                    "--", remote, f"{head}:{remote_branch}", timeout=25)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                return {"state": "error", "detail": "Git could not push your commits. Check remote access and branch permissions, then try again."}
            status = git_worktree_status()
            if status:
                return status
        return {"state": "clean", "detail": "Git is up to date.", "synced": True}
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {"state": "error", "detail": "Could not check Git in this workspace. Open the workspace to check the repository."}
    finally:
        GIT_SYNC.release()


def handle(command):
    operation = command["operation"]
    tag = command.get("request")
    try:
        if operation == "vscode_theme":
            set_vscode_theme(command["theme"])
            value = True
        elif operation in {"git_status", "git_sync"}:
            value = workspace_git(sync=operation == "git_sync")
        else:
            value = handle_agent_action(operation, command)
        EVENTS.put({"request": tag, "value": value})
    except (RuntimeError, OSError, subprocess.TimeoutExpired, KeyError) as error:
        EVENTS.put({"request": tag, "error": str(error)})


def handle_agent_action(operation, command):
    with MANAGE:
        if operation == "inventory":
            return inventory(include_history=command.get("include_history", True))
        if operation == "launch":
            return launch(command["kind"], command.get("conversation"))
        if operation == "attach":
            attach(command["pane"], command["channel"])
            return True
        raise RuntimeError("Unknown connector action.")


def prepare():
    global ready, detail
    try:
        subprocess.run(["bash", BOOTSTRAP, "prepare"], timeout=360)
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        ensure_server()
        for kind in ("codex", "claude"):
            try:
                subprocess.run([*HERDR, "integration", "install", kind], timeout=12, check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except (OSError, subprocess.TimeoutExpired):
                print(f"Herdr could not install {kind}'s session reporting hook.", file=sys.stderr)
        cache = Path.home() / ".cache/domino-herdr"
        missed = []
        for command, label in (("codex", "Codex"), ("claude", "Claude Code")):
            stamp = cache / f"{command}-updated"
            if not stamp.exists() or stamp.read_text().strip() != RUN:
                missed.append(label)
        detail = f"{' and '.join(missed)} didn’t finish updating in this run. Check the workspace connector log for details." if missed else ""
        ready = True
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        detail = "Herdr could not start. Check connector.log in the workspace."


class Connection:
    def __init__(self):
        self.key = None
        self.protocol = 1
        self.reconnect = Event()
        self.token = ""
        self.refresh_at = 0
        self.lock = Lock()

    def access_token(self):
        with self.lock:
            if time.monotonic() >= self.refresh_at:
                response = requests.get("http://127.0.0.1:8899/access-token", timeout=5)
                response.raise_for_status()
                self.token = response.text.strip()
                self.refresh_at = time.monotonic() + 40
            return self.token

    def post(self, client, path, data):
        return client.post(APP_URL + "api/connector/" + path, json=data,
                           headers={"Authorization": "Bearer " + self.access_token()},
                           timeout=(5, 15), allow_redirects=False)

    def register(self, client):
        token = self.access_token()
        result = self.post(client, "register", {"run": RUN, "project": PROJECT, "token": token})
        if not result.ok:
            raise RuntimeError(f"Connector registration returned HTTP {result.status_code}.")
        data = result.json()
        self.protocol = data.get("protocol", 1)
        self.key = data["key"]

    def payload(self, key, events=()):
        return {"run": RUN, "key": key, "ready": ready, "detail": detail, "events": events}

    def push_events(self):
        with requests.Session() as client:
            while True:
                key = self.key
                if not key or self.protocol < 2 or self.reconnect.is_set():
                    time.sleep(.15)
                    continue
                try:
                    first = EVENTS.get(timeout=.4)
                except Empty:
                    continue
                batch = [first]
                drain(batch)
                while self.key == key and not self.reconnect.is_set():
                    try:
                        response = self.post(client, "poll?eventsOnly=1", self.payload(key, batch))
                        if response.status_code in {401, 403}:
                            self.reconnect.set()
                            break
                        response.raise_for_status()
                        break
                    except requests.RequestException as failure:
                        print(failure, file=sys.stderr, flush=True)
                        time.sleep(.75)


def drain(batch):
    while len(batch) < 10:
        try:
            batch.append(EVENTS.get_nowait())
        except Empty:
            break


def dispatch(command):
    if command["operation"] == "terminal":
        terminal_input(command["channel"], command["action"])
    elif command["operation"] == "detach":
        child = TERMINALS.get(command["channel"])
        if child:
            child.terminate()
    else:
        Thread(target=handle, args=(command,), daemon=True).start()


def run():
    link = Connection()
    Thread(target=link.push_events, daemon=True).start()
    batch = []
    with requests.Session() as client:
        while True:
            try:
                if link.reconnect.is_set():
                    link.key = None
                    link.refresh_at = 0
                    link.reconnect.clear()
                    batch.clear()
                    for child in list(TERMINALS.values()):
                        child.terminate()
                if not link.key:
                    link.register(client)
                fast = link.protocol >= 2
                if not fast:
                    drain(batch)
                path = "poll?wait=8" if fast else "poll"
                response = link.post(client, path, link.payload(link.key, batch))
                if response.status_code in {401, 403}:
                    link.reconnect.set()
                    continue
                if not response.ok:
                    raise RuntimeError(f"Connector poll returned HTTP {response.status_code}.")
                batch.clear()
                for command in response.json()["commands"]:
                    dispatch(command)
                if not fast:
                    time.sleep(.25 if TERMINALS else 1.1)
            except (requests.RequestException, RuntimeError, ValueError, KeyError) as failure:
                print(failure, file=sys.stderr, flush=True)
                time.sleep(3)


ready = False
detail = "Preparing Herdr and updating the agent CLIs."
if __name__ == "__main__":
    Thread(target=prepare, daemon=True).start()
    run()

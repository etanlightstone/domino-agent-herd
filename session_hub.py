import base64
import os
import re
from threading import Lock
from urllib.parse import quote, urlencode, urlsplit

import requests
from flask import Flask, abort, jsonify, redirect, request, send_from_directory

from session_hub_broker import Broker

app = Flask(__name__, static_folder="session-hub", static_url_path="/assets")
app.config["MAX_CONTENT_LENGTH"] = 850_000
actions = Lock()
broker = Broker()
managed_environment = "6afe073ca14c525fb5ba9e01"
base_environment = "6539f6bd7758f8546d5424df"
base_revision = "6af5100270d68c5d28c8d7ea"
domino_url = os.environ["DOMINO_URL"].rstrip("/")
project_id = os.environ["DOMINO_PROJECT_ID"]
owner = os.environ["DOMINO_PROJECT_OWNER"]
local_run = os.environ.get("DOMINO_RUN_ID")
origin = urlsplit(domino_url)
web_origin = f"{origin.scheme}://{origin.netloc}"


class DominoError(Exception):
    def __init__(self, response):
        self.status = response.status_code
        try:
            body = response.json()
            self.message = body.get("message") or body.get("errors") or body.get("error")
            if isinstance(self.message, list):
                self.message = " ".join(str(item) for item in self.message)
        except (ValueError, AttributeError):
            self.message = None


@app.errorhandler(DominoError)
def domino_error(error):
    status = error.status if 400 <= error.status < 500 else 502
    message = error.message if status != 502 else None
    return jsonify(error=message or f"Domino returned HTTP {error.status}."), status


@app.errorhandler(requests.RequestException)
def request_error(_error):
    return jsonify(error="Could not reach the Domino API. Try again."), 502


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(429)
@app.errorhandler(504)
def bad_request(error):
    return jsonify(error=error.description), error.code


@app.before_request
def enforce_origin():
    if request.method == "POST":
        if not request.is_json:
            abort(400, "Expected JSON.")
        if not request.path.startswith("/api/connector/") and request.headers.get("Origin") not in {web_origin, request.host_url.rstrip("/")}:
            abort(403, "Open the hub directly from its Domino app link.")


@app.after_request
def prevent_caching(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def domino_response(path, method="GET", **kwargs):
    if "domino_headers" not in request.environ:
        token = requests.get("http://127.0.0.1:8899/access-token", timeout=5)
        token.raise_for_status()
        headers = {"Authorization": f"Bearer {token.text.strip()}"}
        identity = requests.get(
            os.environ["DOMINO_API_HOST"] + "/api/users/v1/self", headers=headers, timeout=10
        )
        if not identity.ok:
            raise DominoError(identity)
        user = identity.json()["user"]
        if user["userName"] != owner:
            abort(403, "The hub must run under the project owner's Domino identity.")
        request.environ["domino_headers"] = headers

    response = requests.request(
        method, os.environ["DOMINO_API_HOST"] + path,
        headers=request.environ["domino_headers"], timeout=(4, 30), allow_redirects=False, **kwargs
    )
    if not response.ok or response.is_redirect:
        raise DominoError(response)
    return response


def domino(path, method="GET", **kwargs):
    response = domino_response(path, method, **kwargs)
    return response.json() if response.content else {}


def check_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{24}", value):
        abort(404, "Invalid Domino ID.")
    return value


def projects():
    return domino("/v4/gateway/projects", params={
        "relationship": "OwnedAndCollaborating", "showCompleted": "true", "limit": 1000
    })


def workspace_path(pid, wid=None):
    base = f"/v4/workspace/project/{check_id(pid)}/workspace"
    return f"{base}/{check_id(wid)}" if wid else base


def inventory():
    page = 1
    while True:
        batch = domino("/v4/workspace", params={"pageSize": 50, "pageNumber": page})
        yield from batch["items"]
        if page * batch["paginationDetails"]["pageSize"] >= batch["totalCount"] or not batch["items"]:
            return
        page += 1


def project_summary(project):
    return {
        "id": project["id"], "name": project["name"], "owner": project["ownerName"],
        "url": f"{domino_url}/u/{quote(project['ownerName'], safe='')}/{quote(project['name'], safe='')}/workspaces",
    }


def supports_connector(environment_config):
    environment = environment_config.get("environment") or {}
    return (
        environment.get("id") == base_environment and environment.get("revisionId") == base_revision
        and not environment_config.get("clusterConfig") and not environment_config.get("computeClusterConfig")
    )


def workspace_summary(workspace, project):
    session = workspace.get("mostRecentSession") or {}
    config = workspace.get("configTemplate") or {}
    ssh_enabled = (config.get("ssh") or {}).get("enabled", False)
    data_plane = (config.get("dataPlane") or {}).get("host") or origin.netloc
    execution = session.get("executionId")
    status = session.get("sessionStatusInfo") or {}
    project_info = project_summary(project)
    environment = config.get("environment") or {}
    can_enable = supports_connector(config)
    ide = None
    if status.get("isRunning") and execution:
        params = urlencode({
            "owner": project["ownerName"], "projectName": project["name"],
            "runId": execution, "workspaceId": workspace["id"],
        })
        ide = f"https://{data_plane}/workspace-session/{quote(project['ownerName'], safe='')}/{quote(project['name'], safe='')}?{params}"
    return {
        "id": workspace["id"], "projectId": project["id"], "project": project_info["name"],
        "name": workspace["name"], "state": workspace["state"],
        "running": bool(ide), "ide": ide, "ssh": ssh_enabled, "run": execution,
        "tool": next(iter((session.get("config") or config).get("tools") or []), None),
        "managed": environment.get("id") == managed_environment,
        "canEnable": can_enable,
        "connector": broker.status(execution),
        "dataPlane": data_plane if workspace.get("dataPlaneId") != "000000000000000000000000" else None,
        "local": bool(local_run and execution == local_run),
        "lastStarted": (workspace.get("sessionStats") or {}).get("lastStartTime"),
    }


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/inventory")
def get_inventory():
    visible = projects()
    by_id = {item["id"]: item for item in visible}
    workspaces = [
        workspace_summary(item, by_id[item["projectId"]])
        for item in inventory()
        if item["ownerName"] == owner and item["projectId"] in by_id and not item["deleted"]
    ]
    return jsonify(
        projects=[project_summary(item) for item in visible], workspaces=workspaces,
        dominoUrl=domino_url, hubProject=project_id, user=owner, managedAvailable=managed_ready(),
    )


@app.get("/api/projects/<pid>/configuration")
def configuration(pid):
    check_id(pid)
    settings = domino(f"/v4/projects/{pid}/settings")
    environment = settings.get("defaultEnvironmentId")
    tier = settings.get("defaultHardwareTierId")
    if not environment or not tier:
        abort(409, "This project needs a default environment and hardware tier in Domino.")
    tools = available_tools(pid, environment)
    connector_tools = available_tools(pid, managed_environment) if managed_ready() else []
    return jsonify(tools=tools, connectorTools=connector_tools, sameBase=environment == base_environment)


def available_tools(pid, environment):
    response = domino(f"/v4/workspaces/project/{pid}/environment/{check_id(environment)}/availableTools")
    return [{"id": tool["id"], "name": tool["title"]} for tool in response["workspaceTools"]]


def managed_ready():
    environment = domino(f"/v4/environments/{managed_environment}")
    return (environment.get("selectedRevision") or {}).get("status") == "Succeeded"


def start_session(pid, workspace):
    last = workspace.get("mostRecentSession") or {}
    def mount_ids(field):
        key = "volumeId" if field == "netAppVolumeMounts" else "id"
        return [item if isinstance(item, str) else item[key] for item in last.get(field) or []]

    params = [
        (key, item)
        for key, values in [
            ("externalVolumeMounts", mount_ids("externalVolumeMounts")),
            ("netAppVolumeIds", mount_ids("netAppVolumeMounts")),
        ]
        for item in (values or ([""] if key == "externalVolumeMounts" else []))
    ]
    domino(workspace_path(pid, workspace["id"]) + "/sessions", "POST", params=params, json={})


@app.post("/api/projects/<pid>/workspaces/<wid>/resume")
def resume(pid, wid):
    with actions:
        workspace = domino(workspace_path(pid, wid))
        if workspace["ownerName"] != owner or workspace["deleted"]:
            abort(403, "Only your own workspaces can be resumed from the hub.")
        if workspace["state"] == "Started":
            return jsonify(id=wid)
        if workspace["state"] != "Stopped":
            abort(409, "Wait for Domino to finish the current workspace operation.")
        if body().get("managed") is True:
            config = workspace["configTemplate"]
            if not supports_connector(config):
                abort(409, "This workspace uses a different environment. Resume it with its existing settings.")
            if not managed_ready():
                abort(409, "The Workspace Sessions environment is still building.")
            domino(workspace_path(pid, wid), "POST", json={
                "name": workspace["name"], "environmentId": managed_environment,
                "environmentRevisionSpec": "ActiveRevision", "hardwareTierId": config["hardwareTier"]["id"],
                "tools": config["tools"], "ssh": config.get("ssh"),
                "persistence": {"persistHomeDirectory": True, "persistPackages": True},
                "capacityType": config.get("capacityType"),
            })
        start_session(pid, workspace)
    return jsonify(id=wid)


@app.post("/api/projects/<pid>/workspaces/<wid>/stop")
@app.post("/api/projects/<pid>/workspaces/<wid>/delete")
def workspace_action(pid, wid):
    deleting = request.path.endswith("/delete")
    if body().get("confirmed") is not True:
        abort(400, "Confirm this workspace action first.")
    path = workspace_path(pid, wid)
    with actions:
        workspace = domino(path)
        if workspace["ownerName"] != owner or workspace["deleted"]:
            abort(403, "Only your own workspaces can be changed from the app.")
        stopped = workspace["state"] == "Stopped"
        if deleting:
            if not stopped:
                abort(409, "Stop the workspace before deleting it.")
            domino(path, "DELETE")
        elif not stopped:
            session = workspace.get("mostRecentSession") or {}
            if not (session.get("sessionStatusInfo") or {}).get("isRunning"):
                abort(409, "Wait for Domino to finish the current workspace operation.")
            domino(path + "/stop", "POST")
    return jsonify(id=wid)


@app.post("/api/projects/<pid>/workspaces/<wid>/stop-for-connector")
def stop_for_connector(pid, wid):
    if body().get("confirmed") is not True:
        abort(400, "Confirm the workspace restart first.")
    with actions:
        workspace = domino(workspace_path(pid, wid))
        if workspace["ownerName"] != owner or workspace["deleted"]:
            abort(403, "Only your workspaces can be restarted from the app.")
        if not supports_connector(workspace.get("configTemplate") or {}) or not managed_ready():
            abort(409, "A compatible Workspace Sessions environment is unavailable.")
        if workspace["state"] == "Stopped":
            return jsonify(id=wid)
        session = workspace.get("mostRecentSession") or {}
        if not (session.get("sessionStatusInfo") or {}).get("isRunning"):
            abort(409, "Wait for Domino to finish the current workspace operation.")
        domino(workspace_path(pid, wid) + "/stop", "POST")
    return jsonify(id=wid)


@app.post("/api/projects/<pid>/workspaces")
def create(pid):
    check_id(pid)
    data = request.get_json()
    if not isinstance(data, dict):
        abort(400, "Expected a workspace name and IDE.")
    name = data.get("name", "")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        abort(400, "Enter a workspace name between 1 and 80 characters.")
    tool = data.get("tool")
    if not isinstance(tool, str):
        abort(400, "Choose an IDE.")
    settings = domino(f"/v4/projects/{pid}/settings")
    environment = settings.get("defaultEnvironmentId")
    tier = settings.get("defaultHardwareTierId")
    if not environment or not tier:
        abort(409, "This project needs a default environment and hardware tier in Domino.")
    revision = settings.get("defaultEnvironmentRevisionSpec")
    if data.get("managed") is True:
        if not managed_ready():
            abort(409, "The Workspace Sessions environment is unavailable.")
        environment = managed_environment
        revision = "ActiveRevision"
    if tool not in {item["id"] for item in available_tools(pid, environment)}:
        abort(400, "This IDE is unavailable in the selected environment.")
    with actions:
        if any(item["projectId"] == pid and item["ownerName"] == owner and
               not item["deleted"] and item["name"] == name.strip() for item in inventory()):
            abort(409, "A workspace with this name already exists in the project.")
        workspace = domino(workspace_path(pid), "POST", json={
            "name": name.strip(),
            "environmentId": environment,
            "environmentRevisionSpec": revision,
            "hardwareTierId": {"value": tier},
            "tools": [tool],
            "externalVolumeMounts": [],
            "ssh": {"enabled": data.get("ssh") is True},
            "persistence": {"persistHomeDirectory": True, "persistPackages": True},
        })
        if workspace["state"] == "Stopped" and not workspace.get("mostRecentSession"):
            start_session(pid, workspace)
    return jsonify(id=workspace["id"]), 201


def body():
    data = request.get_json()
    if not isinstance(data, dict):
        abort(400, "Expected a JSON object.")
    return data


@app.post("/api/connector/register")
def connector_register():
    data = body()
    run = check_id(data.get("run"))
    pid = check_id(data.get("project"))
    token = data.get("token")
    if not isinstance(token, str) or not token or len(token) > 30_000:
        abort(403, "Workspace identity is unavailable.")
    identity = requests.get(f"{domino_url}/api/users/v1/self",
                            headers={"Authorization": "Bearer " + token}, timeout=8,
                            allow_redirects=False)
    if not identity.ok or identity.json()["user"]["userName"] != owner:
        abort(403, "Workspace identity is outside this private app.")
    for workspace in inventory():
        session = workspace.get("mostRecentSession") or {}
        if (workspace["projectId"] == pid and workspace["ownerName"] == owner and not workspace["deleted"]
                and session.get("executionId") == run and (session.get("sessionStatusInfo") or {}).get("isRunning")):
            return jsonify(key=broker.register(run, pid), protocol=2)
    abort(403, "Domino has not marked this workspace as running for this account.")


@app.post("/api/connector/poll")
def connector_poll():
    data = body()
    run = check_id(data.get("run"))
    key = data.get("key")
    if not isinstance(key, str) or not isinstance(data.get("events", []), list) or any(
        not isinstance(event, dict) for event in data.get("events", [])
    ):
        abort(400, "Invalid workspace poll.")
    wait = min(8, max(0, request.args.get("wait", default=0, type=int)))
    commands = request.args.get("eventsOnly") != "1"
    return jsonify(commands=broker.poll(run, key, data, commands=commands, wait=wait))


def running_workspace(pid, wid):
    workspace = domino(workspace_path(pid, wid))
    session = workspace.get("mostRecentSession") or {}
    if workspace["ownerName"] != owner or workspace["deleted"]:
        abort(403, "Only your workspaces are available in this app.")
    if not (session.get("sessionStatusInfo") or {}).get("isRunning"):
        abort(409, "Start or resume the workspace before opening its agent sessions.")
    return session["executionId"]


def resolve_ide(pid, wid):
    run = running_workspace(pid, wid)
    project = next((item for item in projects() if item["id"] == pid), None)
    if not project:
        abort(404, "Domino project is unavailable.")
    workspace = domino(workspace_path(pid, wid))
    summary = workspace_summary(workspace, project)
    user_path = quote(project["ownerName"], safe="")
    project_path = quote(project["name"], safe="")
    try:
        response = domino_response(f"/u/{user_path}/{project_path}/notebookPublicUrl/{run}")
    except DominoError as error:
        if error.status in {404, 409}:
            return summary["ide"], False
        raise

    url = response.text.strip()
    target = urlsplit(url)
    expected = f"/{user_path}/{project_path}/"
    acceptable_paths = {
        expected + f"notebookSession/{run}/",
        expected + f"r/notebookSession/{run}/",
    }
    if (target.scheme != "https" or target.netloc not in {origin.netloc, summary["dataPlane"]}
            or target.path not in acceptable_paths or target.username or target.password):
        return summary["ide"], False
    return url, True


def iframe_allowed(target, parent, headers):
    parsed = urlsplit(target)
    target_origin = f"{parsed.scheme}://{parsed.netloc}"
    xfo = headers.get("X-Frame-Options", "").strip().lower()
    if xfo == "deny" or (xfo == "sameorigin" and parent != target_origin):
        return False
    policies = headers.get("Content-Security-Policy", "").split(",")
    ancestors = [directive.strip().split()[1:] for policy in policies for directive in policy.split(";")
                 if directive.strip().lower().startswith("frame-ancestors ")]
    parent_host = urlsplit(parent).netloc
    if not ancestors:
        return parent == target_origin
    allowed_sources = {parent, parent_host, "*"}
    if parent == target_origin:
        allowed_sources.add("'self'")
    return all(any(source.rstrip("/") in allowed_sources for source in policy) for policy in ancestors)


@app.get("/workspaces/<pid>/<wid>/ide")
def open_workspace_ide(pid, wid):
    url, _ = resolve_ide(pid, wid)
    return redirect(url, code=302)


@app.get("/api/projects/<pid>/workspaces/<wid>/ide")
def workspace_ide(pid, wid):
    url, resolved = resolve_ide(pid, wid)
    parent = request.args.get("origin", "").rstrip("/")
    allowed = False
    if resolved and parent:
        try:
            with requests.get(url, timeout=(3, 4), allow_redirects=False, stream=True) as response:
                allowed = response.status_code < 400 and iframe_allowed(url, parent, response.headers)
        except requests.RequestException:
            pass
    return jsonify(url=url, embed=allowed)


@app.get("/api/projects/<pid>/workspaces/<wid>/agents")
def workspace_agents(pid, wid):
    run = running_workspace(pid, wid)
    state = broker.status(run)
    if state["ready"]:
        state.update(broker.call(run, "inventory", include_history=request.args.get("live") != "1"))
    return jsonify(state)


@app.post("/api/projects/<pid>/workspaces/<wid>/agents")
def launch_agent(pid, wid):
    data = body()
    kind = data.get("kind")
    conversation = data.get("conversation")
    if kind not in ("codex", "claude") or (conversation is not None and
        (not isinstance(conversation, str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", conversation))):
        abort(400, "Choose Codex or Claude Code.")
    run = running_workspace(pid, wid)
    session = broker.call(run, "launch", kind=kind, conversation=conversation)
    return jsonify(channel=broker.connect_terminal(run, session["pane"]), label=session["label"], pane=session["pane"])


@app.post("/api/projects/<pid>/workspaces/<wid>/agents/attach")
def open_agent(pid, wid):
    pane = body().get("pane")
    if not isinstance(pane, str) or not re.fullmatch(r"w[0-9]+:p[0-9]+", pane):
        abort(400, "Select a running agent pane.")
    return jsonify(channel=broker.connect_terminal(running_workspace(pid, wid), pane))


@app.get("/api/terminals/<channel>")
def terminal_output(channel):
    after = request.args.get("after", default=0, type=int)
    wait = min(12, max(0, request.args.get("wait", default=0, type=int)))
    return jsonify(broker.terminal(channel, after=after, wait=wait))


@app.post("/api/terminals/<channel>")
def terminal_input(channel):
    action = body()
    kind = action.get("type")
    if kind == "terminal.input":
        encoded = action.get("bytes")
        if not isinstance(encoded, str) or len(encoded) > 65_536:
            abort(400, "This input is too large.")
        try:
            base64.b64decode(encoded, validate=True)
        except ValueError:
            abort(400, "Invalid terminal input.")
        action = {"type": kind, "bytes": encoded, "encoding": "base64"}
    elif kind == "terminal.resize":
        cols, rows = action.get("cols"), action.get("rows")
        if type(cols) is not int or type(rows) is not int or not 10 <= cols <= 350 or not 4 <= rows <= 140:
            abort(400, "Invalid terminal size.")
        action = {"type": kind, "cols": cols, "rows": rows}
    elif kind == "terminal.release":
        action = {"type": kind}
    else:
        abort(400, "Invalid terminal action.")
    broker.terminal(channel, action=action)
    return jsonify(ok=True)

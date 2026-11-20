import base64
import hashlib
import json
import os
import re
import shlex
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock, Thread
from urllib.parse import quote, urlencode, urlsplit

import requests
from flask import Flask, abort, g, jsonify, redirect, request, send_from_directory
from werkzeug.exceptions import HTTPException

import session_hub_credentials as credentials
from session_hub_broker import Broker
from session_hub_ssh import Bootstrapper, GatewayError, bootstrap_script, run_over_gateway

app = Flask(__name__, static_folder="session-hub", static_url_path="/assets")
app.config["MAX_CONTENT_LENGTH"] = 850_000
actions = Lock()

def connector_version(*paths):
    """Fingerprint of the connector files. session_hub_agent.py computes the same value for itself."""
    digest = hashlib.sha256()
    for path in paths:
        contents = Path(path).read_bytes()
        digest.update(len(contents).to_bytes(8, "big"))
        digest.update(contents)
    return digest.hexdigest()[:16]


# Workspaces get byte-for-byte copies of these files, so a different fingerprint means an older connector.
CONNECTOR_VERSION = connector_version(*(Path(__file__).resolve().parent / name
                                        for name in ("session_hub_agent.py", "herdr-workspace.sh")))
broker = Broker(CONNECTOR_VERSION)
setup_variable = "SESSION_HUB_CONNECTOR_ENVIRONMENT"
# "ssh" or "environment" overrides detection of Domino's workspace SSH setting.
mode_override = os.environ.get("SESSION_HUB_CONNECTION_MODE")
setup_defaults = {
    "id": os.environ.get("SESSION_HUB_WORKSPACE_ENVIRONMENT_ID"),
    "baseEnvironment": os.environ.get("SESSION_HUB_BASE_ENVIRONMENT_ID"),
    "baseRevision": os.environ.get("SESSION_HUB_BASE_REVISION_ID"),
}
connector_files = {"session_hub_agent.py", "herdr-workspace.sh"}
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


def domino_headers():
    """Request headers for the project owner's Domino identity, checked once per request."""
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
    return request.environ["domino_headers"]


def domino_response(path, method="GET", **kwargs):
    response = requests.request(
        method, os.environ["DOMINO_API_HOST"] + path,
        headers=domino_headers(), timeout=(4, 30), allow_redirects=False, **kwargs
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


def connector_settings():
    if "connector_settings" not in g:
        values = domino(f"/v4/projects/{project_id}/environmentVariables")
        value = next((item["value"] for item in values if item["name"] == setup_variable), None)
        try:
            stored = json.loads(value) if value else None
        except ValueError:
            stored = None
        g.connector_settings = stored if isinstance(stored, dict) else setup_defaults
    return g.connector_settings


platform = {"checked": 0.0, "ssh": None}


def ssh_mode():
    """Connect workspaces over Domino SSH when the deployment allows workspace SSH."""
    if mode_override in {"ssh", "environment"}:
        return mode_override == "ssh"
    now = time.monotonic()
    if platform["ssh"] is None or now - platform["checked"] > 300:
        settings = domino("/v4/auth/principal").get("booleanSettings") or []
        platform.update(ssh="workspaceSshEnabled" in settings, checked=now)
    return platform["ssh"]


def run_ssh_enabled(workspace):
    """Whether SSH is on for the workspace's current or most recent execution."""
    session = workspace.get("mostRecentSession") or {}
    return ((session.get("config") or {}).get("ssh") or {}).get("enabled") is True


def app_base_url(details):
    url = details["url"]
    parts = urlsplit(url)
    if parts.scheme != "https":
        abort(409, "The private App needs an HTTPS URL for workspace connectors.")
    if parts.query or not parts.path.endswith("/"):
        return f"https://{parts.netloc}/modelproducts/{details['id']}/"
    return url


app_location = {}


def connector_app_url(browser_url=None):
    """The URL connectors use to reach this App. Prefer Domino's record of the running App."""
    if "url" in app_location:
        return app_location["url"]
    if browser_url:
        try:
            app_location["url"] = app_base_url(app_for_setup(browser_url))
            return app_location["url"]
        except HTTPException:
            pass
    apps = domino("/api/apps/v1/apps", params={"projectId": project_id}).get("items") or []
    running_here = [item for item in apps if local_run and
                    ((item.get("currentVersion") or {}).get("currentInstance") or {}).get("id") == local_run]
    candidates = running_here or (apps if len(apps) == 1 else [])
    if candidates:
        app_location["url"] = app_base_url(candidates[0])
    return app_location.get("url")


def environment_status():
    identifier = connector_settings().get("id")
    if not identifier:
        return {"state": "unconfigured"}
    try:
        environment = domino(f"/v4/environments/{check_id(identifier)}")
    except DominoError as error:
        if error.status in {403, 404}:
            return {"state": "unavailable", "id": identifier}
        raise
    selected = ((environment.get("selectedRevision") or {}).get("status") or "").lower()
    latest = ((environment.get("latestRevision") or {}).get("status") or "").lower()
    if environment.get("archived"):
        state = "unavailable"
    elif selected == "succeeded":
        state = "ready"
    elif (latest or selected) in {"failed", "killed"}:
        state = "failed"
    else:
        state = "building"
    return {"state": state, "id": identifier, "name": environment["name"]}


def app_for_setup(browser_url):
    if not isinstance(browser_url, str) or len(browser_url) > 2000:
        abort(400, "Open the published Domino App to set up agent sessions.")
    browser_url = browser_url.rstrip("/")
    match = re.search(r"/modelproducts/([a-f0-9]{24})$", browser_url)
    if match:
        candidates = [domino(f"/api/apps/v1/apps/{match[1]}")]
    else:
        candidates = domino("/api/apps/v1/apps", params={"projectId": project_id})["items"]
    for candidate in candidates:
        if candidate["project"]["id"] != project_id:
            continue
        if browser_url not in {candidate.get(key, "").rstrip("/") for key in ("url", "vanityUrl")
                               if candidate.get(key)}:
            continue
        details = candidate if match else domino(f"/api/apps/v1/apps/{candidate['id']}")
        if urlsplit(details["url"]).scheme != "https":
            abort(409, "The private App needs an HTTPS URL for workspace connectors.")
        return details
    abort(409, "Open the published Domino App directly to set up agent sessions.")


def base_for_setup():
    settings = domino(f"/v4/projects/{project_id}/settings")
    identifier = settings.get("defaultEnvironmentId")
    if not identifier:
        return None
    base = domino(f"/v4/environments/{check_id(identifier)}")
    if ((base.get("selectedRevision") or {}).get("status") or "").lower() == "succeeded":
        return base
    return None


def revision_details(environment, revision):
    latest = environment.get("latestRevisionDetails") or {}
    if latest.get("id") == revision:
        return latest
    return domino(f"/v4/environments/environmentRevision/{check_id(revision)}")["environmentRevision"]


def setup_hook(app_url):
    hook = (Path(__file__).resolve().parent / "session-hub-workspace-start.sh").read_text()
    return (f"SESSION_HUB_OWNER={shlex.quote(owner)}\n"
            f"SESSION_HUB_APP_URL={shlex.quote(app_url)}\n" + hook)


def create_connector_environment(details, base):
    revision = base["selectedRevision"]["id"]
    parent = revision_details(base, revision)
    build = dict(parent.get("buildConfiguration") or {})
    build.pop("dockerfileInstructions", None)
    build["preRunScript"] = (build.get("preRunScript") or "") + "\n" + setup_hook(details["url"])
    identifier = hashlib.sha256(f"workspace-sessions:{details['id']}".encode()).hexdigest()[:24]
    try:
        return domino(f"/v4/environments/{identifier}")
    except DominoError as error:
        if error.status != 404:
            raise
    return domino("/v4/environments", "POST", json={
        "newEnvironment": {
            "id": identifier,
            "name": f"Workspace Sessions · {details['project']['name'][:32]} · {details['id'][-6:]}",
            "description": f"Connects workspaces to {details['url']}",
            "visibility": "Private", "addBaseDependencies": False, "isCurated": False,
            "skipFirstBuild": False, "rebuildOnBaseChanges": "Never", "assignLatestRevisionAsActive": True,
        },
        "newEnvironmentRevision": {
            "baseRevision": {"baseRevisionId": revision},
            "workspaceTools": (parent.get("workspacesProperties") or {}).get("raw"),
            "supportedClusters": parent.get("clusterTypes") or [],
            "buildConfiguration": build, "environmentVariables": {}, "dockerArguments": [],
            "skipCache": False, "shouldUseVpn": bool(parent.get("shouldUseVPN")),
            "supportsPackagePersistence": parent.get("supportsPackagePersistence"),
        },
    })


def save_connector_environment(environment, details):
    if environment.get("archived"):
        abort(409, "Choose an active compute environment.")
    revision = environment.get("selectedRevision") or environment.get("latestRevision") or {}
    if not revision.get("id"):
        abort(409, "This environment has no workspace revision.")
    source = revision_details(environment, revision["id"])
    script = (source.get("buildConfiguration") or {}).get("preRunScript") or ""
    prefix = setup_hook(details["url"]).split("\n", 2)[:2]
    legacy = (f'project = "{project_id}"' in script and
              f'app_path = "{urlsplit(details["url"]).path}"' in script and
              f'== {owner} ]]' in script)
    configured = all(line in script.splitlines() for line in prefix)
    if not (legacy or configured) or "session_hub_agent.py" not in script or "herdr-workspace.sh" not in script:
        abort(409, "This environment’s pre-run script must point to this App and Domino owner. See the setup guide.")
    base = (environment.get("base") or {}) if source.get("imageType") == "Environment" else {}
    config = {"id": environment["id"], "baseEnvironment": base.get("environmentId"), "baseRevision": base.get("id")}
    domino(f"/v4/projects/{project_id}/environmentVariables", "POST",
           json={"name": setup_variable, "value": json.dumps(config)})
    g.connector_settings = config


@app.get("/api/setup")
def get_setup():
    details = app_for_setup(request.args.get("appUrl"))
    base = base_for_setup()
    return jsonify(owner=owner, appUrl=details["url"], mode="ssh" if ssh_mode() else "environment",
                   environment=environment_status(),
                   base={"id": base["id"], "name": base["name"]} if base else None)


@app.post("/api/setup")
def update_setup():
    data = body()
    with actions:
        details = app_for_setup(data.get("appUrl"))
        mode = data.get("mode")
        if mode == "create":
            if environment_status()["state"] in {"ready", "building"}:
                return jsonify(environment=environment_status())
            base = base_for_setup()
            if not base:
                abort(409, "The App project needs a successfully built default compute environment.")
            created = create_connector_environment(details, base)
            environment = domino(f"/v4/environments/{check_id(created['id'])}")
        elif mode == "link":
            environment = domino(f"/v4/environments/{check_id(data.get('environmentId'))}")
        else:
            abort(400, "Choose to create or link a compute environment.")
        save_connector_environment(environment, details)
        return jsonify(environment=environment_status())


# Agent sign-in lives in the owner's Domino user environment variables, so it reaches every
# workspace the owner starts. Secret values stay on this server; the browser only sees status.
account = {"checked": 0.0, "page": None, "host": None}
account_reads = Lock()
account_writes = Lock()
ACCOUNT_TTL = 60


def load_account_page():
    """Read Domino's account page through the internal API host, or the public URL if that fails."""
    hosts = [account["host"], os.environ["DOMINO_API_HOST"].rstrip("/"), domino_url]
    for host in dict.fromkeys(host for host in hosts if host):
        try:
            response = requests.get(host + credentials.ACCOUNT_PAGE, headers=domino_headers(),
                                    timeout=(4, 20), allow_redirects=False)
        except requests.RequestException:
            continue
        if response.status_code == 200:
            page = credentials.AccountPage(response.text)
            if page.readable:
                account["host"] = host
                return page
    return None


def account_page(refresh=False):
    """User environment variables, cached briefly. None when this deployment's page can't be read."""
    with account_reads:
        if refresh or time.monotonic() - account["checked"] > ACCOUNT_TTL:
            account.update(page=load_account_page(), checked=time.monotonic())
        return account["page"]


def credential_status(refresh=False):
    page = account_page(refresh)
    providers = {}
    for key, spec in credentials.PROVIDERS.items():
        status = (credentials.provider_status(key, page.variables.get(spec["variable"]))
                  if page else {"state": "unknown"})
        providers[key] = {**spec, **status}
    return {"available": bool(page), "writable": bool(page and page.writable),
            "accountUrl": domino_url + credentials.ACCOUNT_SECTION, "providers": providers}


def credential_summary():
    try:
        return credential_status()
    except (requests.RequestException, DominoError, HTTPException):
        return None


def save_user_variable(path, fields):
    page = account_page(refresh=True)
    if not page or not page.writable:
        abort(409, "This Domino deployment doesn’t let the App save user environment variables. "
                   "Add it in your Domino account settings instead.")
    if page.csrf:
        fields = {**fields, "csrfToken": page.csrf}
    try:
        response = requests.post(account["host"] + path, headers=domino_headers(), data=fields,
                                 timeout=(4, 20), allow_redirects=False)
    except requests.RequestException:
        abort(502, "Could not reach Domino to save your sign-in. Try again.")
    if response.status_code not in {200, 302, 303}:
        abort(409, f"Domino didn’t save your sign-in (HTTP {response.status_code}). "
                   "Add it in your Domino account settings instead.")


@app.get("/api/credentials")
def get_credentials():
    return jsonify(credential_status(refresh=request.args.get("refresh") == "1"))


@app.post("/api/credentials")
def update_credentials():
    data = body()
    provider = data.get("provider")
    if provider not in credentials.PROVIDERS:
        abort(400, "Choose Codex or Claude Code.")
    variable = credentials.PROVIDERS[provider]["variable"]
    remove = data.get("remove") is True
    value = None
    if not remove:
        try:
            value = credentials.NORMALIZE[provider](data.get("value"))
        except ValueError as error:
            abort(400, str(error))
    with account_writes:
        if remove:
            save_user_variable(credentials.UNSET_VARIABLE, {"userEnvironmentVariableName": variable})
        else:
            save_user_variable(credentials.SET_VARIABLE, {
                "userEnvironmentVariableName": variable,
                "userEnvironmentVariableValue": value,
                "userEnvironmentVariableDescription": credentials.saved_description(),
            })
        page = account_page(refresh=True)
    # Domino redirects back to the account page whether or not the change worked.
    if not page or (page.variables.get(variable) or {}).get("value") != value:
        abort(409, "Domino didn’t confirm the change. Check your user environment variables in "
                   "your Domino account settings.")
    return jsonify(credential_status())


def launch_credential(kind):
    """The saved sign-in for kind, so new sessions in running workspaces get renewed credentials."""
    try:
        page = account_page()
    except (requests.RequestException, DominoError, HTTPException):
        return None
    return credentials.stored_value(kind, page) if page else None


def connector_compatibility(config):
    environment = config.get("environment") or {}
    identifier = environment.get("id")
    revision = environment.get("revisionId")
    linked = connector_settings()
    base_id = linked.get("baseEnvironment")
    base_revision_id = linked.get("baseRevision")
    if (not identifier or not revision or not base_id or not base_revision_id or identifier == linked.get("id")
            or config.get("clusterConfig") or config.get("computeClusterConfig")):
        return False
    if identifier == base_id:
        return revision == base_revision_id

    revisions = g.setdefault("connector_compatibility", {})
    if revision not in revisions:
        revisions[revision] = False
        try:
            details = domino(f"/v4/environments/environmentRevision/{check_id(revision)}")
        except DominoError as error:
            if error.status not in {403, 404}:
                raise
        else:
            parent = details.get("base") or {}
            previous = details["environmentRevision"]
            hook = (previous.get("buildConfiguration") or {}).get("preRunScript") or ""
            if (parent.get("id") == base_revision_id and parent.get("environmentId") == base_id
                    and previous.get("environmentId") == identifier
                    and "session_hub_agent.py" in hook and "herdr-workspace.sh" in hook
                    and ("SESSION_HUB_APP_URL=" in hook or "app_path = " in hook)):
                revisions[revision] = True
    return revisions[revision]


def environment_managed(environment):
    return bool(connector_settings().get("id")) and environment.get("id") == connector_settings()["id"]


def setup_summary():
    if ssh_mode():
        return {"mode": "ssh", "state": "ready"}
    return {"mode": "environment", **environment_status()}


def workspace_summary(workspace, project):
    session = workspace.get("mostRecentSession") or {}
    config = workspace.get("configTemplate") or {}
    ssh_enabled = (config.get("ssh") or {}).get("enabled", False)
    data_plane = (config.get("dataPlane") or {}).get("host") or origin.netloc
    execution = session.get("executionId")
    status = session.get("sessionStatusInfo") or {}
    project_info = project_summary(project)
    environment = config.get("environment") or {}
    ssh = ssh_mode()
    ssh_run = run_ssh_enabled(workspace)
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
        "managed": ssh_run if ssh else environment_managed(environment),
        "canEnable": bool(status.get("isRunning")) and not ssh_run if ssh else connector_compatibility(config),
        "sshRun": ssh_run,
        "bootstrap": bootstrapper.status(execution) if ssh and execution else None,
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
    setup = setup_summary()
    if setup["mode"] == "ssh":
        connector_app_url(request.args.get("appUrl"))
        supervisor_wake.set()
    return jsonify(
        projects=[project_summary(item) for item in visible], workspaces=workspaces,
        dominoUrl=domino_url, hubProject=project_id, user=owner, managedAvailable=setup["state"] == "ready", setup=setup,
        credentials=credential_summary(),
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
    if ssh_mode():
        return jsonify(mode="ssh", tools=tools, connectorTools=[], sameBase=False)
    linked = connector_settings()
    connector_tools = available_tools(pid, linked["id"]) if managed_ready() else []
    return jsonify(mode="environment", tools=tools, connectorTools=connector_tools,
                   sameBase=environment == linked.get("baseEnvironment"))


def available_tools(pid, environment):
    response = domino(f"/v4/workspaces/project/{pid}/environment/{check_id(environment)}/availableTools")
    return [{"id": tool["id"], "name": tool["title"]} for tool in response["workspaceTools"]]


def managed_ready():
    return environment_status()["state"] == "ready"


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


def revision_spec(environment):
    revision_type = environment.get("revisionType")
    if revision_type in {"Active", "Latest"}:
        return f"{revision_type}Revision"
    if environment.get("revisionId"):
        return {"revisionId": environment["revisionId"]}
    return "ActiveRevision"


def workspace_cluster_config(config):
    cluster = config.get("computeClusterResponseProps") or config.get("clusterProps")
    if not cluster:
        return config.get("computeClusterConfig")
    environment = cluster["computeEnvironment"]
    return {
        "computeEnvironmentId": environment["id"],
        "computeEnvironmentRevisionSpec": revision_spec(environment),
        **{key: cluster[key] for key in (
            "clusterType", "executorCount", "workerCount", "maxWorkerCount",
            "masterHardwareTierId", "executorHardwareTierId", "workerHardwareTierId",
            "volumeSize", "workerStorage",
        ) if key in cluster},
    }


def update_workspace_for_resume(pid, workspace, enable_ssh, use_connector):
    """Keep the workspace's own environment unless switching to the connector environment."""
    config = workspace["configTemplate"]
    current_ssh = config.get("ssh")
    ssh = {**(current_ssh or {}), "enabled": True} if enable_ssh else current_ssh
    if not use_connector and (not enable_ssh or (current_ssh or {}).get("enabled") is True):
        return

    environment = config["environment"]
    environment_id = environment["id"]
    revision = revision_spec(environment)
    persistence = config.get("persistence")
    if use_connector:
        environment_id = connector_settings()["id"]
        revision = "ActiveRevision"
        persistence = {"persistHomeDirectory": True, "persistPackages": True}

    payload = {
        "name": workspace["name"], "environmentId": environment_id,
        "environmentRevisionSpec": revision, "hardwareTierId": config["hardwareTier"]["id"],
        "tools": config["tools"], "ssh": ssh, "persistence": persistence,
        "capacityType": config.get("capacityType"),
    }
    cluster = workspace_cluster_config(config)
    if cluster:
        payload["computeClusterConfig"] = cluster
    domino(workspace_path(pid, workspace["id"]), "POST", json=payload)


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
        enable_ssh = ssh_mode()
        use_connector = (not enable_ssh and body().get("managed") is not False
                         and connector_compatibility(workspace["configTemplate"]) and managed_ready())
        try:
            update_workspace_for_resume(pid, workspace, enable_ssh, use_connector)
        except DominoError as error:
            if not use_connector or error.status not in {400, 403, 404, 422}:
                raise
            app.logger.warning("Domino rejected the connector environment update for %s (HTTP %s).",
                               wid, error.status)
            update_workspace_for_resume(pid, workspace, enable_ssh, use_connector=False)
        start_session(pid, workspace)
    supervisor_wake.set()
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
        run = (workspace.get("mostRecentSession") or {}).get("executionId")
        if run and broker.status(run)["outdated"]:
            pass  # A restart starts the connector this App ships.
        elif ssh_mode():
            if run_ssh_enabled(workspace) and workspace["state"] != "Stopped":
                abort(409, "SSH is already on for this workspace run.")
        elif not connector_compatibility(workspace.get("configTemplate") or {}) or not managed_ready():
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
    enable_ssh = ssh_mode()
    if data.get("managed") is True and not enable_ssh:
        if not managed_ready():
            abort(409, "The Workspace Sessions environment is unavailable.")
        environment = connector_settings()["id"]
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
            "ssh": {"enabled": enable_ssh},
            "persistence": {"persistHomeDirectory": True, "persistPackages": True},
        })
        if workspace["state"] == "Stopped" and not workspace.get("mostRecentSession"):
            start_session(pid, workspace)
    supervisor_wake.set()
    return jsonify(id=workspace["id"]), 201


def body():
    data = request.get_json()
    if not isinstance(data, dict):
        abort(400, "Expected a JSON object.")
    return data


def require_connector_owner(token):
    if not isinstance(token, str) or not token or len(token) > 30_000:
        abort(403, "Workspace identity is unavailable.")
    identity = requests.get(f"{domino_url}/api/users/v1/self",
                            headers={"Authorization": "Bearer " + token}, timeout=8,
                            allow_redirects=False)
    if identity.status_code != 200 or identity.json()["user"]["userName"] != owner:
        abort(403, "Workspace identity is outside this private app.")


@app.route("/api/connector/files/<name>", methods=["GET", "POST"])
def download_connector_file(name):
    if name not in connector_files:
        abort(404)
    if request.method == "POST":
        # Domino's App proxy can replace Authorization with a viewer token.
        token = body().get("token")
    else:
        scheme, _, bearer = request.headers.get("Authorization", "").partition(" ")
        token = bearer if scheme.lower() == "bearer" else None
    require_connector_owner(token)
    return send_from_directory(Path(__file__).resolve().parent, name, as_attachment=True)


@app.post("/api/connector/register")
def connector_register():
    data = body()
    run = check_id(data.get("run"))
    pid = check_id(data.get("project"))
    require_connector_owner(data.get("token"))
    for workspace in inventory():
        session = workspace.get("mostRecentSession") or {}
        if (workspace["projectId"] == pid and workspace["ownerName"] == owner and not workspace["deleted"]
                and session.get("executionId") == run and (session.get("sessionStatusInfo") or {}).get("isRunning")):
            version = data.get("version") if isinstance(data.get("version"), str) else None
            return jsonify(key=broker.register(run, pid, version and version[:64]), protocol=2)
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


def require_running_workspace(pid, wid):
    workspace = domino(workspace_path(pid, wid))
    session = workspace.get("mostRecentSession") or {}
    if workspace["ownerName"] != owner or workspace["deleted"]:
        abort(403, "Only your workspaces are available in this app.")
    if not (session.get("sessionStatusInfo") or {}).get("isRunning"):
        abort(409, "Start or resume the workspace before opening its agent sessions.")
    return workspace, session


def running_workspace(pid, wid):
    _, session = require_running_workspace(pid, wid)
    return session["executionId"]


def resolve_ide(pid, wid):
    workspace, session = require_running_workspace(pid, wid)
    run = session["executionId"]
    project = next((item for item in projects() if item["id"] == pid), None)
    if not project:
        abort(404, "Domino project is unavailable.")
    summary = workspace_summary(workspace, project)
    user_path = quote(project["ownerName"], safe="")
    project_path = quote(project["name"], safe="")
    try:
        response = domino_response(f"/u/{user_path}/{project_path}/notebookPublicUrl/{run}")
    except DominoError as error:
        if error.status in {404, 409}:
            abort(409, "Domino is still preparing the workspace IDE. Try opening it again in a moment.")
        raise

    url = response.text.strip()
    try:
        target = urlsplit(url)
    except ValueError:
        abort(409, "Domino did not return a direct workspace IDE URL. Try opening it again in a moment.")
    expected = f"/{user_path}/{project_path}/"
    acceptable_paths = {
        expected + f"notebookSession/{run}",
        expected + f"r/notebookSession/{run}",
    }
    if (target.scheme != "https" or target.netloc not in {origin.netloc, summary["dataPlane"]}
            or target.path.removesuffix("/") not in acceptable_paths or target.username or target.password):
        abort(409, "Domino did not return a direct workspace IDE URL. Try opening it again in a moment.")
    return url


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
    return redirect(resolve_ide(pid, wid), code=302)


@app.get("/api/projects/<pid>/workspaces/<wid>/ide")
def workspace_ide(pid, wid):
    url = resolve_ide(pid, wid)
    parent = request.args.get("origin", "").rstrip("/")
    parsed = urlsplit(url)
    same_origin = parent == f"{parsed.scheme}://{parsed.netloc}"
    allowed = False
    if parent:
        try:
            with requests.get(url, timeout=(3, 4), allow_redirects=False, stream=True) as response:
                # The probe lacks the session cookies the browser sends to Domino.
                browser_can_retry = response.status_code in {401, 403, 404}
                allowed = (response.ok or browser_can_retry) and iframe_allowed(url, parent, response.headers)
        except requests.RequestException:
            allowed = same_origin
    return jsonify(url=url, embed=allowed)


@app.post("/api/projects/<pid>/workspaces/<wid>/ide/theme")
def workspace_ide_theme(pid, wid):
    theme = body().get("theme")
    if theme not in ("light", "dark"):
        abort(400, "Choose a light or dark VS Code theme.")
    workspace, session = require_running_workspace(pid, wid)
    config = session.get("config") or workspace.get("configTemplate") or {}
    if next(iter(config.get("tools") or []), None) != "vscode":
        abort(409, "This workspace IDE is not VS Code.")
    broker.call(session["executionId"], "vscode_theme", theme=theme, timeout=5, require_ready=False)
    return jsonify(applied=True)


@app.route("/api/projects/<pid>/workspaces/<wid>/git", methods=["GET", "POST"])
def workspace_git(pid, wid):
    run = running_workspace(pid, wid)
    sync = request.method == "POST"
    if sync and body().get("run") != run:
        abort(409, "The workspace restarted. Refresh the page before syncing.")
    project = domino(f"/api/projects/v1/projects/{pid}")["project"]
    if not project.get("mainRepository"):
        return jsonify(state="disabled", detail="Git sync is unavailable for Domino File System projects.")
    if not broker.status(run)["connected"]:
        return jsonify(state="disabled", detail="Git sync needs a connected workspace.")
    operation = "git_sync" if sync else "git_status"
    return jsonify(broker.call(run, operation, timeout=110 if sync else 65, require_ready=False))


@app.get("/api/projects/<pid>/workspaces/<wid>/agents")
def workspace_agents(pid, wid):
    run = running_workspace(pid, wid)
    state = broker.status(run)
    if state["ready"]:
        state.update(broker.call(run, "inventory", include_history=request.args.get("live") != "1"))
    elif not state["connected"] and ssh_mode():
        supervisor_wake.set()
        progress = bootstrapper.status(run)
        if progress:
            state.update(detail=progress["detail"], bootstrap=progress)
    return jsonify(state)


@app.post("/api/projects/<pid>/workspaces/<wid>/agents")
def launch_agent(pid, wid):
    data = body()
    pane = data.get("relaunch")
    if pane is not None:
        # Resume an agent session that lost its sign-in, using the sign-in saved in Setup now.
        if not isinstance(pane, str) or not 0 < len(pane) <= 128:
            abort(400, "Select a running agent session.")
        run = running_workspace(pid, wid)
        current = {kind: launch_credential(kind) for kind in credentials.PROVIDERS}
        session = broker.call(run, "relaunch", pane=pane, timeout=45,
                              credentials={kind: value for kind, value in current.items() if value is not None})
        return jsonify(channel=broker.connect_terminal(run, session["pane"]), label=session["label"],
                       pane=session["pane"])
    kind = data.get("kind")
    conversation = data.get("conversation")
    if kind not in ("codex", "claude") or (conversation is not None and
        (not isinstance(conversation, str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", conversation))):
        abort(400, "Choose Codex or Claude Code.")
    run = running_workspace(pid, wid)
    credential = launch_credential(kind)
    # Connectors from earlier App versions ignore the credential.
    extra = {"credential": credential} if credential is not None else {}
    session = broker.call(run, "launch", kind=kind, conversation=conversation, **extra)
    return jsonify(channel=broker.connect_terminal(run, session["pane"]), label=session["label"], pane=session["pane"])


@app.post("/api/projects/<pid>/workspaces/<wid>/agents/attach")
def open_agent(pid, wid):
    data = body()
    pane = data.get("pane")
    # Herdr pane IDs are opaque. The connector checks that the ID belongs to a live agent tab.
    if not isinstance(pane, str) or not 0 < len(pane) <= 128:
        abort(400, "Select a running agent pane.")
    run = running_workspace(pid, wid)
    if data.get("run") is not None and data["run"] != run:
        return jsonify(error="The workspace restarted. Refresh the page to open its current sessions."), 412
    return jsonify(channel=broker.connect_terminal(run, pane))


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
    elif kind == "terminal.scroll":
        direction, lines = action.get("direction"), action.get("lines")
        if direction not in ("up", "down") or type(lines) is not int or not 1 <= lines <= 200:
            abort(400, "Invalid terminal scroll.")
        column, row = action.get("column"), action.get("row")
        action = {"type": kind, "direction": direction, "lines": lines}
        if column is not None or row is not None:
            if type(column) is not int or type(row) is not int or not (0 <= column < 350 and 0 <= row < 140):
                abort(400, "Invalid terminal scroll position.")
            action.update(column=column, row=row)
    elif kind == "terminal.image":
        encoded = action.get("bytes")
        if not isinstance(encoded, str) or len(encoded) > 780_000:
            abort(400, "This image is too large to paste.")
        try:
            base64.b64decode(encoded, validate=True)
        except ValueError:
            abort(400, "Invalid image.")
        action = {"type": kind, "bytes": encoded}
    elif kind == "terminal.release":
        action = {"type": kind}
    else:
        abort(400, "Invalid terminal action.")
    broker.terminal(channel, action=action)
    return jsonify(ok=True)


bootstrapper = Bootstrapper()
bootstrap_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="connector-bootstrap")
supervisor_wake = Event()


def bootstrap_workspace(workspace, run, attempt, app_url, headers):
    """Start the connector in one workspace over Domino SSH. Runs outside a request."""
    try:
        connect = f"{domino_url}/domino-connect/api/v1/workspaces/{workspace['id']}"
        header = requests.get(connect, headers=headers, timeout=10, allow_redirects=False)
        header.raise_for_status()
        session = header.json().get("mostRecentSession") or {}
        host = (session.get("sshConnectionArgs") or {}).get("host")
        if session.get("executionId") != run or not host:
            bootstrapper.update(run, attempt, "waiting", "Waiting for Domino to start the workspace.", 10)
            return
        diagnose = requests.get(connect + "/ssh-diagnose", headers=headers, timeout=30, allow_redirects=False)
        diagnose.raise_for_status()
        checks = diagnose.json()
        if any((checks.get(name) or {}).get("result") != "ok"
               for name in ("isRunning", "isReachable", "isSSHServerListening", "hasValidHostKey")):
            bootstrapper.record_ssh_unavailable(run, attempt, run_ssh_enabled(workspace))
            return
        authority = requests.get(os.environ["DOMINO_API_HOST"] + "/v4/workspace/ssh/host/sign/publicKey",
                                 headers=headers, timeout=10, allow_redirects=False)
        authority.raise_for_status()
        token = headers["Authorization"].split(" ", 1)[1]
        output = run_over_gateway(host, run, token, authority.json()["publicKey"],
                                  bootstrap_script(app_url, workspace["projectId"], run))
        bootstrapper.record_output(run, attempt, output)
    except GatewayError as error:
        bootstrapper.record_failure(run, attempt, str(error))
    except (requests.RequestException, ValueError, KeyError):
        bootstrapper.record_failure(run, attempt, "Could not reach Domino’s workspace SSH service. Retrying.")
    except Exception:
        app.logger.exception("Connector bootstrap failed for %s.", run)
        bootstrapper.record_failure(run, attempt, "Agent session startup failed unexpectedly. Retrying.")


def sweep_workspaces():
    """Start connectors in running owner workspaces that have not registered with this App."""
    if not ssh_mode():
        bootstrapper.forget_except(set())
        return
    running = {}
    for item in inventory():
        session = item.get("mostRecentSession") or {}
        run = session.get("executionId")
        if (item["ownerName"] == owner and not item["deleted"] and run
                and (session.get("sessionStatusInfo") or {}).get("isRunning")):
            running[run] = item
    bootstrapper.forget_except(set(running))
    pending = [run for run in running if not broker.status(run)["connected"]]
    for run in set(running) - set(pending):
        bootstrapper.connected(run)
    if not pending:
        return
    app_url = connector_app_url()
    if not app_url:
        return
    headers = dict(request.environ["domino_headers"])
    for run in pending:
        workspace = running[run]
        environment = (workspace.get("configTemplate") or {}).get("environment") or {}
        attempt = bootstrapper.claim(run, wait_for_hook=environment_managed(environment))
        if attempt:
            bootstrap_pool.submit(bootstrap_workspace, workspace, run, attempt, app_url, headers)


def supervise():
    while True:
        started = time.monotonic()
        try:
            with app.test_request_context("/"):
                sweep_workspaces()
        except Exception:
            app.logger.exception("Workspace connector sweep failed.")
        supervisor_wake.wait(10)
        supervisor_wake.clear()
        # Browser polls wake the sweep. Space sweeps out to limit Domino API calls.
        time.sleep(max(0.0, 4 - (time.monotonic() - started)))


if os.environ.get("SESSION_HUB_SUPERVISOR", "1") != "0":
    Thread(target=supervise, name="connector-supervisor", daemon=True).start()

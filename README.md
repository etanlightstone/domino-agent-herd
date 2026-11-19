# Workspace Sessions for Domino

A private Domino App for switching between your workspaces and the Codex and Claude Code sessions running in them. Each workspace runs its own connector and Herdr server. The App uses the Domino identity of its project owner to list and operate on that user's workspaces.

## Publish the App

1. Create a Git-based Domino project from this repository under your own Domino account. For a private GitHub repository, configure your GitHub credentials in Domino so it can clone the repo.
2. Publish an owner-only Domino App from the project using `app.sh` and port `8888`. Select a Linux compute environment with Python 3.11 or later, `venv`, and `pip`. At launch, `app.sh` installs the Python packages in `requirements.txt` into a virtual environment and starts Gunicorn. The environment needs package index access if those versions are absent.
3. Open the published App directly. The setup dialog shows your Domino username and the published App URL. Choose **Create from …** to build a private connector environment from the App project's default environment, or **Link environment** if you have a connector environment already configured for this App. The App saves the choice in the project and updates the build status until the environment is ready. Use one Workspace Sessions App per Domino project.

Keep the App accessible only to its project owner. The App acts with that owner's access to their workspaces.

## Launch a connected workspace

The connector is a background process that runs **inside each workspace**. It registers with the App, reads locally saved agent history, and relays the workspace's Herdr terminals. Domino runs a compute environment's pre-run script whenever it starts a new execution from that environment. This lets a workspace connect before you open its IDE. [Domino's Run Setup Scripts example](https://github.com/dominodatalab/Domino-Training-Workshop#lab-21---inspect-compute-environment)

After setup shows **ready**, create a workspace with **Connect Codex and Claude Code to this app** selected. The App starts it with the configured environment. The hook downloads and starts the connector, which installs Herdr as needed and attempts to update the agent CLIs once per workspace execution. Projects where you launch workspaces need a default hardware tier and access to the connector environment.

The base environment needs Python 3.11 or later with `requests`, Bash, `curl`, and `flock`. The workspace needs network access to your Domino App and to the Codex, Claude Code, and Herdr release hosts. For connector startup failures, see `~/.cache/domino-herdr/connector.log` in the workspace. If your Domino account cannot create environments, someone with environment permissions can prepare one for you to link.

### Prepare an existing environment for linking

In the environment's **Run Setup Scripts → Pre-Run Script**, add the assignments below and paste [`session-hub-workspace-start.sh`](session-hub-workspace-start.sh) after them. Keep any existing setup your environment needs. Save and build the revision as required by your Domino deployment, then enter its environment ID in **Connector setup**.

```bash
SESSION_HUB_OWNER='your-domino-username'
SESSION_HUB_APP_URL='https://apps.example.com/modelproducts/your-app-id/'
```

Use the exact App URL shown in **Connector setup**. The hook uses the workspace's Domino sidecar to download the connector and launcher directly from the App. The App can also read `SESSION_HUB_WORKSPACE_ENVIRONMENT_ID`, `SESSION_HUB_BASE_ENVIRONMENT_ID`, and `SESSION_HUB_BASE_REVISION_ID` from its environment for deployments configured before the setup UI was added.

## Agent credentials

Set these in your Domino user environment variables so they reach workspaces across projects. Project variables work too if you set them in every project where you run agents.

| Variable | Purpose |
| --- | --- |
| `CODEX_AUTH_JSON_B64` | Base64-encoded contents of your Codex `auth.json`. The workspace bootstrap initializes `${CODEX_HOME:-$HOME/.codex}/auth.json` when it is missing or empty. An existing login can be reused. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Your Claude Code OAuth token. The launcher inherits it from the workspace environment. |

Agent sessions opened by this App use `codex --yolo` and `claude --dangerously-skip-permissions`.

## Restart or move the App

- **Same App URL.** The App rebuilds its workspace list from Domino. The relay inside the App is in memory. Connectors retry registration, and you may need to reopen browser terminals after the App restarts.
- **New project, same Domino account and deployment.** The new App can see the same workspaces. Create a connector environment in the new App with the same base environment and revision as the previous one, or point an existing environment's hook at the new URL and link it. Workspaces already using a linked environment connect on their next start.
- **Resume a stopped workspace.** Choose **Resume workspace**. The App automatically uses its connector environment when it is ready and the workspace uses the same base revision or a compatible previous connector environment. When the switch is unavailable, Domino starts the workspace with its existing settings. Domino keeps the workspace ID and storage.
- **Connect a running workspace.** Choose **Restart with agent sessions** when offered. This stops running processes and starts the workspace again. Setting up the App alone leaves running workspaces active.
- **Agent sessions.** Herdr, live agent processes, and saved Codex and Claude Code history reside in each workspace. Restarting a workspace ends its live processes. Saved conversations from a persisted home or configured history directory reappear in **History** when its connector reconnects.

# Workspace Sessions for Domino

A private Domino App for switching between your workspaces and the Codex and Claude Code sessions running in them. Each workspace runs its own connector and Herdr server. The App uses the Domino identity of its project owner to list and operate on that user's workspaces.

## Publish the App

1. Create a Git-based Domino project from this repository under your own Domino account. For a private GitHub repository, configure your GitHub credentials in Domino so it can clone the repo.
2. Publish an owner-only Domino App from the project using `app.sh` and port `8888`. Select a Linux compute environment with Python 3.11 or later, `venv`, and `pip`. At launch, `app.sh` installs the Python packages in `requirements.txt` into a virtual environment and starts Gunicorn. The environment needs package index access if those versions are absent.
3. Open the App. Workspace discovery and ordinary workspace actions use the App's Domino sidecar identity. To start agent sessions from the App, set up the workspace connector once as described below.

Keep the App accessible only to its project owner. The App acts with that owner's access to their workspaces.

## Configure the workspace connector

The connector is a background process that runs **inside each workspace**. It registers with the App, reads locally saved agent history, and relays the workspace's Herdr terminals. Domino runs a compute environment's pre-run script whenever it starts a new execution from that environment. This lets a workspace connect before you open its IDE. [Domino's Run Setup Scripts example](https://github.com/dominodatalab/Domino-Training-Workshop#lab-21---inspect-compute-environment)

1. Clone the Domino compute environment you want to use for agent-enabled workspaces, or use an environment you control. It needs Python 3.11 or later with `requests`, Bash, `curl`, and `flock`. The workspace needs network access to your Domino App and to the Codex, Claude Code, and Herdr release hosts.
2. In the environment's **Run Setup Scripts → Pre-Run Script**, add the two assignments below and paste the contents of [`session-hub-workspace-start.sh`](session-hub-workspace-start.sh) after them. Keep any existing setup your environment needs. Save and build the revision as required by your Domino deployment.

   ```bash
   SESSION_HUB_OWNER='your-domino-username'
   SESSION_HUB_APP_URL='https://apps.example.com/modelproducts/your-app-id/'
   ```

   Use the final HTTPS URL you use to open your private App. The hook uses the workspace's Domino sidecar to download the connector and its launcher directly from that App. It is independent of how the App project stores its source files.
3. Add `SESSION_HUB_WORKSPACE_ENVIRONMENT_ID` to the App project's environment variables and set it to the ID of that connector environment. Restart or republish the App to load the setting. Projects where you launch workspaces also need a default hardware tier and compute environment, and access to the connector environment.
4. In the App, create a workspace with **Connect Codex and Claude Code to this app** selected. The App starts the workspace with the configured environment. The hook downloads and starts the connector, which installs Herdr as needed and attempts to update the agent CLIs once per workspace execution. Agent tabs become available after the connector registers. For startup failures, see `~/.cache/domino-herdr/connector.log` in the workspace.

To offer **Resume with agent sessions** for existing workspaces on a compatible base, also set `SESSION_HUB_BASE_ENVIRONMENT_ID` and `SESSION_HUB_BASE_REVISION_ID` on the App project. Use the exact source environment and revision from which you cloned the connector environment. The App checks that the environment matches before changing an existing workspace's configuration. A workspace already configured with the connector environment runs its hook on an ordinary resume.

## Agent credentials

Set these in your Domino user environment variables so they reach workspaces across projects. Project variables work too if you set them in every project where you run agents.

| Variable | Purpose |
| --- | --- |
| `CODEX_AUTH_JSON_B64` | Base64-encoded contents of your Codex `auth.json`. The workspace bootstrap initializes `${CODEX_HOME:-$HOME/.codex}/auth.json` when it is missing or empty. An existing login can be reused. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Your Claude Code OAuth token. The launcher inherits it from the workspace environment. |

Agent sessions opened by this App use `codex --yolo` and `claude --dangerously-skip-permissions`.

## Restart or move the App

- **Same App URL.** The App rebuilds its workspace list from Domino. The relay inside the App is in memory. Connectors retry registration, and you may need to reopen browser terminals after the App restarts.
- **New project or App URL, same Domino account and deployment.** Workspace discovery follows the owner identity, so the new App can see those same workspaces. Set the connector environment ID on the new App project and update the environment hook to point to the new App URL. Running connectors retain their launch URL. They need to be restarted with the new URL, or the workspaces can be resumed using the updated environment revision.
- **Agent sessions.** Herdr, live agent processes, and saved Codex and Claude Code history reside in each workspace. Moving the App does not move those files or processes. With the workspace still running, a connector pointed at the new App can list panes from the workspace's existing Herdr server. After a workspace stop, history remains resumable if the workspace's home or configured history directories were persisted.

# Workspace Sessions for Domino

A Domino App for switching between your workspaces and the Codex and Claude Code sessions running in them. Each workspace runs its own connector and Herdr server. The App uses the Domino identity of its project owner to list and operate on that user's workspaces.

## Publish the App

1. Create a Git-based Domino project from this repository under your own Domino account. For a private GitHub repository, configure your GitHub credentials in Domino so it can clone the repo.
2. Publish an owner-only Domino App from the project using `app.sh` and port `8888`. Select a Linux compute environment with Python 3.11 or later, `venv`, and `pip`. At launch, `app.sh` installs the Python packages in `requirements.txt` into a virtual environment and starts Gunicorn. The environment needs package index access if those versions are absent.
3. Open the published App directly. On first use, **Setup** walks you through two steps:
   1. **Workspace connection.** When your Domino deployment allows workspace SSH, there is nothing to do. Otherwise Setup walks you through a connector environment, described below.
   2. **Agent sign-in.** Sign in to Claude Code, Codex, or both on your Mac and paste the result into Setup. See [Agent sign-in](#agent-sign-in).

   Use one Workspace Sessions App per Domino project. Reopen **Setup** from the header at any time.

Keep the App accessible only to its project owner. The App acts with that owner's access to their workspaces.

## Launch a connected workspace

The connector is a background process that runs **inside each workspace**. It registers with the App, reads locally saved agent history, and relays the workspace's Herdr terminals. It installs Herdr as needed and attempts to update the agent CLIs once per workspace execution.

### With Domino workspace SSH (default)

When Domino's workspace SSH setting is on, the App starts connectors over SSH:

- Workspaces you start or resume from the App turn on SSH and keep their own compute environment and revision.
- About every 10 seconds, the App looks for running workspaces of yours that have no connector. It logs in through Domino's SSH gateway with its owner identity, copies the connector into `~/.cache/domino-herdr`, and starts it in the background.
- The App verifies the gateway's host certificate against Domino's SSH host CA before it sends credentials.
- If SSH was off when a workspace started, its sessions pane offers **Restart workspace**. Domino stops the workspace and resumes it with SSH on.

The workspace environment needs `openssh-server`, which Domino Standard Environments and environments built from them include, plus Python 3 with `requests`, Bash, `flock`, and `setsid`. Each workspace needs network access to your Domino App and to the Codex, Claude Code, and Herdr release hosts. For connector startup failures, see `~/.cache/domino-herdr/connector.log` in the workspace.

Set `SESSION_HUB_SSH_USER` on the App if your environments log in as a user other than `ubuntu`. Set `SESSION_HUB_CONNECTION_MODE=environment` to use a connector environment even when workspace SSH is available.

### With a connector environment (fallback when workspace SSH is off)

Domino runs a compute environment's pre-run script whenever it starts a new execution from that environment, so a connector environment can start the connector without SSH. [Domino's Run Setup Scripts example](https://github.com/dominodatalab/Domino-Training-Workshop#lab-21---inspect-compute-environment)

In **Setup**, choose **Create from …** to build a private connector environment from the App project's default environment, or **Link environment** if one is already configured for this App. After setup shows **ready**, create a workspace with **Connect Codex and Claude Code to this app** selected. Projects where you launch workspaces need a default hardware tier and access to the connector environment. The base environment needs Python 3.11 or later with `requests`, Bash, `curl`, and `flock`. If your Domino account cannot create environments, someone with environment permissions can prepare one for you to link.

### Prepare an existing environment for linking

In the environment's **Run Setup Scripts → Pre-Run Script**, add the assignments below and paste [`session-hub-workspace-start.sh`](session-hub-workspace-start.sh) after them. Keep any existing setup your environment needs. Save and build the revision as required by your Domino deployment, then enter its environment ID in **Setup**.

```bash
SESSION_HUB_OWNER='your-domino-username'
SESSION_HUB_APP_URL='https://apps.example.com/modelproducts/your-app-id/'
```

Use the exact App URL shown in **Setup**. The hook uses the workspace's Domino sidecar to download the connector and launcher directly from the App. The App can also read `SESSION_HUB_WORKSPACE_ENVIRONMENT_ID`, `SESSION_HUB_BASE_ENVIRONMENT_ID`, and `SESSION_HUB_BASE_REVISION_ID` from its environment for deployments configured before the setup UI was added.

## Agent sign-in

**Setup → Agent sign-in** saves your Codex and Claude Code sign-in as Domino **user** environment variables, so they reach workspaces in every project you start them in. Set up one agent or both. Each one shows a command to run in Terminal on your Mac and a field to paste its result into.

| Agent | Run on your Mac | Paste into Setup | Saved as |
| --- | --- | --- | --- |
| Claude Code | `claude setup-token`, then sign in in the browser | The token it prints, starting with `sk-ant-oat01-` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | The command shown in Setup. It signs in to a separate Codex login for Domino and copies it to the clipboard. | The clipboard contents (⌘V) | `CODEX_AUTH_JSON_B64` |

The Codex command keeps its login in its own temporary `CODEX_HOME`, so Codex on your Mac stays signed in. **Other options** in Setup shows how to copy an existing Codex login instead.

**Renewing.** Claude Code tokens last about a year. Setup records the date it saves each sign-in and shows a banner a month before a Claude Code token expires. Codex refreshes its own login. If a workspace asks you to sign in to Codex again, repeat the steps. Choose **Renew** or **Replace** in Setup to save a new sign-in, or **Remove** to delete it from Domino.

**How sign-in reaches workspaces.**

- Workspaces receive user environment variables when they start.
- When you open a new session, the App also hands the connector its current sign-in, so renewed credentials work in workspaces that are already running. This applies to workspaces whose connector started with this App version. Restart older workspaces once.
- A workspace keeps a Codex login that Codex refreshed in it. It switches to the saved login only when that one is newer. Claude Code tokens from the App are kept per workspace run, in `~/.cache/domino-herdr/credentials`.
- If a project also defines `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_AUTH_JSON_B64`, its workspaces can start with that project value. Remove it if the sign-in saved in Setup doesn’t take effect there.

**How the App saves them.** Domino has no JSON API for user environment variables. The App uses the same form as **Account settings → User environment variables**, at `/account` on your Domino host, with its owner identity, and then reads the page again to confirm the change. It tries Domino’s internal API host first and then `DOMINO_URL`, so it doesn’t depend on a particular Domino hostname. If a deployment doesn’t allow this, Setup links to your account settings and shows the variable name to set by hand. Secret values never go back to the browser. Setup shows only status, saved date, and the Codex account name.

You can also set the variables yourself in **Account settings → User environment variables**. Use the Codex `auth.json` file encoded as base64 on one line.

Agent sessions opened by this App use `codex --yolo` and `claude --dangerously-skip-permissions`.

## Restart or move the App

- **Same App URL.** The App rebuilds its workspace list from Domino. The relay inside the App is in memory. Connectors retry registration, and you may need to reopen browser terminals after the App restarts.
- **New project, same Domino account and deployment.** The new App can see the same workspaces. With workspace SSH, it connects running SSH-enabled workspaces without setup. With connector environments, create one in the new App with the same base environment and revision as the previous one, or point an existing environment's hook at the new URL and link it. Workspaces already using a linked environment connect on their next start.
- **Resume a stopped workspace.** Choose **Resume workspace**. With workspace SSH, Domino resumes it in its own environment with SSH on. With connector environments, the App uses its connector environment when it is ready and the workspace uses the same base revision or a compatible previous connector environment. When the switch is unavailable, Domino starts the workspace with its existing settings. Domino keeps the workspace ID and storage.
- **Connect a running workspace.** Running workspaces with SSH on connect automatically. If the sessions pane offers **Restart workspace**, use it to stop running processes and start the workspace again.
- **Agent sessions.** Herdr, live agent processes, and saved Codex and Claude Code history reside in each workspace. Restarting a workspace ends its live processes. Saved conversations from a persisted home or configured history directory reappear in **History** when its connector reconnects.

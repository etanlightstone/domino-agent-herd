# Set up Herdr on this laptop

## Outcome

From Workspace Sessions, choose multiple Domino workspaces and set up a single local Herdr window in one guided pass. Existing Codex and Claude Code panes appear under the right workspace, including multiple agents in the same workspace. The next day, the user opens one local shortcut and gets back to work without revisiting the browser or starting SSH tunnels individually.

Use the original `herdr` terminal client. The separate Herdr graphical app uses herdr-core and has a different session runtime. On the laptop, each Domino workspace is one saved Herdr machine targeting the remote `domino-hub` session. Agent tabs and panes belong to that session. [Herdr](https://herdr.dev/) · [Herdr saved machines](https://herdr.dev/tui/docs/connecting-machines/)

## What the user sees

1. Open **Set up Herdr on this laptop** from the Workspace Sessions top bar. List the user's workspaces across projects, with the project and workspace name on each row. Preselect running workspaces with SSH enabled and a ready connector. Let the user change the selection. Show why other rows need attention, such as **Stopped**, **SSH off for this run**, or **Agent tools not ready**.
2. Detect the likely OS and offer an explicit macOS, Linux, or Windows selector. Show a **Copy setup command** action with the instruction **Paste into Terminal** or **Paste into PowerShell**. Offer a downloadable workspace list and setup instructions where a single command is impractical. The command and download should carry only workspace connection metadata.
3. The local helper detects OpenSSH, the `dom` SSH toolkit, and the original `herdr` client. Reuse compatible installations and working aliases. Guide the user through missing tools, Domino sign-in, and SSH trust prompts in the same local terminal. Resume setup where it left off if a managed install or a new terminal window is needed.
4. Show progress for all selected workspaces. Give each row or terminal status line a concrete result such as **Connected**, **Sign in again**, **Start this workspace in Domino**, or **Check the SSH host key**. Once at least one workspace is usable, open Herdr with all successful connections. Give the user one way to retry the rest.
5. On future visits, a local command and shortcut labeled **Herdr for Domino** restore or reuse the tunnels and open the same Herdr window. Running setup again can add workspaces to the existing selection. Offer an explicit local remove action for workspaces the user no longer wants listed.

When Domino allows workspace SSH, Workspace Sessions turns SSH on for every workspace it starts or resumes, because the App itself connects over SSH. A workspace started elsewhere with SSH off needs a restart from the App before laptop SSH can reach it. Keep restart an explicit user action because it ends live agents. Deployments with workspace SSH off use the connector environment instead, and laptop SSH is unavailable there. [Workspace start and resume](session_hub.py)

## Verify the connection contract first

Do this spike before building the modal or choosing how to distribute the helper.

- On the target Domino deployment, open two SSH-enabled workspaces with three live agents between them. Record the supported `dom` install source, supported local OSes and architectures, authentication and reauthentication flow, and the flags or configuration documented for local and remote data planes. The `dom` SSH toolkit is distinct from the general Domino CLI. Domino documents per-workspace `dom connect` and a generated SSH configuration. Its VS Code extension demonstrates detached tunnels and hybrid data-plane handling. [Domino SSH setup](https://docs.dominodatalab.com/en/6.2/user_guide/9976a5/streamline-local-development-with-ssh/) · [Domino VS Code extension](https://marketplace.visualstudio.com/items?itemName=DominoDataLab.domino-data-lab-vscode-extension)
- Prove that standard OpenSSH can use each tunnel and generated alias from a normal laptop terminal. Confirm it lands under the workspace user who owns the existing Herdr server. Check how `herdr` is found in a non-interactive SSH shell, especially when provisioned in `~/.local/bin`.
- Add both aliases with `herdr machine add <alias> --remote-session domino-hub --label <workspace-label>`. Verify the agent names, live terminals, and switching. Find the minimum supported client and server versions for saved machines. A working one-off remote attach alone is insufficient because saved machines require additional server capabilities. Keep live agents running during compatibility checks. [Herdr connection setup and compatibility](https://herdr.dev/tui/docs/connecting-machines/)
- Kill a tunnel, close the local terminal, put the laptop to sleep, and restart one workspace in separate checks. Record which paths recover with plain `herdr`, which require restarting `dom connect`, and which require a fresh Domino sign-in. Verify stable SSH aliases and distinct loopback ports across both workspaces. Check the supported behavior for host-key rotation after a workspace restart and how Domino conveys trusted host identity.
- Repeat with a workspace that has no agents. Confirm the shell opens in the expected project directory, then start Codex or Claude Code from a new tab. A stopped Domino workspace requires a Domino start or resume before agents can run there. The app's merged History picker is a separate feature. [Herdr workflow](https://herdr.dev/tui/docs/quick-start/) · [Existing agent inventory and launch](session_hub_agent.py#L297)

Record exact successful commands, versions, and clean-laptop results in the implementation handoff. Enable guided setup on each OS only after proving its end-to-end tunnel and reopen paths.

## Implementation

### 1. Export workspace connection details from the App

- Reuse `GET /api/inventory` for selection and owner filtering. A small setup endpoint can accept selected workspace IDs, recheck ownership and current status server-side, and return a versioned manifest. Reuse the existing Domino identity and origin protections. Group workspace labels by project when names collide. [Inventory and workspace summary](session_hub.py#L365) · [Browser setup logic](session-hub/hub.js#L151)
- Include a schema version, Domino base URL, and for each workspace the stable workspace ID, display label, and applicable data-plane host. Include a verified SSH username when available. Otherwise use the deployment's documented default with an editable local override. Determine eligibility from the active execution when available so a saved workspace-template setting cannot make the current run look ready. The generated export carries no session token, API key, SSH key, agent credential, or live terminal data.
- Create a small, platform-specific command that invokes a versioned helper with the selected workspace data. Provide a **Download setup file** path for large selections and an inspectable download path for managed laptops. Treat exported values as data, including names containing whitespace or quotes. Use argument arrays for subprocesses and validate the manifest, hostnames, IDs, and any tool download origins. Keep a user's browser session and local Domino authentication separate.
- Choose a release channel that the laptop can actually reach. Prefer an approved package or a versioned helper distributed with published checksums. For the copy command, download the named release, verify the expected digest, then execute it. If distribution requires browser authentication, download through the browser and run locally. A terminal download cannot assume access to the browser's cookies.

### 2. Build a small local helper

Use a single cross-platform CLI, preferably a native binary with user-local installation. Choose the language after the transport spike. A small Go binary is a reasonable default if there is no existing component to extend. Use shell and PowerShell only for bootstrapping the approved release.

| Command | Behavior |
| --- | --- |
| `setup` | Read the manifest, check tools, guide sign-in, connect the selection, and open Herdr. Safe to rerun after a partial setup. |
| `open` | Verify or start the saved connections, then exec or launch the original `herdr` client in a terminal. The local shortcut calls this command. |
| `doctor` | Show client versions and the status of Domino authentication, tunnel, SSH, Herdr session, and agent tooling per workspace. Give a targeted next action for the first failed layer. |
| `remove` | Remove the selected local registration and any tunnel owned solely by the helper. Disconnecting the laptop leaves remote agents running. |

- Call the supported `dom connect` flow for tunnels and use Herdr's supported `machine` commands for registration, status, and removal. Store the stable Domino instance and workspace ID alongside the opaque Herdr machine ID. Use project/name as the display label. Treat renames as label changes and preserve manually registered Herdr profiles. Avoid parsing human-readable CLI output when a documented machine-readable interface or generated configuration is available. [Herdr CLI reference](https://herdr.dev/tui/docs/cli-reference/) · [Herdr machine settings and saved data](https://herdr.dev/tui/docs/connecting-machines/#settings-and-automation)
- Prefer Domino-generated SSH settings and reuse known working aliases. If an include is needed, put app-managed entries in their own file, add one include to the user's OpenSSH config, and verify effective settings with `ssh -G`. Preserve preexisting SSH configuration, file permissions, and keys. Use stable aliases, detect port collisions, and confirm the alias actually reaches the expected workspace before registering it.
- Keep SSH host verification enabled. Use Domino's documented identity material or the normal OpenSSH trust prompt. Report changed host keys with instructions appropriate to the deployment. Let `dom` handle Domino credentials and local OpenSSH handle SSH credentials.
- Persist per-user connection state outside the App, keyed by Domino instance and workspace ID. Use atomic state updates and per-workspace locking so simultaneous setup and reopen commands cannot start competing tunnels. Store only metadata and references to helper-owned processes. Verify a tunnel with SSH before declaring it healthy. Time-bound tunnel startup and use limited parallelism. If several workspaces need interactive sign-in, serialize prompts.
- Prefer the vendor's supported detached or reconnectable tunnel mode when proven. If tunnels need active supervision, keep the helper running while Herdr is open so it can recover after sleep or network changes where credentials allow. The helper can hand off directly to Herdr when the vendor's transport handles recovery. Keep the initial launch and the retry path interactive when sign-in is required. Offer startup at login only where it improves reopening and has been verified on that OS.

### 3. Support each laptop environment explicitly

| Laptop | Setup and reopen | Verify before calling it supported |
| --- | --- | --- |
| macOS | Terminal command, system OpenSSH, reuse the installed Herdr or use its supported macOS installer. Install the helper and shortcut per user. | Apple silicon and Intel where Domino distributes the applicable toolkit. Validate Terminal launch, sleep/wake, and managed-machine installation policy. |
| Linux | POSIX shell command, distro OpenSSH client, reuse the installed Herdr or use an official release. Offer a user-local launcher command and desktop entry where supported. | Target distro and architecture, noninteractive PATH, and tunnel recovery on a laptop without a system-wide service install. |
| Windows | PowerShell command, Windows OpenSSH Client, and the complete native Herdr Windows package. Launch the helper in a terminal through a user-level shortcut. | Confirm the native `dom` build for the deployment and its SSH config paths. Test with the same Windows OpenSSH binary that Herdr uses. Verify expired authentication interactively because native Windows Herdr lacks the saved-machine SSH recovery flow documented for macOS and Linux. Confirm the install path works under the organization's rules for unsigned binaries. |

If a required tool is unavailable for an OS or architecture, show the specific missing prerequisite and the browser fallback. Treat WSL2 as a separately tested option, with the helper, `dom`, OpenSSH, and Herdr running together inside WSL. [Herdr install](https://herdr.dev/tui/docs/install/) · [Herdr Windows support](https://herdr.dev/tui/docs/windows-beta/) · [Windows OpenSSH client](https://learn.microsoft.com/en-us/windows/terminal/tutorials/ssh)

### 4. Make new agent sessions easy to launch

The first version can use normal Herdr tabs and splits, with `codex` and `claude` launched in a remote shell. Make that obvious in first-run instructions when the selected workspace has no agents. The shell, repo, CLIs, and agent authentication are workspace-side. If the workspace shell has a different PATH or agent setup from app-created panes, fix that in workspace provisioning. Test both Codex and Claude Code in a fresh pane before marking the workspace ready for local use. [Workspace bootstrap](herdr-workspace.sh) · [Herdr quick start](https://herdr.dev/tui/docs/quick-start/)

If people want the same ease as the browser's launch buttons, add a workspace-side launcher or documented Herdr shortcuts for **New Codex** and **New Claude Code**. Start in the project directory, open a named tab, and use the environment's configured agent credentials and permissions. If those tabs should also appear in the browser, update and test the browser's discovery logic, which currently filters by tab label. Add history integration only if users need a merged conversation picker in Herdr. [Current pane filter](session_hub_agent.py#L249) · [Herdr custom keybindings](https://herdr.dev/tui/docs/configuration/#custom-command-keybindings)

### 5. Make the published App optional after provisioning

The laptop should use Domino SSH to connect directly to the workspace Herdr server. The App currently starts the connector by sending it over Domino SSH, or through the connector environment's pre-run hook. Test reopening against running workspaces with the App stopped. Then provide a compute-environment or project bootstrap that installs the required tools and starts or makes available `domino-hub` independently of those downloads. Keep the browser connector optional for users who want both experiences. Validate a fresh workspace start with the published App unavailable before promising full independence across workspace restarts. [Current pre-run hook](session-hub-workspace-start.sh#L20) · [Current server startup](session_hub_agent.py#L84)

## Acceptance and delivery order

1. **Prove the transport.** Verify two concurrent Domino tunnels, one Herdr window, the original running panes, and reconnect behavior. Capture the supported toolkit and platform matrix.
2. **Ship the local workflow.** On each supported platform, test a clean laptop and an existing install. Set up two workspaces with three live agents using one command. Verify an empty workspace can start a new agent remotely. Run setup twice, retry a partial failure, rename one workspace, and remove a local connection safely.
3. **Add the browser handoff.** Test shared or incorrectly scoped IDs, stopped and SSH-disabled workspaces, a large selection using the download path, and names with punctuation or non-ASCII characters. Verify the exported data and local logs contain no credentials.
4. **Test tomorrow's launch.** Starting from the saved local shortcut, test shell closure, laptop sleep, laptop reboot, tunnel failure, expired Domino auth, changed host identity, and one stopped workspace while another works. Confirm that the user sees a clear action and that healthy connections remain usable. After a workspace restart, verify reconnection and whatever persisted layout or history the workspace supports. Live processes end when the Domino workspace stops.
5. **Verify independence.** With the published App unavailable, confirm the local shortcut reconnects to existing sessions. Test a fresh workspace start using App-independent provisioning, then launch both agents from Herdr. Keep the optional browser workflow working after the change.

The release bar is a reliable first run and a repeatable one-action reopen. Prefer the copy command and a local shortcut until the supported platform paths meet that bar. A browser protocol handler is an optional convenience once the local helper is installed.

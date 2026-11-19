# macOS app options for Workspace Sessions

The Mac app would list Domino workspaces, launch or resume Codex and Claude Code sessions, and attach to their terminals. Herdr and the agents would continue running inside the workspace. The main decision is how the Mac reaches those sessions when the published Workspace Sessions App is turned off.

Today the browser talks to the published App over HTTPS. A connector inside each workspace downloads its code from that App, registers with it, and polls it for Herdr commands. The App relays terminal input and output. Turning it off removes both the relay and the connector download URL. Domino OAuth handles sign-in. Each option below still needs a network path and a credential that the service on that path accepts. [Current workspace setup](README.md#launch-a-connected-workspace)

## 1. Mac app with Domino SSH

**SSH enabled per workspace. No published Workspace Sessions App or separate relay.**

- Keep SSH out of the workspace creation dialog until desktop support ships. If the SSH design ships, ask whether the user wants to connect with the desktop app and enable SSH for that workflow.
- Use Domino's API for workspace discovery and lifecycle operations. Use Domino's SSH tunnel to run a workspace-side helper that talks to Herdr and relays terminal input and output to the Mac.
- Package the helper and launcher into the compute environment or install them through a setup script. Reuse the current workspace-side logic for agent inventory, history, launch, and terminal attach where practical.
- Prototype with the published App stopped. Verify that the SSH session runs as the user who owns the Herdr session, that it can attach to an existing agent, and that closing and reopening the Mac app reconnects to that agent.

This is the first option to prototype if the goal is to run only the Mac app and the Domino workspace and the deployment supports workspace SSH. [Domino SSH setup](https://domino.ai/resources/blueprints/getting-started-domino-vs-code-extension)

## 2. Mac app with a replacement HTTPS relay

**SSH off. No published Workspace Sessions App. Requires a relay the Mac and the workspace can both reach.**

- Package the connector and launcher into the compute environment. Point the startup hook at a new HTTPS relay and adapt connector registration and workspace ownership checks for that service.
- Reuse the existing registration, polling, and terminal message formats where practical. Authenticate desktop callers and workspace connectors, and scope terminal access to the authorized user and workspace.
- Host the relay on a stable service outside the published Domino App. A relay running on the Mac is also possible if Domino can initiate HTTPS connections to it. Test inbound reachability and reconnect behavior across sleep, VPN changes, and network changes before relying on that setup.
- Prototype with SSH off and the published App stopped. Verify that the connector starts from its packaged copy, registers with the replacement relay, and can reconnect after a network interruption.

## 3. Mac app backed by the published Domino App

**SSH off. The published Workspace Sessions App stays running as the relay and connector download host.**

- Start with a Tauri shell that loads the published App URL and reuses the existing UI and terminal. Tauri uses macOS's built-in WebKit and supports Rust for desktop code. Electron is another option if a bundled Chromium renderer is preferred. [Tauri webview docs](https://tauri.app/reference/webview-versions/)
- Test whether the deployment's Domino SSO works in the embedded window, then verify terminal attach and reconnect. This path keeps requests on the published App's origin.
- If the UI is later bundled locally or a Rust client calls the API directly, verify which credentials the private App proxy accepts from a desktop client. Add an explicit authentication path for native requests while preserving the browser's origin check. [Current origin check](session_hub.py#L69)

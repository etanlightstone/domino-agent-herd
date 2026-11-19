# Side-by-side sessions (idea, not scheduled)

Show several agent terminals at once and move between tiled and full-screen quickly. Today the UI holds one terminal at a time and switches sessions with tabs. This note records the idea and what we found so we can pick it up later.

## Interaction model

The goal is the feel of a tiling window manager. Omarchy is built on Hyprland, so these behaviors come from Hyprland's focus options and Omarchy's default key bindings. We are borrowing the interaction only, not any code.

- **Hover is focus.** Moving the mouse over a tile makes it the active tile. It gets keyboard input and a visible focus ring. No click is needed. Hyprland calls this `follow_mouse`. Mode 1 always moves focus to the window under the cursor. [Hyprland variables](https://wiki.hypr.land/0.44.0/Configuring/Variables/)
- **Change focus only when the cursor crosses a tile boundary.** This is Hyprland's `mouse_refocus = false` behavior. It stops focus from flipping when a tile redraws under a stationary cursor, which matters because terminal output changes constantly. [Hyprland variables](https://wiki.hypr.land/0.44.0/Configuring/Variables/)
- **One key toggles the hovered tile between full screen and tiled.** Omarchy binds Super+F to fullscreen. We would use a plain key that xterm does not need, and restore the previous layout when it is pressed again. [Omarchy hotkeys](https://learn.omacom.io/2/the-omarchy-manual/53/hotkeys.md)
- **Keyboard navigation as a fallback.** Omarchy moves focus with Super+arrows and swaps tiles with Super+Shift+arrows. Hover alone is awkward on touch and for people who keep their hands on the keyboard. [Omarchy navigation](https://learn.omacom.io/2/the-omarchy-manual/51/navigation)
- **Layout presets.** Omarchy cycles layouts with Super+L. We could offer Tabs, Split 2 and Grid 4, and remember the last choice. [Omarchy hotkeys](https://learn.omacom.io/2/the-omarchy-manual/53/hotkeys.md)

### Details to settle

- Keystrokes must go to the hovered tile only, and typing must never move focus mid-sentence. A brief hover delay, or ignoring focus changes while a key is held, would avoid that.
- Decide how a full-screen toggle is triggered when the terminal is capturing most keys. Candidates are a tile header button, a double-click on the header, or a key chord the terminal never receives.
- Inactive tiles should stay live but look dimmed. Selecting text in an inactive tile should not steal focus.
- Search for Omarchy forum threads did not turn up discussion of focus-follows-mouse. Before building, look at how Omarchy and Hyprland users configure it and what they complain about.

## Technical approach

The relay is already per-channel, so a same-workspace split should not need backend changes. We have not read `session_hub_broker.py` or the connector, so confirm they accept several channels at once.

- `session-hub/hub.js` keeps one global `terminal`, one `#terminal` mount, and `detachTerminal` tears down that one terminal. Replace the global with a map of channel to session. Give each session its own mount, terminal bar and Detach button.
- Lay tiles out with a CSS grid. The existing `ResizeObserver` and `fit()` calls per terminal handle sizing.
- Each tile sends its own `terminal.resize`. Narrow tiles give the agent fewer columns. If the same pane is open in two browsers, the two will fight over size.
- Each open terminal long-polls the App. Check the broker's behavior with two to four terminals.
- A `closed` result should close that tile only. Release only the channels that are closed.
- Panes from different workspaces in one split are a later step. Connector and broker state is per workspace.

const byId = id => document.getElementById(id);
const dialog = byId('dialog');
const dialogBody = byId('dialog-body');
const projectsDialog = byId('projects-dialog');
const historyDialog = byId('history-dialog');
let data;
let selected;
const pending = new Set();
const changing = new Map();

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function link(text, url, className) {
  const node = element('a', text, className);
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener';
  return node;
}

function notice(message, error = false) {
  byId('status').textContent = message;
  byId('status').dataset.error = error;
  byId('status').hidden = !message;
}

async function api(path, body, signal) {
  const options = body === undefined ? {signal} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  };
  const response = await fetch('./api/' + path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (HTTP ${response.status}).`);
  return result;
}

async function refresh() {
  data = await api('inventory');
  selected ??= data.hubProject;
  render();
}

function render() {
  const running = data.workspaces.filter(workspace => workspace.running && !changing.has(workspace.id));
  const retained = running.find(workspace => workspace.id === agentWorkspace?.id &&
    workspace.run === agentWorkspace?.run);
  const previous = localStorage.getItem('workspace-sessions-active');
  const next = retained || running.find(workspace => workspace.id === previous) ||
    running.find(workspace => workspace.connector.ready) || running[0];
  if (next && !retained) showAgents(next);
  if (!next && agentWorkspace) closeWorkspace();
  renderWorkspaceTabs();
  byId('empty-workspaces').hidden = Boolean(next);
  renderProjects();
  renderDetail();
}

function renderWorkspaceTabs() {
  const running = data?.workspaces.filter(workspace => (workspace.running || pending.has(workspace.id)) &&
    !changing.has(workspace.id)) || [];
  setTabs('workspace-tabs', running.map(workspace => {
    const repeated = running.filter(item => item.projectId === workspace.projectId).length > 1;
    const label = repeated ? workspace.project + ' / ' + workspace.name : workspace.project;
    const tab = button(label, () => showAgents(workspace), 'workspace-tab');
    tab.title = workspace.name;
    tab.dataset.key = workspace.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'agent-panel');
    tab.setAttribute('aria-selected', String(workspace.id === agentWorkspace?.id));
    tab.disabled = !workspace.running;
    if (tab.disabled) tab.textContent += ' · Starting';
    return tab;
  }));
}

function browseProjects() {
  if (projectsDialog.open) return;
  if (agentWorkspace) selected = agentWorkspace.projectId;
  if (data) {
    renderProjects();
    renderDetail();
  }
  projectsDialog.showModal();
  byId('search').focus();
}

function renderProjects() {
  const search = byId('search').value.trim().toLowerCase();
  const projects = search ? data.projects.filter(project =>
    `${project.owner}/${project.name}`.toLowerCase().includes(search)) : data.projects.slice(0, 15);
  const buttons = projects.map(project => {
    const control = button(project.name, () => {
      selected = project.id;
      renderProjects();
      renderDetail();
    });
    control.title = `${project.owner}/${project.name}`;
    control.setAttribute('aria-pressed', project.id === selected);
    return control;
  });
  byId('projects').replaceChildren(...(buttons.length ? buttons : [element('p', 'No matching projects.')]));
}

function renderDetail() {
  const project = data.projects.find(item => item.id === selected);
  if (!project) return;
  const heading = element('div', '', 'heading');
  const title = element('div');
  title.append(element('h2', project.name), link(project.owner + ' / Domino project', project.url));
  heading.append(title, button('Start new workspace', () => createDialog(project), 'primary'));
  const rows = data.workspaces.filter(workspace => workspace.projectId === project.id);
  byId('detail').replaceChildren(heading, ...(rows.length ? rows.map(workspace => row(workspace)) :
    [element('p', 'You have no workspaces in this project.')]));
}

function row(workspace) {
  const container = element('article', '', 'row');
  const label = element('div');
  const transition = changing.get(workspace.id);
  const state = transition || (pending.has(workspace.id) ? 'Starting' : workspace.running ? 'Running' : workspace.state);
  const meta = element('div', '', 'meta');
  const badge = element('span', state, 'status-tag');
  badge.dataset.running = workspace.running;
  badge.dataset.starting = Boolean(transition) || pending.has(workspace.id);
  meta.append(badge);
  if (workspace.running && workspace.connector.ready) {
    meta.append(document.createTextNode('  ·  Agent sessions ready'));
  } else if (workspace.running && (workspace.managed || workspace.connector.connected)) {
    meta.append(document.createTextNode('  ·  Connector starting'));
  }
  label.append(element('strong', workspace.project === data.projects.find(project => project.id === selected)?.name &&
    !workspace.running ? workspace.name : workspace.project), meta);
  if (workspace.running || workspace.projectId !== selected) label.append(element('div', workspace.name, 'meta'));
  const controls = element('div', '', 'actions');
  if (workspace.running && !transition) {
    controls.append(link('Open workspace', workspace.ide, 'button'),
      button('Open sessions', () => {
        projectsDialog.close();
        showAgents(workspace);
      }, 'primary'),
      button('Stop', () => confirmWorkspaceAction(workspace, 'stop')));
  } else if (workspace.state === 'Stopped' && !transition && !pending.has(workspace.id)) {
    const path = `projects/${workspace.projectId}/workspaces/${workspace.id}/resume`;
    controls.append(button('Resume workspace', () => runAction(path, {}), 'primary'));
    if (workspace.canEnable && data.managedAvailable) {
      controls.append(button('Resume with agent sessions', () => runAction(path, {managed: true})));
    }
    controls.append(button('Delete', () => confirmWorkspaceAction(workspace, 'delete'), 'danger'));
  }
  container.append(label, controls);
  return container;
}

let agentWorkspace;
let terminal;
let panelRefresh;
let loadNumber = 0;
let attachment = 0;
let activeStart = false;
let runningAgents = [];
let selectedPane;
let autoAttach = false;
let historyRows = [];
let visibleView = 'agent';

function agentNotice(message, error = false) {
  byId('agent-summary').textContent = message;
  byId('agent-summary').hidden = !message;
  byId('agent-summary').classList.toggle('error', error);
}

function agentPath(workspace = agentWorkspace) {
  return `projects/${workspace.projectId}/workspaces/${workspace.id}/agents`;
}

function workspaceKey(workspace) {
  return `${workspace.id}:${workspace.run || ''}`;
}

function closeWorkspace() {
  attachment++;
  clearTimeout(panelRefresh);
  detachTerminal();
  agentWorkspace = undefined;
  byId('agent-panel').hidden = true;
  byId('ide-frame').replaceChildren();
}

function showAgents(workspace) {
  if (agentWorkspace?.id === workspace.id && agentWorkspace.run === workspace.run) {
    showAgentTerminal();
    return;
  }
  closeWorkspace();
  agentWorkspace = workspace;
  runningAgents = [];
  selectedPane = undefined;
  autoAttach = true;
  visibleView = 'agent';
  localStorage.setItem('workspace-sessions-active', workspace.id);
  byId('agent-panel').hidden = false;
  byId('agent-title').textContent = workspace.project;
  byId('workspace-name').textContent = workspace.name;
  byId('workspace-controls').replaceChildren(
    button('Stop workspace', () => confirmWorkspaceAction(workspace, 'stop'))
  );
  ['agent-controls', 'agent-running', 'workspace-ide'].forEach(id => byId(id).replaceChildren());
  byId('agent-view').hidden = false;
  byId('ide-panel').hidden = true;
  byId('agent-empty').hidden = true;
  agentNotice('Loading agent sessions…');
  renderWorkspaceTabs();
  loadWorkspaceIDE(workspace);
  loadAgents(workspace);
}

function showAgentTerminal() {
  visibleView = 'agent';
  byId('agent-view').hidden = false;
  byId('ide-panel').hidden = true;
  const tab = byId('workspace-ide').querySelector('[role=tab]');
  if (tab) tab.setAttribute('aria-selected', 'false');
  renderAgentTabs();
  if (terminal) {
    terminal.fit.fit();
    terminal.view.focus();
  }
}

async function loadWorkspaceIDE(workspace) {
  const label = workspace.tool === 'vscode' ? 'VS Code' : 'Open IDE';
  const url = `./workspaces/${workspace.projectId}/${workspace.id}/ide`;
  const fallback = link(label, url, 'button ide-link');
  fallback.title = 'Open the workspace IDE in a browser tab';
  byId('workspace-ide').replaceChildren(fallback);
  try {
    const info = await api(`projects/${workspace.projectId}/workspaces/${workspace.id}/ide?origin=${encodeURIComponent(location.origin)}`);
    if (agentWorkspace !== workspace) return;
    if (!info.embed) {
      fallback.href = info.url;
      return;
    }
    const openIDE = button(label, () => {
      visibleView = 'ide';
      byId('agent-view').hidden = true;
      byId('ide-panel').hidden = false;
      byId('ide-title').textContent = label;
      byId('ide-actions').replaceChildren(link('Open in browser tab', info.url, 'button'),
        button('Back to agents', showAgentTerminal));
      if (!byId('ide-frame').firstChild) {
        const frame = element('iframe');
        frame.title = `${label} · ${workspace.project}`;
        frame.src = info.url;
        byId('ide-frame').append(frame);
      }
      openIDE.setAttribute('aria-selected', 'true');
      renderAgentTabs();
    }, 'agent-tab ide-link');
    openIDE.setAttribute('role', 'tab');
    openIDE.setAttribute('aria-controls', 'ide-panel');
    openIDE.setAttribute('aria-selected', 'false');
    byId('workspace-ide').replaceChildren(openIDE);
  } catch {
    // The redirect link can resolve the IDE when its route becomes ready.
  }
}

function agentKind(item) {
  return item.kind === 'claude' || item.label?.startsWith('Claude Code') ? 'Claude Code' : 'Codex';
}

function setTabs(id, tabs) {
  const row = byId(id);
  const left = row.scrollLeft;
  const focused = row.contains(document.activeElement) && document.activeElement.dataset.key;
  row.replaceChildren(...tabs);
  row.scrollLeft = left;
  if (focused) tabs.find(tab => tab.dataset.key === focused)?.focus({preventScroll: true});
}

function renderAgentTabs() {
  setTabs('agent-running', runningAgents.map(item => {
    const kind = agentKind(item);
    const title = item.title || item.label || kind;
    const tab = button('', () => selectAgent(item), 'agent-tab');
    tab.dataset.key = item.pane;
    const caption = title.startsWith(kind + ' · ') ? title.slice(kind.length + 3) : title;
    tab.append(element('span', kind, 'agent-kind'), element('span', caption, 'agent-tab-title'));
    if (item.status) {
      const dot = element('span', '', 'agent-dot');
      dot.dataset.state = item.status.toLowerCase();
      tab.append(dot);
    }
    tab.title = [title, item.status].filter(Boolean).join(' · ');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'agent-view');
    tab.setAttribute('aria-selected', String(visibleView === 'agent' && selectedPane === item.pane));
    return tab;
  }));
}

function selectAgent(item) {
  showAgentTerminal();
  if (selectedPane === item.pane && terminal) return;
  launchAgent({pane: item.pane}, item.title || item.label);
}

async function loadAgents(workspace) {
  if (!workspace || agentWorkspace !== workspace) return;
  clearTimeout(panelRefresh);
  const load = ++loadNumber;
  try {
    const list = await api(agentPath(workspace) + '?live=1');
    if (agentWorkspace !== workspace || load !== loadNumber) return;
    if (!list.ready) {
      byId('agent-controls').replaceChildren();
      if (!list.connected && workspace.canEnable && data.managedAvailable) {
        byId('agent-controls').append(button('Restart with agent sessions',
          () => confirmConnectorRestart(workspace), 'primary'));
      }
      runningAgents = [];
      renderAgentTabs();
      agentNotice(list.detail || (workspace.managed
        ? 'Waiting for the workspace connector to start…'
        : workspace.canEnable && data.managedAvailable
          ? 'Restart this workspace to enable agent sessions here.'
          : 'Agent sessions are unavailable for this workspace’s environment.'));
      return;
    }
    if (byId('agent-controls').dataset.workspace !== workspaceKey(workspace) ||
        !byId('agent-controls').querySelector('#new-codex')) {
      const codex = button('New Codex', () => launchAgent({kind: 'codex'}), 'primary');
      codex.id = 'new-codex';
      const claude = button('New Claude Code', () => launchAgent({kind: 'claude'}));
      claude.id = 'new-claude';
      byId('agent-controls').dataset.workspace = workspaceKey(workspace);
      byId('agent-controls').replaceChildren(codex, claude, button('History', openHistory));
    }
    if (!activeStart && !byId('agent-summary').classList.contains('error')) agentNotice(list.detail || '');
    runningAgents = list.running;
    renderAgentTabs();
    const empty = byId('agent-empty');
    empty.hidden = Boolean(terminal) || Boolean(selectedPane);
    empty.textContent = runningAgents.length ? 'Choose an agent tab to attach.' :
      'Start an agent or resume a conversation from History.';
    if (autoAttach && runningAgents.length && !terminal && !selectedPane && visibleView === 'agent') {
      autoAttach = false;
      const previous = sessionStorage.getItem('agent:' + workspaceKey(workspace));
      selectAgent(runningAgents.find(item => item.pane === previous) || runningAgents[0]);
    }
  } catch (error) {
    if (agentWorkspace === workspace && load === loadNumber) agentNotice(error.message, true);
  } finally {
    if (agentWorkspace === workspace && load === loadNumber) {
      panelRefresh = setTimeout(() => loadAgents(workspace), 4500);
    }
  }
}

const historyDate = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});

async function openHistory() {
  const workspace = agentWorkspace;
  byId('history-title').textContent = `Conversation history · ${workspace.project}`;
  byId('history-search').value = '';
  historyRows = [];
  byId('history-list').replaceChildren(element('p', 'Loading saved conversations…'));
  historyDialog.showModal();
  byId('history-search').focus();
  try {
    const list = await api(agentPath(workspace));
    if (!historyDialog.open || agentWorkspace !== workspace) return;
    historyRows = [...(list.saved || [])].sort((a, b) => b.updated - a.updated);
    renderHistory();
  } catch (error) {
    if (historyDialog.open) byId('history-list').replaceChildren(element('p', error.message, 'error'));
  }
}

function renderHistory() {
  const query = byId('history-search').value.trim().toLowerCase();
  const results = historyRows.filter(item =>
    `${item.label} ${agentKind(item)} ${item.id}`.toLowerCase().includes(query));
  const rows = results.map(item => {
    const kind = agentKind(item);
    const row = element('article', '', 'history-row');
    const updated = new Date(item.updated * 1000);
    const meta = [kind, !Number.isNaN(updated.getTime()) && item.updated > 0 ? historyDate.format(updated) : '',
      item.id.slice(0, 8)];
    const content = element('div');
    content.append(element('strong', item.label || 'Untitled conversation'),
      element('p', meta.filter(Boolean).join(' · '), 'meta'));
    row.append(content, button('Resume', () => {
      if (activeStart) return;
      historyDialog.close();
      launchAgent({kind: item.kind, conversation: item.id}, item.label);
    }));
    return row;
  });
  byId('history-list').replaceChildren(...(rows.length ? rows : [element('p', query
    ? 'No saved conversations match your search.' : 'No saved conversations in this workspace.')]));
}

async function launchAgent(payload, label) {
  const starting = !payload.pane;
  if (starting && activeStart) return;
  const workspace = agentWorkspace;
  const ticket = ++attachment;
  if (starting) activeStart = true;
  autoAttach = false;
  detachTerminal();
  selectedPane = payload.pane;
  visibleView = 'agent';
  showAgentTerminal();
  byId('agent-empty').hidden = true;
  agentNotice(payload.pane ? 'Attaching…' : payload.conversation ? 'Resuming conversation…' : 'Starting agent…');
  try {
    const opened = await api(agentPath(workspace) + (payload.pane ? '/attach' : ''), payload);
    if (agentWorkspace !== workspace || attachment !== ticket) {
      api('terminals/' + opened.channel, {type: 'terminal.release'}).catch(() => {});
      return;
    }
    selectedPane = opened.pane || payload.pane;
    if (selectedPane) sessionStorage.setItem('agent:' + workspaceKey(workspace), selectedPane);
    openTerminal(opened.channel, opened.label || label);
    renderAgentTabs();
    agentNotice('');
  } catch (error) {
    if (agentWorkspace === workspace && attachment === ticket) {
      selectedPane = undefined;
      renderAgentTabs();
      agentNotice(error.message, true);
    }
  } finally {
    if (starting) activeStart = false;
    if (agentWorkspace === workspace && attachment === ticket) loadAgents(workspace);
  }
}

const encodeInput = value => {
  const bytes = new TextEncoder().encode(value);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
};
const decodeFrame = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

function terminalTheme() {
  return document.documentElement.dataset.theme === 'dark'
    ? {background: '#1a1923', foreground: '#f4f3fa', cursor: '#b7aaff', selectionBackground: '#514367'}
    : {background: '#ffffff', foreground: '#2e2e38', cursor: '#543fde', selectionBackground: '#e4ddff'};
}

function openTerminal(channel, label) {
  const panel = byId('terminal-panel');
  const mount = byId('terminal');
  const view = new Terminal({
    cursorBlink: true, fontSize: 13, convertEol: false, scrollback: 3000, theme: terminalTheme()
  });
  const fit = new FitAddon.FitAddon();
  const session = {channel, view, sequence: 0, sending: Promise.resolve(), poll: new AbortController()};
  function send(action) {
    session.sending = session.sending.then(() =>
      terminal === session ? api('terminals/' + channel, action) : undefined
    ).catch(error => {
      if (terminal === session) agentNotice(error.message, true);
    });
  }
  terminal = session;
  view.loadAddon(fit);
  byId('terminal-title').textContent = label;
  panel.hidden = false;
  view.open(mount);
  view.onData(value => {
    for (let pos = 0; pos < value.length; pos += 8000) {
      send({type: 'terminal.input', bytes: encodeInput(value.slice(pos, pos + 8000))});
    }
  });
  view.onResize(({cols, rows}) => send({
    type: 'terminal.resize', cols: Math.max(10, Math.min(350, cols)), rows: Math.max(4, Math.min(140, rows))
  }));
  session.fit = fit;
  session.resize = new ResizeObserver(() => { if (visibleView === 'agent') fit.fit(); });
  session.resize.observe(mount);
  fit.fit();
  send({type: 'terminal.resize', cols: Math.max(10, Math.min(350, view.cols)), rows: Math.max(4, Math.min(140, view.rows))});
  view.focus();
  pumpTerminal(session);
}

async function pumpTerminal(session) {
  if (terminal !== session) return;
  try {
    const result = await api(
      'terminals/' + session.channel + '?wait=12&after=' + session.sequence, undefined, session.poll.signal
    );
    if (terminal !== session) return;
    for (const frame of result.frames) {
      session.view.write(decodeFrame(frame.bytes));
      session.sequence = frame.seq;
    }
    if (!result.closed) {
      pumpTerminal(session);
      return;
    }
    detachTerminal();
    selectedPane = undefined;
    renderAgentTabs();
    agentNotice('The terminal disconnected. Select the agent to attach again.', true);
  } catch (error) {
    if (terminal === session) {
      detachTerminal();
      selectedPane = undefined;
      renderAgentTabs();
      agentNotice(error.message, true);
    }
  }
}

function detachTerminal() {
  if (!terminal) return;
  const session = terminal;
  terminal = null;
  session.poll.abort();
  session.resize.disconnect();
  session.view.dispose();
  byId('terminal-panel').hidden = true;
  byId('terminal').replaceChildren();
  api('terminals/' + session.channel, {type: 'terminal.release'}).catch(() => {});
}

byId('terminal-detach').addEventListener('click', () => {
  attachment++;
  detachTerminal();
  selectedPane = undefined;
  autoAttach = false;
  renderAgentTabs();
  loadAgents(agentWorkspace);
});

function confirmWorkspaceAction(workspace, action) {
  const deleting = action === 'delete';
  const title = deleting ? 'Delete workspace' : 'Stop workspace';
  const message = deleting
    ? 'This permanently deletes the workspace’s storage, including unsynced files and saved agent conversations in its home directory.'
    : 'This ends processes and live agent sessions in the workspace.';
  const error = element('p', '', 'error');
  error.setAttribute('role', 'alert');
  const confirm = button(title, async () => {
    confirm.disabled = true;
    try {
      const path = `projects/${workspace.projectId}/workspaces/${workspace.id}/${action}`;
      await api(path, {confirmed: true});
      if (agentWorkspace?.id === workspace.id) closeWorkspace();
    } catch (failure) {
      error.textContent = failure.message;
      confirm.disabled = false;
      return;
    }
    dialog.close();
    changing.set(workspace.id, deleting ? 'Deleting' : 'Stopping');
    render();
    watchWorkspaceAction(workspace, deleting);
  }, deleting ? 'danger confirm-danger' : 'primary');
  dialogBody.replaceChildren(element('h2', `${title}?`),
    element('strong', `${workspace.project} / ${workspace.name}`), element('p', message), confirm, error);
  dialog.showModal();
}

async function watchWorkspaceAction(workspace, deleting) {
  notice(deleting ? 'Domino is deleting the workspace.' : 'Domino is stopping the workspace.');
  try {
    for (let attempt = 0; attempt < 24; attempt++) {
      await refresh();
      const status = data.workspaces.find(item => item.id === workspace.id);
      if (deleting ? !status : status?.state === 'Stopped') {
        notice(deleting ? 'Workspace deleted.' : 'Workspace stopped.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    notice('Domino is still processing this action. Refresh to check its status.');
  } catch (error) {
    notice(error.message, true);
  } finally {
    changing.delete(workspace.id);
    render();
  }
}

function confirmConnectorRestart(workspace) {
  dialogBody.replaceChildren(
    element('h2', `Restart ${workspace.project} with agent sessions?`),
    element('p', 'This ends processes currently running in the workspace. Domino will resume the same workspace with the connector enabled.'),
    button('Restart workspace', () => {
      dialog.close();
      restartWithConnector(workspace);
    }, 'primary')
  );
  dialog.showModal();
}

async function restartWithConnector(workspace) {
  const path = `projects/${workspace.projectId}/workspaces/${workspace.id}`;
  try {
    await api(path + '/stop-for-connector', {confirmed: true});
    notice('Stopping the workspace so Domino can enable agent sessions.');
    agentNotice('Waiting for Domino to stop the workspace…');
    byId('agent-controls').replaceChildren();
    for (let attempt = 0; attempt < 45; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      await refresh();
      if (data.workspaces.find(item => item.id === workspace.id)?.state === 'Stopped') {
        await runAction(path + '/resume', {managed: true}, true);
        if (agentWorkspace === workspace) closeWorkspace();
        return;
      }
    }
    notice('Domino is still stopping the workspace. Once stopped, use Resume with agent sessions.', true);
  } catch (error) {
    notice(error.message, true);
    if (agentWorkspace === workspace) agentNotice(error.message, true);
  }
}

async function createDialog(project) {
  dialogBody.replaceChildren(element('h2', `Start a workspace · ${project.name}`), element('p', 'Loading available IDEs…'));
  dialog.showModal();
  try {
    const {tools, connectorTools, sameBase} = await api(`projects/${project.id}/configuration`);
    if (!tools.length && !connectorTools.length) throw new Error('There are no workspace IDEs configured.');
    const form = element('form');
    const name = element('input');
    name.value = 'Herdr workspace';
    name.maxLength = 80;
    name.required = true;
    const tool = element('select');
    const description = element('p');
    function selectTools() {
      const choices = managed.checked ? connectorTools : tools;
      const value = tool.value;
      tool.replaceChildren(...choices.map(item => {
        const option = element('option', item.name);
        option.value = item.id;
        return option;
      }));
      if (choices.some(item => item.id === value)) tool.value = value;
      else if (choices.some(item => item.id === 'vscode')) tool.value = 'vscode';
      submit.disabled = !choices.length;
      description.textContent = managed.checked
        ? 'Uses the private Workspace Sessions environment and this project’s default hardware tier.'
        : 'Uses this project’s default compute environment and hardware tier.';
    }
    const ssh = element('input');
    ssh.type = 'checkbox';
    ssh.checked = false;
    const managed = element('input');
    managed.type = 'checkbox';
    managed.checked = connectorTools.length > 0 && (sameBase || !tools.length);
    managed.addEventListener('change', selectTools);
    const fields = [['Workspace name', name]];
    if (connectorTools.length) fields.push(['Connect Codex and Claude Code to this app', managed]);
    fields.push(['IDE', tool], ['Enable SSH', ssh]);
    for (const [text, input] of fields) {
      const label = element('label', text, input.type === 'checkbox' ? 'check' : '');
      label.append(input);
      form.append(label);
    }
    const submit = element('button', 'Start workspace', 'primary');
    const error = element('p');
    error.setAttribute('role', 'alert');
    form.append(submit, error);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await runAction(`projects/${project.id}/workspaces`, {
          name: name.value, tool: tool.value, ssh: ssh.checked, managed: managed.checked
        }, true);
        dialog.close();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        submit.disabled = false;
      }
    });
    const header = element('h2', `Start a workspace · ${project.name}`);
    selectTools();
    dialogBody.replaceChildren(header, description, form);
  } catch (error) {
    dialogBody.replaceChildren(element('p', error.message));
  }
}

async function runAction(path, body, showInDialog = false) {
  let id;
  try {
    ({id} = await api(path, body));
  } catch (error) {
    if (showInDialog) throw error;
    notice(error.message, true);
    return;
  }
  pending.add(id);
  notice('Domino is starting the workspace. The hub will refresh until it is ready.');
  render();
  watch(id);
}

async function watch(id) {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    try {
      await refresh();
      const workspace = data.workspaces.find(item => item.id === id);
      if (workspace?.running || ['Failed', 'Error'].includes(workspace?.state) ||
          (workspace?.state === 'Stopped' && attempt > 5)) {
        pending.delete(id);
        notice(workspace.running ? `${workspace.project} is ready.` :
          'Domino stopped the workspace before it was ready. Open the project to see its status.', !workspace.running);
        render();
        return;
      }
    } catch {
      // The inventory may be temporarily unavailable while Domino starts compute.
    }
  }
  pending.delete(id);
  render();
  notice('Domino is still starting the workspace. Refresh to check its status.');
}

byId('search').addEventListener('input', () => { if (data) renderProjects(); });
byId('history-search').addEventListener('input', renderHistory);
byId('browse-projects').addEventListener('click', browseProjects);
byId('empty-browse').addEventListener('click', browseProjects);
for (const id of ['workspace-tabs', 'agent-running']) {
  byId(id).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...byId(id).querySelectorAll('button:not(:disabled)')];
    const index = tabs.indexOf(event.target);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (index + tabs.length + (event.key === 'ArrowLeft' ? -1 : 1)) % tabs.length;
    tabs[next].focus();
  });
}
byId('refresh').addEventListener('click', () => refresh().catch(error => notice(error.message, true)));
refresh().then(() => notice('')).catch(error => notice(error.message, true));

const themeControl = byId('theme');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeControl.setAttribute('aria-pressed', String(dark));
  themeControl.textContent = dark ? 'Light mode' : 'Dark mode';
  if (terminal) terminal.view.options.theme = terminalTheme();
}
const systemTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
setTheme(localStorage.getItem('workspace-sessions-theme') || systemTheme);
themeControl.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('workspace-sessions-theme', theme);
  setTheme(theme);
});

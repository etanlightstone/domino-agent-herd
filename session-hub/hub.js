const byId = id => document.getElementById(id);
const dialog = byId('dialog');
const dialogBody = byId('dialog-body');
const projectsDialog = byId('projects-dialog');
const historyDialog = byId('history-dialog');
const setupDialog = byId('setup-dialog');
const setupAppUrl = location.origin + location.pathname;
let setupDetails;
let setupTimer;
let setupBusy = false;
let sshPreferenceBusy = false;
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

async function applyWorkspaceIDETheme(workspace) {
  if (workspace.tool !== 'vscode' || !workspace.connector?.connected) return;
  const theme = document.documentElement.dataset.theme;
  try {
    await api(`projects/${workspace.projectId}/workspaces/${workspace.id}/ide/theme`,
      {theme}, AbortSignal.timeout(7000));
  } catch {
    // The IDE can still open if its connector cannot apply the theme.
  }
}

function workspaceIDELink(workspace, text, url, className) {
  const node = link(text, url, className);
  if (workspace.tool === 'vscode') {
    const open = async event => {
      if (event.defaultPrevented || !workspace.connector?.connected) return;
      const tab = window.open('about:blank', '_blank');
      if (!tab) return;
      event.preventDefault();
      tab.opener = null;
      await applyWorkspaceIDETheme(workspace);
      if (!tab.closed) tab.location.replace(node.href);
    };
    node.addEventListener('click', open);
    node.addEventListener('auxclick', event => {
      if (event.button === 1) open(event);
    });
  }
  return node;
}

function workspaceIDEPath(workspace) {
  return `./workspaces/${workspace.projectId}/${workspace.id}/ide`;
}

function notice(message, error = false) {
  byId('status').textContent = message;
  byId('status').dataset.error = error;
  byId('status').hidden = !message;
}

async function api(path, body, signal) {
  const options = body === undefined ? {signal} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal
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
  if (retained) Object.assign(agentWorkspace, retained);
  const previous = localStorage.getItem('workspace-sessions-active');
  const next = retained || running.find(workspace => workspace.id === previous) ||
    running.find(workspace => workspace.connector.ready) || running[0];
  if (next && !retained) showAgents(next);
  if (!next && agentWorkspace) closeWorkspace();
  renderWorkspaceTabs();
  byId('empty-workspaces').hidden = Boolean(next);
  renderProjects();
  renderDetail();
  renderSetup();
}

function setupMessage(state, name) {
  switch (state) {
    case 'ready': return `${name} is ready for agent sessions.`;
    case 'building': return `Domino is building ${name}. This page will update when it’s ready.`;
    case 'failed': return `The build for ${name} failed. Open the environment in Domino to check its build log.`;
    case 'unavailable': return 'The configured connector environment is unavailable.';
    default: return 'Set up a workspace environment to launch Codex and Claude Code from this App.';
  }
}

function renderSetup() {
  const setup = data?.setup || {state: 'unconfigured'};
  const {state, name, id} = setup;
  const buildPending = state === 'building';
  byId('connector-setup-banner').hidden = state === 'ready';
  byId('connector-setup-status').textContent = setupMessage(state, name);
  byId('connector-setup-open').textContent = state === 'unconfigured' ? 'Set up agent sessions' : 'View setup';
  clearTimeout(setupTimer);
  if (buildPending) {
    setupTimer = setTimeout(() => refresh().catch(error => {
      notice(error.message, true);
      renderSetup();
    }), 5000);
  }
  if (!setupDetails || !setupDialog.open) return;
  byId('setup-feedback').textContent = setupMessage(state, name);
  byId('setup-create').hidden = !['unconfigured', 'unavailable'].includes(state);
  byId('setup-create').disabled = setupBusy || !setupDetails.base;
  byId('setup-create').textContent = setupDetails.base
    ? `Create from ${setupDetails.base.name}` : 'Create private environment';
  if (!setupDetails.base && state === 'unconfigured') {
    byId('setup-feedback').textContent = 'Choose a successfully built default compute environment in your App project, or link an existing connector environment.';
  }
  const environmentLink = byId('setup-environment-link');
  environmentLink.hidden = !id;
  if (id) environmentLink.href = `${data.dominoUrl}/environments/${id}`;
  byId('setup-link').querySelector('button').disabled = setupBusy;
}

async function openSetup() {
  if (setupDialog.open) return;
  if (!data) {
    try {
      await refresh();
    } catch (error) {
      notice(error.message, true);
      return;
    }
    if (setupDialog.open) return;
  }
  setupDetails = null;
  byId('setup-options').hidden = true;
  byId('setup-owner').textContent = '';
  byId('setup-feedback').textContent = 'Finding this Domino App…';
  setupDialog.showModal();
  updateSshPreference();
  try {
    setupDetails = await api('setup?' + new URLSearchParams({appUrl: setupAppUrl}));
    const {owner, appUrl, environment} = setupDetails;
    byId('setup-owner').textContent = `${owner} · ${appUrl}`;
    byId('setup-options').hidden = false;
    data.setup = environment;
    renderSetup();
  } catch (error) {
    byId('setup-feedback').textContent = error.message;
  }
}

async function updateSshPreference(preference) {
  if (sshPreferenceBusy) return;
  const checkbox = byId('setup-ssh-enabled');
  const save = byId('setup-ssh-save');
  const feedback = byId('setup-ssh-feedback');
  const saving = preference !== undefined;
  let loaded = saving;
  sshPreferenceBusy = true;
  checkbox.disabled = save.disabled = true;
  feedback.textContent = saving ? 'Saving SSH preference…' : 'Loading SSH preference…';
  try {
    const {enabled} = await api('settings/ssh', preference);
    checkbox.checked = enabled;
    loaded = true;
    feedback.textContent = saving ? 'SSH preference saved.' : '';
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    sshPreferenceBusy = false;
    checkbox.disabled = save.disabled = !loaded;
  }
}

async function configureConnector(mode, environmentId) {
  if (setupBusy) return;
  setupBusy = true;
  renderSetup();
  byId('setup-feedback').textContent = mode === 'create' ? 'Requesting an environment build…' : 'Checking the environment…';
  let failure;
  try {
    const result = await api('setup', {appUrl: setupAppUrl, mode, environmentId});
    data.setup = result.environment;
    data.managedAvailable = data.setup.state === 'ready';
    await refresh();
  } catch (error) {
    failure = error.message;
  } finally {
    setupBusy = false;
    renderSetup();
    if (failure) byId('setup-feedback').textContent = failure;
  }
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
    const state = workspaceAgentState(workspace);
    if (state) {
      const dot = element('span', '', 'agent-dot');
      dot.dataset.state = state;
      tab.append(dot);
      tab.title = `${workspace.name} · ${state}`;
    }
    return tab;
  }));
}

const otherAgents = new Map();
const STATE_RANK = {blocked: 3, working: 2, starting: 2, done: 1, idle: 1};

function workspaceAgentState(workspace) {
  const agents = workspace.id === agentWorkspace?.id ? runningAgents : otherAgents.get(workspace.id) || [];
  let best;
  for (const agent of agents) {
    const state = agent.status?.toLowerCase();
    if ((STATE_RANK[state] || 0) > (STATE_RANK[best] || 0)) best = state;
  }
  return best;
}

async function pollOtherWorkspaces() {
  const running = data?.workspaces.filter(workspace => workspace.running && workspace.connector?.ready &&
    workspace.id !== agentWorkspace?.id) || [];
  for (const id of [...otherAgents.keys()]) if (!running.some(workspace => workspace.id === id)) otherAgents.delete(id);
  await Promise.all(running.map(async workspace => {
    try {
      const list = await api(agentPath(workspace) + '?live=1');
      otherAgents.set(workspace.id, list.running || []);
    } catch {
      otherAgents.delete(workspace.id);
    }
  }));
  if (data) renderWorkspaceTabs();
}
setInterval(() => { if (!document.hidden) pollOtherWorkspaces(); }, 5000);

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
    const ideLink = workspace.tool === 'vscode'
      ? workspaceIDELink(workspace, 'Open VS Code', workspaceIDEPath(workspace), 'button')
      : link('Open workspace', workspace.ide, 'button');
    controls.append(ideLink,
      button('Open sessions', () => {
        projectsDialog.close();
        showAgents(workspace);
      }, 'primary'),
      button('Stop', () => confirmWorkspaceAction(workspace, 'stop')));
  } else if (workspace.state === 'Stopped' && !transition && !pending.has(workspace.id)) {
    const path = `projects/${workspace.projectId}/workspaces/${workspace.id}/resume`;
    controls.append(button('Resume workspace', () => runAction(path, {}), 'primary'));
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
let lastRecovery = 0;
let autoAttach = false;
let historyRows = [];
let visibleView = 'agent';
let gitView;

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
  gitView = undefined;
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
  gitView = {workspace};
  gitFeedback('');
  renderGit({state: 'busy', detail: 'Checking this workspace’s Git status…'});
  refreshGit();
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
  const fallback = workspaceIDELink(workspace, label, workspaceIDEPath(workspace), 'button ide-link');
  fallback.title = 'Open the workspace IDE in a browser tab';
  byId('workspace-ide').replaceChildren(fallback);
  try {
    const info = await api(`projects/${workspace.projectId}/workspaces/${workspace.id}/ide?origin=${encodeURIComponent(location.origin)}`);
    if (agentWorkspace !== workspace) return;
    if (!info.embed) {
      fallback.href = info.url;
      return;
    }
    const openIDE = button(label, async () => {
      visibleView = 'ide';
      byId('agent-view').hidden = true;
      byId('ide-panel').hidden = false;
      byId('ide-title').textContent = label;
      byId('ide-actions').replaceChildren(workspaceIDELink(workspace, 'Open in browser tab', info.url, 'button'),
        button('Back to agents', showAgentTerminal));
      openIDE.setAttribute('aria-selected', 'true');
      renderAgentTabs();
      let frame = byId('ide-frame').firstChild;
      if (!frame) {
        frame = element('iframe');
        frame.title = `${label} · ${workspace.project}`;
        byId('ide-frame').append(frame);
      }
      await applyWorkspaceIDETheme(workspace);
      if (frame.isConnected && !frame.hasAttribute('src')) frame.src = info.url;
    }, 'agent-tab ide-link');
    openIDE.setAttribute('role', 'tab');
    openIDE.setAttribute('aria-controls', 'ide-panel');
    openIDE.setAttribute('aria-selected', 'false');
    byId('workspace-ide').replaceChildren(openIDE);
  } catch {
    // The redirect link can resolve the IDE when its route becomes ready.
  }
}

const gitIcons = {clean: '✓', dirty: '●', error: '×', disabled: '–', busy: '↻'};

function renderGit({state, detail}) {
  const control = byId('git-sync');
  control.dataset.state = state;
  control.setAttribute('aria-disabled', String(state === 'disabled' || state === 'busy'));
  control.title = detail;
  control.setAttribute('aria-label', `Sync Git. ${detail}`);
  byId('git-icon').textContent = gitIcons[state];
}

function gitFeedback(message, error = false) {
  const feedback = byId('git-feedback');
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.classList.toggle('error', error);
}

async function requestGit(view, sync) {
  const {workspace} = view;
  try {
    return await api(`projects/${workspace.projectId}/workspaces/${workspace.id}/git`,
      sync ? {run: workspace.run} : undefined, AbortSignal.timeout(85000));
  } catch (error) {
    let detail = error.message;
    if (error.name === 'TimeoutError') detail = 'The workspace took too long to respond.';
    if (error instanceof TypeError) detail = 'Could not reach the workspace.';
    if (detail === 'Unknown connector action.') detail = 'Restart this workspace to update its connector.';
    return {state: 'error', detail};
  }
}

async function refreshGit() {
  const view = gitView;
  if (!view || view.check || view.syncing) return;
  view.check = requestGit(view, false);
  const status = await view.check;
  view.check = undefined;
  if (view === gitView && !view.syncing) showGitStatus(status);
}

function showGitStatus(status) {
  const {state, detail} = status;
  renderGit({state, detail: state === 'error' ? `${detail} Click Sync Git to try again.` : detail});
}

byId('git-sync').addEventListener('click', async () => {
  const view = gitView;
  if (!view || byId('git-sync').getAttribute('aria-disabled') === 'true') return;
  view.syncing = true;
  gitFeedback('');
  renderGit({state: 'busy', detail: 'Syncing this workspace’s Git branch…'});
  await view.check;
  if (view !== gitView) return;
  const status = await requestGit(view, true);
  if (view !== gitView) return;
  view.syncing = false;
  showGitStatus(status);
  gitFeedback(status.synced ? 'Git is up to date.' : status.detail, status.state === 'error');
  if (status.state === 'busy') setTimeout(refreshGit, 1500);
});
setInterval(() => { if (!document.hidden) refreshGit(); }, 30000);

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
    workspace.connector.connected = list.connected;
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
      const claude = button('New Claude Code', () => launchAgent({kind: 'claude'}), 'primary');
      claude.id = 'new-claude';
      byId('agent-controls').dataset.workspace = workspaceKey(workspace);
      byId('agent-controls').replaceChildren(codex, claude, button('History', openHistory));
    }
    if (!activeStart && !byId('agent-summary').classList.contains('error')) agentNotice(list.detail || '');
    runningAgents = list.running;
    renderAgentTabs();
    renderWorkspaceTabs();
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
      panelRefresh = setTimeout(() => { if (!document.hidden) loadAgents(workspace); }, 4500);
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

const MAX_IMAGE_BYTES = 520_000;

async function imageToBase64(file) {
  let blob = file;
  if (blob.size > MAX_IMAGE_BYTES || !/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) {
    // Shrink big screenshots (agents downscale anyway) so the upload stays small.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    for (const quality of [0.85, 0.7, 0.5]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_IMAGE_BYTES) break;
    }
    if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('That image is too large to paste.');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let raw = '';
  for (let pos = 0; pos < bytes.length; pos += 8192) raw += String.fromCharCode(...bytes.subarray(pos, pos + 8192));
  return btoa(raw);
}

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
  const session = {channel, label, view, sequence: 0, poll: new AbortController()};
  // One request in flight at a time keeps ordering, but while it is out, queued keystrokes/scrolls are
  // merged so a slow round trip doesn't build a backlog (which made typing lag and scrolling overshoot).
  const queue = [];
  let flushing = false;
  function send(action) {
    const last = queue[queue.length - 1];
    if (last && last.type === action.type) {
      if (action.type === 'terminal.input') { last.text += action.text; return flush(); }
      if (action.type === 'terminal.resize') { Object.assign(last, action); return flush(); }
      if (action.type === 'terminal.scroll' && last.direction === action.direction &&
          last.column === action.column && last.row === action.row) {
        last.lines = Math.min(200, last.lines + action.lines);
        return flush();
      }
    }
    queue.push({...action});
    flush();
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length && terminal === session) {
        const {text, ...action} = queue.shift();
        try {
          if (action.type !== 'terminal.input') {
            await api('terminals/' + channel, action);
            continue;
          }
          for (let pos = 0; pos < text.length; pos += 8000) {
            await api('terminals/' + channel, {type: action.type, bytes: encodeInput(text.slice(pos, pos + 8000))});
          }
        } catch (error) {
          if (terminal === session) agentNotice(error.message, true);
        }
      }
    } finally {
      flushing = false;
    }
  }
  terminal = session;
  view.loadAddon(fit);
  byId('terminal-title').textContent = label;
  panel.hidden = false;
  view.open(mount);
  view.onData(value => {
    send({type: 'terminal.input', text: value});
  });
  view.onResize(({cols, rows}) => send({
    type: 'terminal.resize', cols: Math.max(10, Math.min(350, cols)), rows: Math.max(4, Math.min(140, rows))
  }));
  session.fit = fit;
  // Pasted images: the agent runs in the workspace, so it can't see this browser's clipboard. Upload the
  // image to the workspace, which types its file path into the pane (both Claude Code and Codex attach it).
  session.paste = async event => {
    const file = [...event.clipboardData?.files || []].find(item => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      send({type: 'terminal.image', bytes: await imageToBase64(file)});
    } catch (error) {
      agentNotice(error.message, true);
    }
  };
  mount.addEventListener('paste', session.paste, true);
  // Herdr routes wheel input to either the terminal app or its scrollback.
  const screen = mount.querySelector('.xterm-screen');
  let wheelLines = 0;
  let wheelTimer;
  let wheelCell;
  session.wheel = event => {
    if (!event.deltaY) return;
    const bounds = screen.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault();
    event.stopPropagation();
    const column = Math.floor((event.clientX - bounds.left) * view.cols / bounds.width);
    const row = Math.floor((event.clientY - bounds.top) * view.rows / bounds.height);
    wheelCell = {
      column: Math.max(0, Math.min(349, view.cols - 1, column)),
      row: Math.max(0, Math.min(139, view.rows - 1, row))
    };
    const step = event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? view.rows : 17;
    wheelLines += event.deltaY / step;
    wheelTimer ??= setTimeout(() => {
      wheelTimer = undefined;
      const steps = Math.trunc(wheelLines);
      const lines = Math.min(200, Math.abs(steps));
      if (!lines) return;
      wheelLines -= steps;
      send({type: 'terminal.scroll', direction: steps < 0 ? 'up' : 'down', lines, ...wheelCell});
    }, 40);
  };
  mount.addEventListener('wheel', session.wheel, {capture: true, passive: false});
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
    session.failures = 0;
    if (!result.closed) {
      pumpTerminal(session);
      return;
    }
    detachTerminal();
    selectedPane = undefined;
    renderAgentTabs();
    agentNotice('The terminal disconnected. Select the agent to attach again.', true);
  } catch (error) {
    if (terminal !== session) return;
    // A suspended/idle tab drops the long-poll with a bare network TypeError; back off and retry the channel.
    if (error instanceof TypeError && (session.failures = (session.failures || 0) + 1) <= 4) {
      setTimeout(() => pumpTerminal(session), 1000 * session.failures);
      return;
    }
    const pane = selectedPane;
    detachTerminal();
    selectedPane = undefined;
    renderAgentTabs();
    // Channel is gone (expired while away): silently re-attach to the same pane, at most once per 30s.
    if (pane && Date.now() - lastRecovery > 30000) {
      lastRecovery = Date.now();
      launchAgent({pane}, session.label);
      return;
    }
    agentNotice(error.message, true);
  }
}

function detachTerminal() {
  if (!terminal) return;
  const session = terminal;
  terminal = null;
  session.poll.abort();
  session.resize.disconnect();
  byId('terminal').removeEventListener('wheel', session.wheel, {capture: true});
  byId('terminal').removeEventListener('paste', session.paste, true);
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
    element('p', 'This ends running processes. Domino will then resume the workspace and connect it to this App when the connector is available.'),
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
        await runAction(path + '/resume', {}, true);
        if (agentWorkspace === workspace) closeWorkspace();
        return;
      }
    }
    notice('Domino is still stopping the workspace. Once stopped, choose Resume workspace.', true);
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
    const managed = element('input');
    managed.type = 'checkbox';
    managed.checked = connectorTools.length > 0 && (sameBase || !tools.length);
    managed.addEventListener('change', selectTools);
    const fields = [['Workspace name', name]];
    if (connectorTools.length) fields.push(['Connect Codex and Claude Code to this app', managed]);
    fields.push(['IDE', tool]);
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
          name: name.value, tool: tool.value, managed: managed.checked
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
byId('connector-settings').addEventListener('click', openSetup);
byId('connector-setup-open').addEventListener('click', openSetup);
byId('setup-ssh').addEventListener('submit', event => {
  event.preventDefault();
  const checkbox = byId('setup-ssh-enabled');
  if (!checkbox.disabled) updateSshPreference({enabled: checkbox.checked});
});
byId('setup-create').addEventListener('click', () => configureConnector('create'));
byId('setup-link').addEventListener('submit', event => {
  event.preventDefault();
  configureConnector('link', new FormData(event.currentTarget).get('environmentId').trim());
});
byId('refresh').addEventListener('click', () => refresh().then(refreshGit).catch(error => notice(error.message, true)));
refresh().then(() => {
  notice('');
  if (data.setup?.state === 'unconfigured') openSetup();
}).catch(error => notice(error.message, true));

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

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (agentWorkspace) loadAgents(agentWorkspace);
  refreshGit();
  pollOtherWorkspaces();
});

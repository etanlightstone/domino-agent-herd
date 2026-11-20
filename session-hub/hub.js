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
let data;
let selected;
const pending = new Set();
const changing = new Map();
const restarting = new Set();

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
  if (!response.ok) {
    throw Object.assign(new Error(result.error || `Request failed (HTTP ${response.status}).`),
      {status: response.status});
  }
  return result;
}

async function refresh() {
  data = await api('inventory?' + new URLSearchParams({appUrl: setupAppUrl}));
  data.projects = orderProjects(data.projects, data.workspaces);
  if (!data.projects.some(project => project.id === selected)) selected = data.projects[0]?.id;
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
  if (splitActive) {
    if (!retained && agentWorkspace) closeWorkspace();
    const stillRunning = ({workspace}) => running.some(item => workspaceKey(item) === workspaceKey(workspace));
    for (const tile of splitTiles) {
      const lostRequest = tile.request && !stillRunning(tile.request);
      const lostTerminal = tile.terminal && !stillRunning(tile.terminal);
      if (lostRequest) tile.request = undefined;
      if (lostTerminal) detachTerminal(tile);
      if ((lostRequest || lostTerminal) && !tile.request) {
        slotNotice(tile, 'This workspace is no longer running. Choose another session.', true);
        renderTerminalSlot(tile);
      }
    }
  } else if (next && !retained) {
    showAgents(next);
  } else if (!next && agentWorkspace) {
    closeWorkspace();
  }
  renderWorkspaceTabs();
  byId('empty-workspaces').hidden = splitActive || Boolean(next);
  renderProjects();
  renderDetail();
  renderSetup();
  renderCredentialsBanner();
}

function setupMessage(state, name, mode) {
  if (mode === 'ssh') return 'Agent sessions connect over Domino workspace SSH. No setup is needed.';
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
  const {state, name, id, mode} = setup;
  const ssh = mode === 'ssh';
  const buildPending = state === 'building';
  byId('connector-setup-banner').hidden = ssh || state === 'ready';
  byId('connector-setup-status').textContent = setupMessage(state, name, mode);
  byId('connector-setup-open').textContent = state === 'unconfigured' ? 'Set up agent sessions' : 'View setup';
  clearTimeout(setupTimer);
  if (buildPending) {
    setupTimer = setTimeout(() => refresh().catch(error => {
      notice(error.message, true);
      renderSetup();
    }), 5000);
  }
  if (!setupDialog.open) return;
  const connection = byId('setup-connection-state');
  connection.textContent = !setupDetails ? '' : ssh || state === 'ready' ? 'Ready'
    : {building: 'Building…', failed: 'Build failed', unavailable: 'Unavailable'}[state] || 'Needs setup';
  connection.dataset.done = String(Boolean(setupDetails) && (ssh || state === 'ready'));
  if (!setupDetails) return;
  byId('setup-feedback').textContent = setupMessage(state, name, mode);
  byId('setup-sharing-warning').hidden = false;
  byId('setup-ssh-mode').hidden = !ssh;
  byId('setup-environment').hidden = ssh;
  if (ssh) return;
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

async function openSetup({welcome = false, signIn = false, provider} = {}) {
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
  for (const id of ['setup-options', 'setup-ssh-mode', 'setup-environment', 'setup-sharing-warning']) byId(id).hidden = true;
  byId('setup-owner').textContent = '';
  byId('setup-feedback').textContent = 'Finding this Domino App…';
  byId('setup-welcome').hidden = !welcome;
  credentialUI.removing = null;
  if (provider) credentialUI.open.add(provider);
  credentialFeedback('');
  setupDialog.showModal();
  renderSetup();
  loadCredentials();
  if (signIn) byId('setup-step-signin').scrollIntoView({block: 'start'});
  try {
    setupDetails = await api('setup?' + new URLSearchParams({appUrl: setupAppUrl}));
    const {owner, appUrl, environment, mode} = setupDetails;
    byId('setup-owner').textContent = `${owner} · ${appUrl}`;
    byId('setup-options').hidden = false;
    data.setup = mode === 'ssh' ? {mode, state: 'ready'} : {mode, ...environment};
    renderSetup();
  } catch (error) {
    byId('setup-feedback').textContent = error.message;
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
    data.setup = {mode: 'environment', ...result.environment};
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

// Agent sign-in. The App saves it to the owner's Domino user environment variables.
const CODEX_VARIABLE_DIR = '$HOME/.codex-domino';
const SIGN_IN_GUIDES = {
  claude: {
    command: 'claude setup-token',
    after: 'A browser window opens. Sign in with your Claude account. The terminal then prints a token that starts with sk-ant-oat01-. Copy the whole token.',
    install: ['No Claude Code on your Mac? Install it first:', 'curl -fsSL https://claude.ai/install.sh | bash'],
    others: [
      ['Not on a Mac? The same command works in Linux and Windows terminals.', null],
    ],
    paste: 'Paste the token',
    placeholder: 'sk-ant-oat01-…',
    lifetime: 'Claude Code tokens last about a year. This App reminds you a month before it expires.',
    manualLifetime: 'Claude Code tokens last about a year.',
  },
  codex: {
    command: `(export CODEX_HOME="${CODEX_VARIABLE_DIR}"; mkdir -p "$CODEX_HOME" && codex login -c 'cli_auth_credentials_store="file"' && base64 < "$CODEX_HOME/auth.json" | tr -d '\\n' | pbcopy && echo "Copied. Paste it into Workspace Sessions."; rm -rf "$CODEX_HOME")`,
    after: 'A browser window opens. Sign in with your ChatGPT account. When the terminal says Copied, your sign-in is on the clipboard. This is a separate sign-in for Domino, so Codex on your Mac stays signed in.',
    install: ['No Codex on your Mac? Install it first:', 'brew install --cask codex'],
    others: [
      ['Already signed in to Codex on this Mac? You can copy that sign-in instead:',
        `base64 < "\${CODEX_HOME:-$HOME/.codex}/auth.json" | tr -d '\\n' | pbcopy`],
      ['On Linux, remove | pbcopy from the command and copy the text it prints.', null],
    ],
    paste: 'Paste with ⌘V',
    placeholder: 'ewogICJhdXRoX21vZGUi…',
    lifetime: 'Codex keeps this sign-in fresh. If a workspace asks you to sign in to Codex again, repeat these steps.',
  },
};
const credentialDate = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium'});
const credentialUI = {loading: false, open: new Set(), removing: null, busy: null, drafts: {}};

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* The page works without saved preferences. */ }
}

function formatCredentialDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  return year ? credentialDate.format(new Date(year, month - 1, day)) : '';
}

function credentialProviders() {
  const providers = data?.credentials?.providers || {};
  return ['claude', 'codex'].map(key => ({key, ...providers[key]})).filter(provider => provider.name);
}

function signedIn(provider) {
  return ['ok', 'expiring'].includes(provider.state);
}

function credentialStateText(provider) {
  switch (provider.state) {
    case 'ok':
      if (provider.key === 'codex' && provider.account) {
        return `Signed in as ${provider.account}${provider.plan ? ` (${provider.plan})` : ''}`;
      }
      return provider.expiresAt ? `Signed in · renew by ${formatCredentialDate(provider.expiresAt)}` : 'Signed in';
    case 'expiring': return `Expires around ${formatCredentialDate(provider.expiresAt)} · renew now`;
    case 'expired': return 'Probably expired · sign in again';
    case 'invalid': return 'Saved value isn’t a valid sign-in · replace it';
    case 'missing': return 'Not set up';
    default: return 'Status unavailable';
  }
}

function credentialAttention() {
  const credentials = data?.credentials;
  if (!credentials?.available) return null;
  const providers = credentialProviders();
  const urgent = providers.find(provider => ['expired', 'invalid', 'expiring'].includes(provider.state));
  if (urgent) {
    const message = urgent.state === 'expired'
      ? `Your ${urgent.name} sign-in has probably expired. Sign in again so new sessions start signed in.`
      : urgent.state === 'invalid'
        ? `Your saved ${urgent.name} sign-in can’t be read. Replace it in Setup.`
        : `Your ${urgent.name} sign-in expires around ${formatCredentialDate(urgent.expiresAt)}.`;
    return {message, action: 'Renew sign-in', provider: urgent.key, dismissible: false};
  }
  if (!providers.some(provider => provider.state !== 'missing') && !storageGet('workspace-sessions-signin-dismissed')) {
    return {message: 'Sign in to Codex or Claude Code once, and every workspace you start is signed in.',
      action: 'Set up sign-in', dismissible: true};
  }
  return null;
}

function renderCredentialsBanner() {
  const attention = credentialAttention();
  byId('credentials-banner').hidden = !attention;
  if (!attention) return;
  byId('credentials-banner-status').textContent = attention.message;
  byId('credentials-banner-open').textContent = attention.action;
  byId('credentials-banner-open').dataset.provider = attention.provider || '';
  byId('credentials-banner-dismiss').hidden = !attention.dismissible;
}

function commandBlock(command, label) {
  const block = element('div', '', 'command');
  const code = element('code', command);
  const copy = button('Copy', async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(code);
      copy.textContent = 'Press ⌘C';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  });
  copy.setAttribute('aria-label', `Copy ${label}`);
  block.append(code, copy);
  return block;
}

function guideStep(number, ...children) {
  const step = element('li', '', 'guide-step');
  const marker = element('span', String(number), 'guide-marker');
  marker.setAttribute('aria-hidden', 'true');
  const body = element('div', '', 'guide-body');
  body.append(...children);
  step.append(marker, body);
  return step;
}

function signInGuide(provider) {
  const guide = SIGN_IN_GUIDES[provider.key];
  const credentials = data.credentials;
  const runIntro = element('p');
  runIntro.append(element('strong', 'On your Mac,'), ' open Terminal and run:');
  const install = element('p', guide.install[0] + ' ', 'meta');
  install.append(element('code', guide.install[1]));
  const others = element('details', '', 'guide-options');
  others.append(element('summary', 'Other options'));
  for (const [text, command] of guide.others) {
    others.append(element('p', text, 'meta'));
    if (command) others.append(commandBlock(command, 'alternative command'));
  }
  const steps = element('ol', '', 'guide-steps');
  steps.append(guideStep(1, runIntro, commandBlock(guide.command, `${provider.name} sign-in command`),
    element('p', guide.after, 'meta'), install, others));

  if (credentials.writable) {
    const form = element('form', '', 'guide-paste');
    const field = element('label', `${guide.paste} here`);
    const input = element('textarea', '', 'secret');
    input.name = 'value';
    input.rows = 3;
    input.required = true;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = guide.placeholder;
    input.value = credentialUI.drafts[provider.key] || '';
    input.addEventListener('input', () => { credentialUI.drafts[provider.key] = input.value; });
    field.append(input);
    const save = element('button', credentialUI.busy === provider.key ? 'Saving…' : `Save ${provider.name} sign-in`, 'primary');
    save.type = 'submit';
    save.disabled = Boolean(credentialUI.busy);
    const actions = element('div', '', 'actions');
    actions.append(save);
    if (provider.state !== 'unknown') {
      actions.append(button('Cancel', () => {
        credentialUI.open.delete(provider.key);
        delete credentialUI.drafts[provider.key];
        renderCredentials();
      }));
    }
    form.append(field, actions, element('p', guide.lifetime, 'meta'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      saveCredential(provider, input.value);
    });
    steps.append(guideStep(2, form));
  } else {
    const where = element('p');
    where.append('Open ', link('your Domino account settings', credentials.accountUrl),
      ' and find User environment variables. Set this name, paste the value, then choose Set variable.');
    steps.append(guideStep(2, where, commandBlock(provider.variable, 'variable name'),
      element('p', 'This Domino deployment doesn’t let the App save the sign-in for you. ' +
        (guide.manualLifetime || guide.lifetime), 'meta')));
  }
  return steps;
}

function credentialCard(provider) {
  const card = element('section', '', 'provider');
  card.dataset.state = provider.state || 'unknown';
  card.dataset.providerCard = provider.key;
  const heading = element('div', '', 'provider-heading');
  const title = element('div', '', 'provider-title');
  const state = element('span', credentialStateText(provider), 'provider-state');
  state.dataset.state = card.dataset.state;
  const details = [provider.variable];
  if (provider.savedAt) details.push(`saved ${formatCredentialDate(provider.savedAt)}`);
  else if (provider.key === 'claude' && provider.state === 'ok') {
    details.push('saved outside this App, so its renewal date is unknown. Replace it here to get a reminder');
  }
  title.append(element('strong', provider.name), state, element('p', details.join(' · '), 'meta'));
  const actions = element('div', '', 'actions');
  // Agents that aren't set up stay collapsed, so people expand only the ones they use.
  const open = credentialUI.open.has(provider.key) || provider.state === 'unknown';
  const writable = data.credentials.writable;
  if (credentialUI.removing === provider.key) {
    actions.append(
      element('span', `Remove ${provider.name} from Domino?`, 'meta'),
      button('Remove', () => removeCredential(provider), 'confirm-danger'),
      button('Cancel', () => { credentialUI.removing = null; renderCredentials(); }));
  } else if (!open) {
    const missing = provider.state === 'missing';
    const renew = ['expiring', 'expired', 'invalid'].includes(provider.state);
    actions.append(button(missing ? `Set up ${provider.name}` : renew ? 'Renew' : 'Replace', () => {
      credentialUI.open.add(provider.key);
      renderCredentials();
      byId('credential-providers').querySelector(`[data-provider-card="${provider.key}"] .command button`)?.focus();
    }, missing || renew ? 'primary' : ''));
    if (writable && !missing) {
      actions.append(button('Remove', () => { credentialUI.removing = provider.key; renderCredentials(); }, 'danger'));
    }
  }
  for (const control of actions.querySelectorAll('button')) control.disabled = Boolean(credentialUI.busy);
  heading.append(title, actions);
  card.append(heading);
  if (open) card.append(signInGuide(provider));
  return card;
}

function renderCredentials() {
  renderCredentialsBanner();
  if (!setupDialog.open) return;
  const container = byId('credential-providers');
  const credentials = data?.credentials;
  const providers = credentialProviders();
  const stateChip = byId('setup-signin-state');
  if (!credentials) {
    container.replaceChildren(element('p', credentialUI.loading ? 'Checking your saved sign-in…'
      : 'Could not check your saved sign-in. Close Setup and try again.', 'meta'));
    stateChip.textContent = '';
    return;
  }
  const ready = providers.filter(signedIn);
  stateChip.textContent = !credentials.available ? 'Set up in Domino'
    : ready.length ? `${ready.map(provider => provider.name).join(' and ')} ready` : 'Not set up';
  stateChip.dataset.done = String(ready.length > 0);
  const focused = document.activeElement?.closest?.('[data-provider-card]')?.dataset.providerCard;
  container.replaceChildren(...providers.map(credentialCard));
  if (focused) container.querySelector(`[data-provider-card="${focused}"] textarea`)?.focus();
}

function credentialFeedback(message, error = false) {
  const feedback = byId('credentials-feedback');
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.classList.toggle('error', error);
  feedback.classList.toggle('success', Boolean(message) && !error);
}

async function loadCredentials() {
  credentialUI.loading = true;
  renderCredentials();
  try {
    const credentials = await api('credentials?refresh=1');
    data.credentials = credentials;
  } catch (error) {
    credentialFeedback(error.message, true);
  } finally {
    credentialUI.loading = false;
    renderCredentials();
  }
}

async function saveCredential(provider, value) {
  if (credentialUI.busy) return;
  credentialUI.busy = provider.key;
  credentialFeedback('');
  renderCredentials();
  try {
    const credentials = await api('credentials', {provider: provider.key, value});
    data.credentials = credentials;
    credentialUI.open.delete(provider.key);
    delete credentialUI.drafts[provider.key];
    credentialFeedback(`${provider.name} sign-in saved to Domino. New ${provider.name} sessions you open here use it, including in running workspaces. If a workspace still asks you to sign in, restart it.`);
  } catch (error) {
    credentialFeedback(error.message, true);
  } finally {
    credentialUI.busy = null;
    renderCredentials();
  }
}

async function removeCredential(provider) {
  if (credentialUI.busy) return;
  credentialUI.busy = provider.key;
  credentialUI.removing = null;
  credentialFeedback('');
  renderCredentials();
  try {
    const credentials = await api('credentials', {provider: provider.key, remove: true});
    data.credentials = credentials;
    credentialFeedback(`${provider.name} sign-in removed from Domino. Workspaces that are already signed in stay signed in until they restart.`);
  } catch (error) {
    credentialFeedback(error.message, true);
  } finally {
    credentialUI.busy = null;
    renderCredentials();
  }
}

function needsFirstRunSetup() {
  if (data.setup?.state === 'unconfigured') return true;
  return Boolean(data.credentials?.available) && !credentialProviders().some(provider => provider.state !== 'missing') &&
    !storageGet('workspace-sessions-setup-seen');
}

function renderWorkspaceTabs() {
  const running = data?.workspaces.filter(workspace => (workspace.running || pending.has(workspace.id)) &&
    !changing.has(workspace.id)) || [];
  const tabs = running.map(workspace => {
    const repeated = running.filter(item => item.projectId === workspace.projectId).length > 1;
    const label = repeated ? workspace.project + ' / ' + workspace.name : workspace.project;
    const tab = button(label, () => showAgents(workspace), 'workspace-tab');
    tab.title = workspace.name;
    tab.dataset.key = workspace.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'agent-panel');
    tab.setAttribute('aria-selected', String(!splitActive && workspace.id === agentWorkspace?.id));
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
  });
  const split = iconButton('Split view', enterSplit, element('span', '', 'split-icon'), 'workspace-tab split-tab');
  split.id = 'split-tab';
  split.dataset.key = 'split';
  split.setAttribute('role', 'tab');
  split.setAttribute('aria-controls', 'split-panel');
  split.setAttribute('aria-selected', String(splitActive));
  tabs.push(split);
  setTabs('workspace-tabs', tabs);
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
      const agents = list.running || [];
      otherAgents.set(workspace.id, agents);
      if (workspace.id !== agentWorkspace?.id) refreshSplitTitles(workspace, agents);
    } catch {
      otherAgents.delete(workspace.id);
    }
  }));
  if (data) renderWorkspaceTabs();
}
setInterval(() => { if (!document.hidden) pollOtherWorkspaces(); }, 5000);

function orderProjects(projects, workspaces) {
  const latestStart = new Map();
  for (const workspace of workspaces) {
    const value = workspace.lastStarted;
    const started = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(started) && started > (latestStart.get(workspace.projectId) ?? 0)) {
      latestStart.set(workspace.projectId, started);
    }
  }
  return [...projects].sort((a, b) => (latestStart.get(b.id) ?? 0) - (latestStart.get(a.id) ?? 0) ||
    a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
}

function browseProjects() {
  if (projectsDialog.open) return;
  byId('search').value = '';
  selected = agentWorkspace?.projectId || data?.projects[0]?.id;
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
  if (!project) {
    byId('detail').replaceChildren();
    return;
  }
  const heading = element('div', '', 'heading');
  const title = element('div');
  title.append(element('h2', project.name), link(project.owner + ' / Domino project', project.url));
  heading.append(title, button('Start new workspace', () => createDialog(project), 'primary'));
  const rows = data.workspaces.filter(workspace => workspace.projectId === project.id);
  byId('detail').replaceChildren(heading, ...(rows.length ? rows.map(workspace => row(workspace)) :
    [element('p', 'You have no workspaces in this project.')]));
}

const bootstrapProblems = {
  'ssh-off': 'Restart required to connect sessions',
  'no-sshd': 'No SSH server in this environment',
  unsupported: 'Agent sessions unavailable',
  failed: 'Connector retrying',
};

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
  const problem = workspace.running && !workspace.connector.connected && bootstrapProblems[workspace.bootstrap?.state];
  if (workspace.running && workspace.connector.ready) {
    meta.append(document.createTextNode('  ·  Agent sessions ready'));
  } else if (problem) {
    meta.append(document.createTextNode(`  ·  ${problem}`));
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
      button('Stop', () => confirmWorkspaceAction(workspace, 'stop'), 'danger'));
  } else if (workspace.state === 'Stopped' && !transition && !pending.has(workspace.id)) {
    const path = `projects/${workspace.projectId}/workspaces/${workspace.id}/resume`;
    controls.append(button('Resume workspace', () => runAction(path, {}), 'primary'));
    controls.append(button('Delete', () => confirmWorkspaceAction(workspace, 'delete'), 'danger'));
  }
  container.append(label, controls);
  return container;
}

let agentWorkspace;
const normalSlot = {mount: byId('terminal')};
let splitActive = false;
let panelRefresh;
let loadNumber = 0;
let activeStart = false;
let runningAgents = [];
let selectedPane;
let autoAttach = false;
let historyRows = [];
let visibleView = 'agent';
let gitView;
const gitViews = new Map();

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
  normalSlot.request = undefined;
  clearTimeout(panelRefresh);
  detachTerminal(normalSlot);
  agentWorkspace = undefined;
  gitView = undefined;
  byId('agent-panel').hidden = true;
  byId('ide-frame').replaceChildren();
}

function showAgents(workspace, preferred) {
  const wasSplit = splitActive;
  let transfer;
  if (wasSplit) {
    const previous = sessionStorage.getItem('agent:' + workspaceKey(workspace));
    const matches = splitTiles.map(tile => tile.terminal || tile.request)
      .filter(item => item && workspaceKey(item.workspace) === workspaceKey(workspace));
    transfer = preferred || matches.find(item => item.pane === previous) || matches[0];
    leaveSplit(transfer);
  }
  if (agentWorkspace && workspaceKey(agentWorkspace) === workspaceKey(workspace)) {
    if (transfer) restoreNormalTerminal(transfer);
    showAgentTerminal();
    if (wasSplit) {
      renderWorkspaceTabs();
      loadAgents(agentWorkspace);
    }
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
    button('Stop workspace', () => confirmWorkspaceAction(workspace, 'stop'), 'danger')
  );
  ['agent-controls', 'agent-running', 'workspace-ide'].forEach(id => byId(id).replaceChildren());
  byId('agent-view').hidden = false;
  byId('ide-panel').hidden = true;
  byId('agent-empty').hidden = true;
  byId('agent-restart').hidden = true;
  agentNotice('Loading agent sessions…');
  if (transfer) {
    restoreNormalTerminal(transfer);
    focusTerminal(normalSlot.terminal);
  }
  renderWorkspaceTabs();
  loadWorkspaceIDE(workspace);
  gitView = workspaceGitView(workspace);
  renderGit(gitView);
  checkGit(gitView);
  loadAgents(workspace);
}

function showAgentTerminal() {
  visibleView = 'agent';
  byId('agent-view').hidden = false;
  byId('ide-panel').hidden = true;
  const tab = byId('workspace-ide').querySelector('[role=tab]');
  if (tab) tab.setAttribute('aria-selected', 'false');
  renderAgentTabs();
  focusTerminal(normalSlot.terminal);
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

function workspaceGitView(workspace) {
  const key = workspaceKey(workspace);
  let view = gitViews.get(key);
  if (!view) {
    view = {workspace, status: {state: 'busy', detail: 'Checking this workspace’s Git status…'}};
    gitViews.set(key, view);
  }
  return view;
}

function renderGitControl(control, feedback, {status, result}) {
  const {state, detail} = status;
  control.dataset.state = state;
  control.setAttribute('aria-disabled', String(state === 'disabled' || state === 'busy'));
  control.title = `Sync Git · ${detail}`;
  control.setAttribute('aria-label', `Sync Git. ${detail}`);
  const message = result ? (result.synced ? 'Git is up to date.' : result.detail) : '';
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.classList.toggle('error', result?.state === 'error');
}

function renderTileGit(slot, view) {
  slot.sync.hidden = !view || view.status.state === 'disabled';
  if (view) renderGitControl(slot.sync, slot.gitFeedback, view);
  else slot.gitFeedback.hidden = true;
}

function renderGit(view) {
  if (view === gitView) {
    renderGitControl(byId('git-sync'), byId('git-feedback'), view);
    byId('git-icon').textContent = gitIcons[view.status.state];
  }
  for (const slot of splitTiles) if (slot.gitView === view) renderTileGit(slot, view);
}

async function requestGit(view, sync) {
  const {workspace} = view;
  try {
    return await api(`projects/${workspace.projectId}/workspaces/${workspace.id}/git`,
      sync ? {run: workspace.run} : undefined, AbortSignal.timeout(sync ? 125000 : 85000));
  } catch (error) {
    let detail = error.message;
    if (error.name === 'TimeoutError') detail = 'The workspace took too long to respond.';
    if (error instanceof TypeError) detail = 'Could not reach the workspace.';
    if (detail === 'Unknown connector action.') detail = 'Restart this workspace to update its connector.';
    return {state: 'error', detail};
  }
}

async function checkGit(view) {
  if (view.check || view.syncing) return;
  view.check = requestGit(view, false);
  const status = await view.check;
  view.check = undefined;
  if (!view.syncing) {
    view.status = status;
    renderGit(view);
  }
}

function refreshGit() {
  const views = splitActive ? splitTiles.map(slot => slot.gitView) : [gitView];
  return Promise.all([...new Set(views.filter(Boolean))].map(checkGit));
}

async function syncGit(view) {
  if (!view || view.syncing || ['disabled', 'busy'].includes(view.status.state)) return;
  view.syncing = true;
  view.result = undefined;
  view.status = {state: 'busy', detail: 'Syncing this workspace’s Git branch…'};
  renderGit(view);
  await view.check;
  const status = await requestGit(view, true);
  view.syncing = false;
  view.status = view.result = status;
  renderGit(view);
  if (status.state === 'busy') setTimeout(refreshGit, 1500);
}

byId('git-sync').addEventListener('click', () => syncGit(gitView));
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
  if (selectedPane === item.pane && (normalSlot.terminal || normalSlot.request)) return;
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
      const canRestart = !list.connected && workspace.canEnable && data.managedAvailable;
      byId('agent-empty').hidden = true;
      byId('agent-restart').hidden = !canRestart || Boolean(normalSlot.terminal || normalSlot.request);
      if (canRestart) renderConnectorRestart(workspace);
      runningAgents = [];
      renderAgentTabs();
      if (!normalSlot.request && !restarting.has(workspace.id)) {
        agentNotice(canRestart ? '' : list.detail || (workspace.managed
          ? 'Waiting for the workspace connector to start…'
          : 'Agent sessions are unavailable for this workspace’s environment.'));
      }
      return;
    }
    byId('agent-restart').hidden = true;
    if (byId('agent-controls').dataset.workspace !== workspaceKey(workspace) ||
        !byId('agent-controls').querySelector('#new-codex')) {
      const codex = button('New Codex', () => launchAgent({kind: 'codex'}), 'primary');
      codex.id = 'new-codex';
      const claude = button('New Claude Code', () => launchAgent({kind: 'claude'}), 'primary');
      claude.id = 'new-claude';
      byId('agent-controls').dataset.workspace = workspaceKey(workspace);
      byId('agent-controls').replaceChildren(codex, claude, button('History', openHistory));
    }
    if (!normalSlot.request && !byId('agent-summary').classList.contains('error')) agentNotice(list.detail || '');
    runningAgents = list.running;
    renderAgentTabs();
    refreshSplitTitles(workspace, runningAgents);
    renderWorkspaceTabs();
    const empty = byId('agent-empty');
    empty.hidden = Boolean(normalSlot.terminal || normalSlot.request);
    empty.textContent = runningAgents.length ? 'Choose an agent tab to attach.' :
      'Start an agent or resume a conversation from History.';
    if (autoAttach && !splitActive && runningAgents.length && !normalSlot.terminal &&
        !normalSlot.request && visibleView === 'agent') {
      autoAttach = false;
      const previous = sessionStorage.getItem('agent:' + workspaceKey(workspace));
      selectAgent(runningAgents.find(item => item.pane === previous) || runningAgents[0]);
    }
  } catch (error) {
    if (agentWorkspace === workspace && load === loadNumber && !normalSlot.request) {
      agentNotice(error.message, true);
    }
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
  if (starting) activeStart = true;
  autoAttach = false;
  detachTerminal(normalSlot);
  selectedPane = payload.pane;
  showAgentTerminal();
  byId('agent-empty').hidden = true;
  try {
    await connectAgent(normalSlot, workspace, payload, label);
  } finally {
    if (starting) activeStart = false;
  }
}

const paneRequests = new Map();

function retryableTerminalError(error) {
  return error instanceof TypeError || error.name === 'TimeoutError' ||
    error.status === 429 || error.status >= 500;
}

async function connectAgent(slot, workspace, payload, label, recovering = false) {
  const status = recovering ? 'Reconnecting…' :
    payload.pane ? 'Attaching…' : payload.conversation ? 'Resuming conversation…' : 'Starting agent…';
  const request = {slot, workspace, pane: payload.pane, label, status};
  slot.request = request;
  slotNotice(slot, status);
  renderTerminalSlot(slot);
  const current = () => request.slot.request === request;
  const key = payload.pane && JSON.stringify([workspaceKey(workspace), payload.pane]);
  const previous = paneRequests.get(key);
  const open = async () => {
    const path = agentPath(workspace) + (payload.pane ? '/attach' : '');
    const body = recovering ? {...payload, run: workspace.run} : payload;
    const delays = recovering ? [1000, 2000, 4000, 8000, 8000, 8000] : [];
    for (let attempt = 0; current(); attempt++) {
      try {
        return await api(path, body, recovering ? AbortSignal.timeout(80000) : undefined);
      } catch (error) {
        // The workspace connector can take a few seconds to register again.
        if (attempt >= delays.length || !(error.status === 409 || retryableTerminalError(error))) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  };
  // Avoid a stale attach taking control back from a newer request for the same pane.
  const opening = previous ? previous.catch(() => {}).then(open) : open();
  if (key) paneRequests.set(key, opening);
  else request.launch = opening;
  let channel;
  try {
    const opened = await opening;
    if (!opened) return;
    channel = opened.channel;
    if (!current()) {
      releaseTerminal(channel);
      return;
    }
    const host = request.slot;
    const shouldFocus = host === normalSlot ? visibleView === 'agent' : host.tile.contains(document.activeElement);
    const pane = opened.pane || payload.pane;
    if (pane) sessionStorage.setItem('agent:' + workspaceKey(workspace), pane);
    detachTerminal(host);
    openTerminal(host, workspace, pane, channel, opened.label || label, recovering);
    if (host === normalSlot) selectedPane = pane;
    slotNotice(host, '');
    if (shouldFocus) focusTerminal(host.terminal);
  } catch (error) {
    const host = request.slot;
    if (channel && host.terminal?.channel === channel) detachTerminal(host);
    else if (channel) releaseTerminal(channel);
    if (current()) {
      if (host === normalSlot) selectedPane = undefined;
      slotNotice(host, error.message, true);
    }
  } finally {
    if (key && paneRequests.get(key) === opening) paneRequests.delete(key);
    if (current()) {
      const host = request.slot;
      host.request = undefined;
      renderTerminalSlot(host);
      if (host === normalSlot) {
        renderAgentTabs();
        loadAgents(agentWorkspace);
      }
    }
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

function openTerminal(slot, workspace, pane, channel, label, recovering) {
  const mount = element('div', '', 'terminal-surface');
  const view = new Terminal({
    cursorBlink: true, fontSize: 13, convertEol: false, scrollback: 3000, theme: terminalTheme()
  });
  const fit = new FitAddon.FitAddon();
  const session = {slot, workspace, pane, channel, label, mount, view, fit, sequence: 0,
    failures: 0, recoveredAt: recovering ? Date.now() : 0};
  const active = () => session.slot.terminal === session;
  // One request in flight at a time keeps ordering, but while it is out, queued keystrokes/scrolls are
  // merged so a slow round trip doesn't build a backlog (which made typing lag and scrolling overshoot).
  const queue = [];
  let flushing = false;
  function send(action) {
    if (!active()) return;
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
      while (queue.length && active()) {
        const {text, ...action} = queue.shift();
        try {
          if (action.type !== 'terminal.input') {
            await api('terminals/' + channel, action);
            continue;
          }
          for (let pos = 0; pos < text.length && active(); pos += 8000) {
            await api('terminals/' + channel, {type: action.type, bytes: encodeInput(text.slice(pos, pos + 8000))});
          }
        } catch (error) {
          if (!active()) return;
          if (error.status === 404) terminalDisconnected(session, error, true);
          else slotNotice(session.slot, error.message, true);
        }
      }
    } finally {
      flushing = false;
    }
  }
  view.loadAddon(fit);
  slot.terminal = session;
  slot.mount.append(mount);
  renderTerminalSlot(slot);
  view.open(mount);
  view.onData(value => {
    send({type: 'terminal.input', text: value});
  });
  view.onResize(({cols, rows}) => send({
    type: 'terminal.resize', cols: Math.max(10, Math.min(350, cols)), rows: Math.max(4, Math.min(140, rows))
  }));
  // Pasted images: the agent runs in the workspace, so it can't see this browser's clipboard. Upload the
  // image to the workspace, which types its file path into the pane (both Claude Code and Codex attach it).
  const paste = async event => {
    const file = [...event.clipboardData?.files || []].find(item => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      send({type: 'terminal.image', bytes: await imageToBase64(file)});
    } catch (error) {
      if (active()) slotNotice(session.slot, error.message, true);
    }
  };
  mount.addEventListener('paste', paste, true);
  // Herdr routes wheel input to either the terminal app or its scrollback.
  const screen = mount.querySelector('.xterm-screen');
  let wheelLines = 0;
  let wheelTimer;
  let wheelCell;
  const flushWheel = () => {
    const steps = Math.trunc(wheelLines);
    if (!steps) return;
    wheelLines -= steps;
    send({type: 'terminal.scroll', direction: steps < 0 ? 'up' : 'down',
      lines: Math.min(200, Math.abs(steps)), ...wheelCell});
  };
  const wheel = event => {
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
    if (wheelTimer !== undefined || Math.abs(wheelLines) < 1) return;
    // Send the first step immediately and batch the rest of the burst.
    flushWheel();
    wheelTimer = setTimeout(() => {
      wheelTimer = undefined;
      flushWheel();
    }, 40);
  };
  mount.addEventListener('wheel', wheel, {capture: true, passive: false});
  const resize = new ResizeObserver(() => { if (mount.offsetWidth && mount.offsetHeight) fit.fit(); });
  resize.observe(mount);
  session.cleanup = () => {
    clearTimeout(wheelTimer);
    resize.disconnect();
    mount.removeEventListener('wheel', wheel, true);
    mount.removeEventListener('paste', paste, true);
  };
  if (mount.offsetWidth && mount.offsetHeight) fit.fit();
  send({type: 'terminal.resize', cols: Math.max(10, Math.min(350, view.cols)), rows: Math.max(4, Math.min(140, view.rows))});
  pumpTerminal(session);
}

async function pumpTerminal(session) {
  if (session.slot.terminal !== session || session.poll) return;
  const poll = new AbortController();
  session.poll = poll;
  session.pollStarted = Date.now();
  // The server holds a healthy long poll for at most 12 seconds.
  const timeout = setTimeout(() => poll.abort(new DOMException('Terminal poll timed out.', 'TimeoutError')), 20000);
  const current = () => session.slot.terminal === session && session.poll === poll;
  let retryDelay;
  try {
    const result = await api(
      'terminals/' + session.channel + '?wait=12&after=' + session.sequence, undefined, poll.signal
    );
    if (!current()) return;
    for (const frame of result.frames) {
      session.view.write(decodeFrame(frame.bytes));
      session.sequence = frame.seq;
    }
    session.failures = 0;
    if (result.closed) terminalDisconnected(session);
    else retryDelay = 0;
  } catch (error) {
    if (!current()) return;
    const retryable = retryableTerminalError(error);
    if (retryable && ++session.failures <= 4) retryDelay = 1000 * session.failures;
    else terminalDisconnected(session, error, retryable || error.status === 404);
  } finally {
    clearTimeout(timeout);
    if (current()) {
      session.poll = undefined;
      if (retryDelay) session.pollRetry = setTimeout(() => pumpTerminal(session), retryDelay);
      else if (retryDelay === 0) pumpTerminal(session);
    }
  }
}

function restartTerminalPoll(session) {
  clearTimeout(session.pollRetry);
  const previous = session.poll;
  session.poll = undefined;
  previous?.abort();
  pumpTerminal(session);
}

function terminalDisconnected(session, error, reattach = false) {
  const {slot, workspace, pane, label} = session;
  const hadFocus = session.mount.contains(document.activeElement);
  const recover = reattach && pane && !slot.request && Date.now() - session.recoveredAt > 30000;
  detachTerminal(slot);
  if (slot === normalSlot) {
    selectedPane = recover ? pane : undefined;
    renderAgentTabs();
  } else if (hadFocus) {
    slot.add.focus({preventScroll: true});
  }
  if (slot.request) return;
  if (recover) {
    connectAgent(slot, workspace, {pane}, label, true);
    return;
  }
  const message = slot === normalSlot ? 'Select the agent to attach again.' : 'Choose a running session to continue.';
  slotNotice(slot, `${error?.message || 'The terminal disconnected.'} ${message}`, true);
}

function releaseTerminal(channel) {
  api('terminals/' + channel, {type: 'terminal.release'}).catch(() => {});
}

function detachTerminal(slot) {
  const session = slot.terminal;
  if (!session) return;
  slot.terminal = undefined;
  clearTimeout(session.pollRetry);
  session.poll?.abort();
  session.cleanup?.();
  session.view.dispose();
  session.mount.remove();
  renderTerminalSlot(slot);
  releaseTerminal(session.channel);
}

byId('terminal-detach').addEventListener('click', () => {
  normalSlot.request = undefined;
  detachTerminal(normalSlot);
  selectedPane = undefined;
  autoAttach = false;
  renderAgentTabs();
  loadAgents(agentWorkspace);
});

function iconButton(label, action, icon, className) {
  const control = button('', action, className);
  control.title = label;
  control.setAttribute('aria-label', label);
  icon.setAttribute('aria-hidden', 'true');
  control.append(icon);
  return control;
}

function makeTile(side) {
  const tile = element('section', '', 'session-tile');
  tile.setAttribute('aria-label', `${side} session tile`);
  tile.tabIndex = -1;
  const title = element('span', '', 'tile-title');
  const subtitle = element('span', '', 'meta');
  const mount = element('div', '', 'tile-terminal');
  const status = element('p', '', 'tile-status');
  status.setAttribute('role', 'status');
  const slot = {tile, title, subtitle, mount, status};
  const label = element('div', '', 'tile-label');
  label.append(title, subtitle);
  const actions = element('div', '', 'tile-actions');
  slot.actions = actions;
  slot.sync = iconButton('Sync Git', () => syncGit(slot.gitView), element('span', '↻'), 'git-sync');
  slot.sync.hidden = true;
  slot.gitFeedback = element('p', '', 'tile-status');
  slot.gitFeedback.setAttribute('role', 'status');
  slot.gitFeedback.hidden = true;
  const maximize = element('span', '', 'maximize-icon');
  for (let i = 0; i < 4; i++) maximize.append(element('i'));
  slot.change = iconButton('Change session', () => openSessionPicker(slot), element('span', '⇄'));
  slot.full = iconButton('Open full width', () => {
    const session = slot.terminal;
    showAgents(session.workspace, session);
  }, maximize);
  slot.change.setAttribute('aria-haspopup', 'dialog');
  actions.append(slot.sync, slot.change, slot.full);
  const header = element('div', '', 'terminal-bar tile-heading');
  header.append(label, actions);
  slot.empty = element('div', '', 'tile-empty');
  slot.add = button('Add session', () => openSessionPicker(slot), 'tile-add');
  slot.add.setAttribute('aria-haspopup', 'dialog');
  slot.empty.append(slot.add);
  tile.append(header, status, slot.gitFeedback, slot.empty, mount);
  tile.addEventListener('pointerenter', event => {
    if (event.pointerType === 'mouse' && !event.buttons && !document.querySelector('dialog[open]')) {
      if (slot.terminal) focusTerminal(slot.terminal);
      else tile.focus({preventScroll: true});
    }
  });
  renderTerminalSlot(slot);
  slotNotice(slot, '');
  return slot;
}

function renderTerminalSlot(slot) {
  const {terminal, request} = slot;
  if (slot === normalSlot) {
    byId('terminal-panel').hidden = !terminal;
    return;
  }
  const item = terminal || request;
  slot.title.textContent = item?.label || (request ? 'Agent session' : 'No session');
  slot.title.title = slot.title.textContent;
  slot.subtitle.textContent = item ? workspaceLabel(item.workspace) : '';
  slot.subtitle.title = slot.subtitle.textContent;
  slot.subtitle.hidden = !item;
  slot.mount.hidden = !terminal;
  slot.change.hidden = !terminal;
  slot.full.hidden = !terminal;
  slot.empty.hidden = Boolean(terminal);
  const workspace = splitActive && !request ? terminal?.workspace : undefined;
  const view = workspace && workspaceGitView(workspace);
  if (slot.gitView === view) return;
  slot.gitView = view;
  slot.ide?.remove();
  slot.ide = undefined;
  if (workspace?.tool === 'vscode') {
    const ide = workspaceIDELink(workspace, '</>', workspaceIDEPath(workspace), 'button tile-ide');
    ide.title = 'Open VS Code in a new browser tab';
    ide.setAttribute('aria-label', ide.title);
    slot.actions.insertBefore(ide, slot.change);
    slot.ide = ide;
  }
  renderTileGit(slot, view);
  if (view) checkGit(view);
}

function refreshSplitTitles(workspace, agents) {
  if (!splitActive) return;
  for (const slot of splitTiles) {
    const session = slot.terminal;
    if (!session || workspaceKey(session.workspace) !== workspaceKey(workspace)) continue;
    const agent = agents.find(item => item.pane === session.pane);
    const label = agent?.title || agent?.label;
    if (label && label !== session.label) {
      session.label = label;
      renderTerminalSlot(slot);
    }
  }
}

function slotNotice(slot, message, error = false) {
  if (slot === normalSlot) {
    agentNotice(message, error);
    return;
  }
  slot.status.textContent = message;
  slot.status.hidden = !message;
  slot.status.classList.toggle('error', error);
}

function focusTerminal(session) {
  if (!session?.mount.offsetWidth || !session.mount.offsetHeight) return;
  session.fit.fit();
  session.view.focus();
}

function moveTerminal(item, target) {
  const source = item.slot;
  const key = item.view ? 'terminal' : 'request';
  source[key] = undefined;
  target[key] = item;
  item.slot = target;
  if (item.view) target.mount.append(item.mount);
  renderTerminalSlot(source);
  renderTerminalSlot(target);
}

function restoreNormalTerminal(item) {
  moveTerminal(item, normalSlot);
  autoAttach = false;
  selectedPane = item.pane;
  byId('agent-empty').hidden = true;
  agentNotice(item.status || '');
}

function enterSplit() {
  if (splitActive) return;
  splitActive = true;
  const current = normalSlot.terminal || normalSlot.request;
  const [left] = splitTiles;
  byId('agent-panel').hidden = true;
  byId('empty-workspaces').hidden = true;
  splitPanel.hidden = false;
  if (current) {
    moveTerminal(current, left);
    refreshSplitTitles(current.workspace, runningAgents);
    selectedPane = undefined;
    slotNotice(left, current.status || '');
    if (left.terminal) focusTerminal(left.terminal);
    else left.tile.focus({preventScroll: true});
  }
  renderWorkspaceTabs();
}

function leaveSplit(transfer) {
  splitActive = false;
  sessionPicker.close();
  splitPanel.hidden = true;
  byId('agent-panel').hidden = !agentWorkspace;
  for (const slot of splitTiles) {
    if (slot.request !== transfer) slot.request = undefined;
    if (slot.terminal !== transfer) detachTerminal(slot);
    slotNotice(slot, '');
    renderTerminalSlot(slot);
  }
}

function workspaceLabel(workspace) {
  return workspace.name && workspace.name !== workspace.project
    ? `${workspace.project} / ${workspace.name}` : workspace.project;
}

async function openSessionPicker(slot) {
  if (slot.request || sessionPicker.open) return;
  pickerRequest?.abort();
  const controller = new AbortController();
  pickerRequest = controller;
  pickerList.replaceChildren(element('p', 'Loading running sessions…'));
  sessionPicker.showModal();
  const workspaces = data.workspaces.filter(workspace => workspace.running && !changing.has(workspace.id));
  const launch = splitTiles.find(tile => tile.request?.launch)?.request.launch;
  const inventories = await Promise.allSettled(workspaces.map(workspace =>
    api(agentPath(workspace) + '?live=1', undefined, controller.signal)));
  // A session started just before entering split may appear in inventory before its pane ID is known here.
  await launch?.catch(() => {});
  if (controller.signal.aborted || !sessionPicker.open || !splitActive) return;
  const choices = [];
  let running = 0;
  let failed = false;
  inventories.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed = true;
      return;
    }
    const workspace = workspaces[index];
    for (const item of result.value.running || []) {
      running++;
      const inTile = splitTiles.some(tile => [tile.terminal, tile.request].some(open =>
        open?.pane === item.pane && workspaceKey(open.workspace) === workspaceKey(workspace)));
      if (inTile) continue;
      const label = item.title || item.label || agentKind(item);
      const option = button('', () => {
        sessionPicker.close();
        connectAgent(slot, workspace, {pane: item.pane}, label);
      }, 'session-option');
      option.append(element('strong', label), element('span', workspaceLabel(workspace), 'meta'));
      choices.push(option);
    }
  });
  if (!choices.length && !failed) {
    choices.push(element('p', running ? 'All running sessions are already open in split view.' :
      'Start or resume an agent from a workspace tab, then return here to add it.'));
  }
  if (failed) choices.push(element('p', 'Some workspaces couldn’t be checked. Close and reopen the picker to try again.', 'error'));
  pickerList.replaceChildren(...choices);
}

const splitPanel = byId('split-panel');
const splitTiles = [makeTile('Left'), makeTile('Right')];
splitPanel.append(...splitTiles.map(slot => slot.tile));
const sessionPicker = byId('session-picker');
const pickerList = byId('session-picker-list');
let pickerRequest;
sessionPicker.addEventListener('close', () => { if (!sessionPicker.open) pickerRequest?.abort(); });

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
  }, 'danger confirm-danger');
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

function renderConnectorRestart(workspace) {
  const busy = restarting.has(workspace.id);
  const action = byId('agent-restart-button');
  action.disabled = busy;
  const label = busy ? 'Restarting workspace…' : 'Restart workspace';
  if (action.textContent !== label) action.textContent = label;
  const description = byId('agent-restart-description');
  const message = data.setup?.mode === 'ssh'
    ? 'SSH was off when this workspace started. Restart it to turn on SSH and connect agent sessions here.'
    : 'Restart this workspace to connect Codex and Claude Code here.';
  if (description.textContent !== message) description.textContent = message;
}

function confirmConnectorRestart(workspace) {
  dialogBody.replaceChildren(
    element('h2', 'Restart workspace?'),
    element('strong', workspaceLabel(workspace)),
    element('p', data.setup?.mode === 'ssh'
      ? 'This ends running processes. Domino then resumes the workspace in its current environment with SSH on, and this App connects its agent sessions.'
      : 'This ends running processes. Domino will then resume the workspace and connect it to this App when the connector is available.'),
    button('Restart workspace', () => {
      dialog.close();
      restartWithConnector(workspace);
    }, 'primary')
  );
  dialog.showModal();
}

async function restartWithConnector(workspace) {
  if (restarting.has(workspace.id)) return;
  restarting.add(workspace.id);
  renderConnectorRestart(workspace);
  const path = `projects/${workspace.projectId}/workspaces/${workspace.id}`;
  try {
    await api(path + '/stop-for-connector', {confirmed: true});
    notice('Stopping the workspace so Domino can enable agent sessions.');
    if (agentWorkspace === workspace) agentNotice('Waiting for Domino to stop the workspace…');
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
  } finally {
    restarting.delete(workspace.id);
    if (agentWorkspace?.id === workspace.id) renderConnectorRestart(agentWorkspace);
  }
}

async function createDialog(project) {
  dialogBody.replaceChildren(element('h2', `Start a workspace · ${project.name}`), element('p', 'Loading available IDEs…'));
  dialog.showModal();
  try {
    const {mode, tools, connectorTools, sameBase} = await api(`projects/${project.id}/configuration`);
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
      description.textContent = mode === 'ssh'
        ? 'Uses this project’s default compute environment and hardware tier. Agent sessions connect over Domino SSH.'
        : managed.checked
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
byId('agent-restart-button').addEventListener('click', () => confirmConnectorRestart(agentWorkspace));
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
byId('connector-settings').addEventListener('click', () => openSetup());
byId('connector-setup-open').addEventListener('click', () => openSetup());
byId('credentials-banner-open').addEventListener('click', event =>
  openSetup({signIn: true, provider: event.currentTarget.dataset.provider || undefined}));
byId('credentials-banner-dismiss').addEventListener('click', () => {
  storageSet('workspace-sessions-signin-dismissed', '1');
  renderCredentialsBanner();
});
byId('setup-done').addEventListener('click', () => setupDialog.close());
setupDialog.addEventListener('close', () => {
  storageSet('workspace-sessions-setup-seen', '1');
  byId('setup-welcome').hidden = true;
});
byId('setup-create').addEventListener('click', () => configureConnector('create'));
byId('setup-link').addEventListener('submit', event => {
  event.preventDefault();
  configureConnector('link', new FormData(event.currentTarget).get('environmentId').trim());
});
byId('refresh').addEventListener('click', () => refresh().then(refreshGit).catch(error => notice(error.message, true)));
refresh().then(() => {
  notice('');
  if (needsFirstRunSetup()) openSetup({welcome: true});
}).catch(error => notice(error.message, true));

const themeControl = byId('theme');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeControl.setAttribute('aria-pressed', String(dark));
  themeControl.textContent = dark ? 'Light mode' : 'Dark mode';
  for (const slot of [normalSlot, ...splitTiles]) {
    if (slot.terminal) slot.terminal.view.options.theme = terminalTheme();
  }
}
const systemTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
setTheme(localStorage.getItem('workspace-sessions-theme') || systemTheme);
themeControl.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('workspace-sessions-theme', theme);
  setTheme(theme);
});

function resumeTerminalPolling() {
  if (document.hidden) return;
  const now = Date.now();
  for (const {terminal} of [normalSlot, ...splitTiles]) {
    if (!terminal || now - (terminal.lastPollRestart || 0) < 12000) continue;
    if (terminal.poll && now - terminal.pollStarted < 12000) continue;
    terminal.lastPollRestart = now;
    restartTerminalPoll(terminal);
  }
}

window.addEventListener('focus', resumeTerminalPolling);
window.addEventListener('online', resumeTerminalPolling);
window.addEventListener('pageshow', resumeTerminalPolling);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  resumeTerminalPolling();
  if (agentWorkspace) loadAgents(agentWorkspace);
  refreshGit();
  pollOtherWorkspaces();
});

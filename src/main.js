'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Tray,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');

const P = require('./core/paths');
const config = require('./core/config');
const profiles = require('./core/profiles');
const claudeApp = require('./core/claudeApp');
const usage = require('./core/usage');
const cliusage = require('./core/cliusage');
const i18n = require('./i18n');

const ASSETS = path.join(__dirname, '..', 'assets');

// A drop of at least this many percent counts as a limit window reset.
const RESET_MIN_DROP = 25;

let mainWin = null;
let settingsWin = null;
let consentWin = null;
let tray = null;
let pollTimer = null;
let usageWatcher = null;
let lastRunning = null;
let isQuitting = false;
let lang = 'en';
let switching = false;

// org -> { fh: {value, notifiedFor}, sd: {...} } — keeps notifications to one per window
const limitState = Object.create(null);

const t = (key, params) => i18n.translate(lang, key, params);

/* ---------------------------------------------------------- single instance */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--settings')) openSettings();
    else showMain();
  });
}

/* ----------------------------------------------------------------- helpers */

function exePath() {
  // A portable build unpacks into a temp folder; the real path comes from env.
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

const autoStartSupported = () => app.isPackaged;

function applyAutoStart(enabled) {
  if (!autoStartSupported()) return false;
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: exePath(), args: ['--hidden'] });
    return true;
  } catch {
    return false;
  }
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast(channel, payload) {
  for (const w of [mainWin, settingsWin, consentWin]) send(w, channel, payload);
}

function dictPayload() {
  const d = i18n.dict(lang);
  return { lang, locale: d.locale, dict: d };
}

function themePayload() {
  return { source: config.get('theme'), dark: nativeTheme.shouldUseDarkColors };
}

function applyLanguage() {
  lang = i18n.resolveLang(config.get('language'), app.getLocale());
  broadcast('i18n:changed', dictPayload());
  buildTray();
}

function applyTheme() {
  const source = config.get('theme');
  nativeTheme.themeSource = ['dark', 'light'].includes(source) ? source : 'system';
  const bg = nativeTheme.shouldUseDarkColors ? '#1b1a19' : '#faf9f5';
  for (const w of [mainWin, settingsWin, consentWin]) {
    if (w && !w.isDestroyed()) w.setBackgroundColor(bg);
  }
  broadcast('theme:changed', themePayload());
}

/* ------------------------------------------------------------------ windows */

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
});

function baseWindowOptions() {
  return {
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a19' : '#faf9f5',
    show: false,
    icon: path.join(ASSETS, 'icon.ico'),
    webPreferences: webPreferences(),
  };
}

function createMainWindow({ forceShow = false } = {}) {
  const saved = config.get('windowBounds');
  mainWin = new BrowserWindow(
    Object.assign(baseWindowOptions(), {
      width: (saved && saved.width) || 1180,
      height: (saved && saved.height) || 780,
      x: saved && saved.x,
      y: saved && saved.y,
      minWidth: 940,
      minHeight: 620,
    })
  );

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const startHidden = !forceShow && (process.argv.includes('--hidden') || config.get('startMinimized'));
  mainWin.once('ready-to-show', () => {
    if (!startHidden) mainWin.show();
  });

  mainWin.on('close', (e) => {
    const b = mainWin.getNormalBounds();
    config.set({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
    if (!isQuitting && config.get('closeToTray')) {
      e.preventDefault();
      mainWin.hide();
    }
  });

  mainWin.on('minimize', (e) => {
    if (config.get('minimizeToTray')) {
      e.preventDefault();
      mainWin.hide();
    }
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showMain(tab) {
  if (!mainWin) createMainWindow({ forceShow: true });
  else {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
  if (tab) send(mainWin, 'nav:tab', tab);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow(
    Object.assign(baseWindowOptions(), {
      width: 640,
      height: 720,
      minWidth: 560,
      minHeight: 520,
      parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined,
    })
  );
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * The notice shown before first use. In "gate" mode the app does not continue
 * until it is accepted; opened from Settings it is a plain read-only window.
 */
function openConsent(mode) {
  if (consentWin && !consentWin.isDestroyed()) {
    consentWin.show();
    consentWin.focus();
    return;
  }
  consentWin = new BrowserWindow(
    Object.assign(baseWindowOptions(), {
      width: 620,
      height: 760,
      minWidth: 520,
      minHeight: 520,
      resizable: true,
    })
  );
  consentWin.gateMode = mode === 'gate';
  consentWin.loadFile(path.join(__dirname, 'renderer', 'consent.html'));
  consentWin.once('ready-to-show', () => consentWin.show());
  consentWin.on('closed', () => {
    const wasGate = consentWin && consentWin.gateMode;
    consentWin = null;
    // Closing the gate without accepting means the app must not proceed.
    if (wasGate && config.get('consentVersion') < config.CONSENT_VERSION) {
      isQuitting = true;
      app.quit();
    }
  });
  consentWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* -------------------------------------------------------------------- tray */

function activeUsage(list) {
  const active = list.find((p) => p.isActive);
  if (!active || !active.account) return { active, u: null };
  const plan = usage.readPlanUsage();
  const u = plan.ok ? plan.orgs[active.account.organizationUuid] : null;
  return { active, u: u || null };
}

function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.ico')));
    tray.on('click', () => (mainWin && mainWin.isVisible() ? mainWin.hide() : showMain()));
  }

  let list = [];
  try {
    list = profiles.listProfiles({ withSize: false });
  } catch {
    // Storage may not exist yet.
  }

  const { active, u } = activeUsage(list);
  const running = lastRunning && lastRunning.running;

  const header = [
    { label: active ? `${active.label || active.slot}${active.account ? ` — ${active.account.email}` : ''}` : t('tray.noProfile'), enabled: false },
  ];
  if (u) header.push({ label: t('tray.usageLine', { fh: u.latest.fh, sd: u.latest.sd }), enabled: false });

  const menu = Menu.buildFromTemplate([
    ...header,
    { type: 'separator' },
    { label: t('tray.open'), click: () => showMain('overview') },
    { label: t('tray.limits'), click: () => showMain('limits') },
    { type: 'separator' },
    {
      label: t('tray.switchTo'),
      enabled: list.length > 1 && !switching,
      submenu: list.map((p) => ({
        label: `${p.label || p.slot}${p.account ? ` — ${p.account.email}` : ''}`,
        type: 'radio',
        checked: p.isActive,
        enabled: !p.isActive && !switching,
        click: () => trySwitchFromTray(p.slot),
      })),
    },
    { type: 'separator' },
    { label: t('tray.launch'), enabled: !running, click: () => claudeApp.launch(config.get('claudeApp')) },
    { label: t('tray.close'), enabled: !!running, click: () => claudeApp.close().then(pollOnce) },
    { type: 'separator' },
    {
      label: t('tray.notifications'),
      type: 'checkbox',
      checked: !!config.get('notifications'),
      click: (item) => config.set({ notifications: item.checked }),
    },
    {
      label: t('tray.autoStart'),
      type: 'checkbox',
      checked: !!config.get('autoStart'),
      enabled: autoStartSupported(),
      click: (item) => config.set({ autoStart: item.checked }),
    },
    { label: t('tray.settings'), click: () => openSettings() },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip(
    u
      ? t('tray.tooltipProfile', { slot: active.label || active.slot, fh: u.latest.fh, sd: u.latest.sd })
      : t('tray.tooltipIdle')
  );
  tray.setContextMenu(menu);
}

/** Hands the switch to the main window so the confirmation matches the app's own style. */
function requestSwitchInWindow(slot) {
  if (!mainWin) {
    createMainWindow({ forceShow: true });
    mainWin.webContents.once('did-finish-load', () => send(mainWin, 'ui:switchRequest', slot));
    return;
  }
  showMain();
  send(mainWin, 'ui:switchRequest', slot);
}

/**
 * Switching from the tray. With Claude closed nothing needs confirming, so it
 * happens in place; otherwise the window comes up and asks there.
 */
async function trySwitchFromTray(slot) {
  const state = await claudeApp.isRunning();
  if (state.running) {
    requestSwitchInWindow(slot);
    return;
  }

  const result = await doSwitch(slot, false);
  if (result.ok) notify(t('notif.switchedTitle'), t('notif.switchedBody', { slot }));
  else notify(t('app.name'), t(`err.${result.code}`, { detail: result.detail, slot: result.slot }));
}

async function doSwitch(slot, autoClose) {
  switching = true;
  buildTray();
  const res = await profiles.switchProfile(slot, {
    autoClose,
    launch: config.get('launchAfterSwitch'),
    scope: config.get('switchScope'),
    claudeApp: config.get('claudeApp'),
  });
  switching = false;
  await pollOnce();
  broadcast('profiles:changed');
  return res;
}

/* ------------------------------------------------------------------ polling */

async function pollOnce() {
  const state = await claudeApp.isRunning();
  const changed = !lastRunning || lastRunning.running !== state.running || lastRunning.count !== state.count;
  lastRunning = state;
  if (changed) {
    broadcast('claude:state', state);
    buildTray();
  }
  return state;
}

function startPolling() {
  const period = Math.max(2, Number(config.get('pollIntervalSec')) || 4) * 1000;
  if (pollTimer) clearInterval(pollTimer);
  pollOnce();
  pollTimer = setInterval(pollOnce, period);
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: path.join(ASSETS, 'icon.ico') }).show();
}

/**
 * Notifies once per limit window when usage crosses the threshold, and once
 * when a window rolls over and the counter drops back down.
 */
function checkLimits() {
  if (!config.get('notifications')) return;

  const threshold = Number(config.get('notifyThreshold')) || 90;
  const wantReset = !!config.get('notifyOnReset');

  let list = [];
  try {
    list = profiles.listProfiles({ withSize: false });
  } catch {
    return;
  }

  const plan = usage.readPlanUsage();
  if (!plan.ok) return;

  for (const p of list) {
    const org = p.account && p.account.organizationUuid;
    const u = org && plan.orgs[org];
    if (!u) continue;

    const name = p.label || p.slot;
    if (!limitState[org]) limitState[org] = {};

    for (const key of ['fh', 'sd']) {
      const value = u.latest[key];
      const start = (key === 'fh' ? u.fiveHour : u.weekly).start;
      const prev = limitState[org][key];

      if (wantReset && prev && prev.value - value >= RESET_MIN_DROP) {
        notify(
          t('notif.resetTitle'),
          t('notif.resetBody', { slot: name, window: t(`notif.window.${key}`), was: prev.value, now: value })
        );
      }

      let notifiedFor = prev ? prev.notifiedFor : null;
      if (!u.stale && value >= threshold && start && notifiedFor !== start) {
        notify(
          t('notif.limitTitle', { pct: value }),
          t('notif.limitBody', { slot: name, window: t(`notif.window.${key}`), pct: value })
        );
        notifiedFor = start;
      }

      limitState[org][key] = { value, notifiedFor };
    }
  }
}

function startUsageWatch() {
  try {
    usageWatcher = fs.watch(P.CLAUDE_APPDATA, (_event, filename) => {
      if (!filename || !String(filename).startsWith('plan-usage-history')) return;
      clearTimeout(startUsageWatch._t);
      startUsageWatch._t = setTimeout(() => {
        broadcast('usage:changed');
        checkLimits();
        buildTray();
      }, 800);
    });
  } catch {
    // The Claude data folder may not exist; the app still works without it.
  }
}

/* -------------------------------------------------------- screenshot helper */

// --screenshot renders the real UI but with placeholder account identities, so
// documentation images never carry anybody's e-mail address or account ids.
const DEMO = process.argv.includes('--screenshot');

function demoUuid(seed) {
  const h = String(seed)
    .split('')
    .reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hex = (n, len) => n.toString(16).padStart(len, '0').slice(0, len);
  return `${hex(h, 8)}-${hex(h >>> 3, 4)}-4${hex(h >>> 7, 3)}-a${hex(h >>> 11, 3)}-${hex(h >>> 5, 12)}`;
}

const DEMO_NAMES = ['personal', 'work', 'team', 'spare'];
const demoOrg = (real) => demoUuid(`org-${real}`);

function maskProfiles(list) {
  return list.map((p, i) => {
    if (!p.account) return p;
    const label = DEMO_NAMES[i] || `account${i + 1}`;
    return Object.assign({}, p, {
      account: Object.assign({}, p.account, {
        email: `${label}@example.com`,
        displayName: label === 'work' ? 'Alex (work)' : 'Alex',
        accountUuid: demoUuid(`acc-${p.account.accountUuid}`),
        organizationUuid: demoOrg(p.account.organizationUuid),
        organizationName: `${label}@example.com's Organization`,
      }),
    });
  });
}

// Derived independently of maskProfiles so the two IPC handlers can run in any order.
function maskUsage(plan) {
  if (!plan.ok) return plan;
  const orgs = {};
  for (const [org, data] of Object.entries(plan.orgs)) {
    const key = demoOrg(org);
    orgs[key] = Object.assign({}, data, { org: key });
  }
  return Object.assign({}, plan, { orgs });
}

/** Hides the Windows user name in paths shown on screenshots. */
function maskPath(p) {
  return typeof p === 'string' ? p.split(P.HOME).join(path.join(path.dirname(P.HOME), 'alex')) : p;
}

function maskPaths(paths) {
  const out = {};
  for (const [k, v] of Object.entries(paths)) out[k] = maskPath(v);
  return out;
}

function maskCli(cli) {
  if (!cli.ok) return cli;
  const names = ['web-app', 'api-server', 'infra', 'docs-site', 'mobile', 'scripts'];
  return Object.assign({}, cli, {
    projects: cli.projects.map((p, i) => Object.assign({}, p, { project: names[i] || `project-${i + 1}` })),
  });
}

/** Dev-only: --screenshot writes window captures into docs/ and exits. */
async function runScreenshots() {
  const outDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await wait(2500);
  for (const tab of ['overview', 'limits', 'code']) {
    send(mainWin, 'nav:tab', tab);
    await wait(tab === 'code' ? 4000 : 1200);
    const img = await mainWin.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `screenshot-${tab}.png`), img.toPNG());
  }

  openSettings();
  await wait(1800);
  const simg = await settingsWin.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'screenshot-settings.png'), simg.toPNG());

  isQuitting = true;
  app.quit();
}

/* -------------------------------------------------------------------- start */

app.whenReady().then(() => {
  config.init(app.getPath('userData'));
  applyLanguage();
  applyTheme();

  if (process.platform !== 'win32') {
    dialog.showErrorBox(t('platform.title'), t('platform.body'));
    app.quit();
    return;
  }

  // Keep the real autostart entry in sync with the stored setting.
  if (autoStartSupported()) {
    const actual = app.getLoginItemSettings({ path: exePath() }).openAtLogin;
    if (actual !== config.get('autoStart')) applyAutoStart(config.get('autoStart'));
  }

  const needsConsent = config.get('consentVersion') < config.CONSENT_VERSION;
  if (needsConsent && !process.argv.includes('--screenshot')) {
    openConsent('gate');
  } else {
    startApp();
  }

  nativeTheme.on('updated', () => broadcast('theme:changed', themePayload()));

  config.onChange((_all, changed) => {
    if (changed.includes('language')) applyLanguage();
    if (changed.includes('theme')) applyTheme();
    if (changed.includes('autoStart')) applyAutoStart(config.get('autoStart'));
    if (changed.includes('pollIntervalSec')) startPolling();
    if (changed.includes('notifications')) buildTray();
    broadcast('config:changed', config.all());
  });

  app.on('activate', () => showMain());
});

function startApp() {
  createMainWindow();
  buildTray();
  startPolling();
  startUsageWatch();
  checkLimits();

  if (process.argv.includes('--settings')) openSettings();
  if (process.argv.includes('--screenshot')) runScreenshots();
}

app.on('window-all-closed', () => {
  // With "close to tray" on, the window hides instead of closing, so reaching
  // this point means tray mode is off and the app should exit.
  if (!config.get('closeToTray')) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (usageWatcher) usageWatcher.close();
});

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('app:state', async () => {
  const claude = await claudeApp.isRunning();
  lastRunning = claude;
  const list = profiles.listProfiles({ scope: config.get('switchScope') });
  return {
    claude,
    claudeApp: claudeApp.resolve(config.get('claudeApp')),
    claudeCli: claudeApp.detectCli(),
    current: profiles.readCurrentSlot(),
    profiles: DEMO ? maskProfiles(list) : list,
    storageExists: fs.existsSync(P.PROFILES_DIR),
    config: config.all(),
    paths: (DEMO ? maskPaths : (x) => x)({
      profilesDir: P.PROFILES_DIR,
      claudeAppData: P.CLAUDE_APPDATA,
      claudeDir: P.CLAUDE_DIR,
      claudeJson: P.CLAUDE_JSON,
      usageHistory: P.USAGE_HISTORY,
      projectsDir: P.PROJECTS_DIR,
      settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    }),
    switched: {
      appItems: P.DESKTOP_ITEMS,
      homeItems: P.HOME_ITEMS,
      claudeDirItems: P.CLAUDE_DIR_ITEMS,
    },
  };
});

ipcMain.handle('app:info', () => {
  let pkg = {};
  try {
    pkg = require('../package.json');
  } catch {
    // Bundled builds still ship package.json, but do not depend on it.
  }
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    autoStartSupported: autoStartSupported(),
    repo: pkg.homepage || null,
    license: pkg.license || 'MIT',
  };
});

ipcMain.handle('i18n:dict', () => dictPayload());
ipcMain.handle('i18n:list', () => i18n.available);
ipcMain.handle('theme:get', () => themePayload());

ipcMain.handle('config:get', () => config.all());
ipcMain.handle('config:set', (_e, patch) => config.set(patch));
ipcMain.handle('config:reset', () => config.reset());

ipcMain.handle('consent:accept', () => {
  config.set({ consentVersion: config.CONSENT_VERSION });
  const wasGate = consentWin && consentWin.gateMode;
  if (consentWin && !consentWin.isDestroyed()) {
    consentWin.gateMode = false;
    consentWin.close();
  }
  if (wasGate) startApp();
  return { ok: true };
});

ipcMain.handle('consent:decline', () => {
  isQuitting = true;
  app.quit();
  return { ok: true };
});

ipcMain.handle('consent:show', () => {
  openConsent('view');
  return { ok: true };
});

ipcMain.handle('consent:mode', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return { gate: !!(win && win.gateMode) };
});

ipcMain.handle('usage:plan', () => {
  const plan = usage.readPlanUsage();
  return DEMO ? maskUsage(plan) : plan;
});

ipcMain.handle('usage:cli', async (e) => {
  const cacheFile = path.join(app.getPath('userData'), 'cli-usage-cache.json');
  try {
    const res = await cliusage.readCliUsage(cacheFile, (done, total) =>
      e.sender.send('usage:cliProgress', { done, total })
    );
    return DEMO ? maskCli(res) : res;
  } catch (err) {
    return { ok: false, code: 'unknown', detail: err.message };
  }
});

ipcMain.handle('profile:switch', (_e, { slot, autoClose }) => doSwitch(slot, autoClose));

ipcMain.handle('profile:add', (_e, name) => {
  const res = profiles.addProfile(name);
  if (res.ok) {
    broadcast('profiles:changed');
    buildTray();
  }
  return res;
});

ipcMain.handle('profile:adopt', (_e, name) => {
  const res = profiles.adoptCurrent(name);
  if (res.ok) {
    broadcast('profiles:changed');
    buildTray();
  }
  return res;
});

ipcMain.handle('profile:delete', (_e, slot) => {
  const res = profiles.deleteProfile(slot);
  if (res.ok) {
    broadcast('profiles:changed');
    buildTray();
  }
  return res;
});

ipcMain.handle('profile:meta', (_e, { slot, patch }) => {
  const res = profiles.setProfileMeta(slot, patch);
  broadcast('profiles:changed');
  buildTray();
  return res;
});

ipcMain.handle('claude:launch', () => claudeApp.launch(config.get('claudeApp')));
ipcMain.handle('claude:close', async () => {
  const res = await claudeApp.close();
  await pollOnce();
  return res;
});
ipcMain.handle('claude:state', () => claudeApp.isRunning());
ipcMain.handle('claude:detect', () => ({
  found: claudeApp.detectAll(),
  cli: claudeApp.detectCli(),
  active: claudeApp.resolve(config.get('claudeApp')),
  override: config.get('claudeApp'),
}));

ipcMain.handle('claude:chooseExe', async () => {
  const res = await dialog.showOpenDialog(settingsWin || mainWin, {
    title: t('set.chooseExe'),
    properties: ['openFile'],
    filters: [{ name: 'claude.exe', extensions: ['exe'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  config.set({ claudeApp: { kind: 'exe', path: res.filePaths[0] } });
  return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('shell:open', (_e, target) => {
  const allowed = {
    profilesDir: P.PROFILES_DIR,
    claudeAppData: P.CLAUDE_APPDATA,
    claudeDir: P.CLAUDE_DIR,
    projectsDir: P.PROJECTS_DIR,
    settingsFile: app.getPath('userData'),
  };
  const dir = allowed[target] || (target && target.startsWith(P.PROFILES_DIR) ? target : null);
  if (!dir) return { ok: false };
  shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('shell:external', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('settings:open', () => {
  openSettings();
  return { ok: true };
});

ipcMain.on('win:minimize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.minimize();
});

ipcMain.on('win:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on('win:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});

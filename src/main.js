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
  safeStorage,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

const P = require('./core/paths');
const config = require('./core/config');
const profiles = require('./core/profiles');
const claudeApp = require('./core/claudeApp');
const usage = require('./core/usage');
const cliusage = require('./core/cliusage');
const apiUsage = require('./core/apiUsage');
const trayIcon = require('./core/trayIcon');
const versions = require('./core/versions');
const platformInfo = require('./core/platform');
const statusline = require('./core/statusline');
const pace = require('./core/pace');
const i18n = require('./i18n');

const ASSETS = path.join(__dirname, '..', 'assets');

// A drop of at least this many percent counts as a limit window reset.
const RESET_MIN_DROP = 25;

// A Claude Code session left running across a profile switch can keep using the
// previous account's credentials while reporting under the new profile, so
// figures recorded around a switch are ignored rather than mis-attributed.
const BRIDGE_SETTLE_MS = 45 * 1000;

let mainWin = null;
let settingsWin = null;
let consentWin = null;
let popupWin = null;
let tray = null;
let pollTimer = null;
let usageWatcher = null;
let bridgeWatcher = null;
let lastRunning = null;
let isQuitting = false;
let lang = 'en';
let switching = false;

// Exact rate limits captured by the status line script, keyed by organization.
let bridgeOrgs = Object.create(null);

// org -> { fh: {value, notifiedFor}, sd: {...} } — keeps notifications to one per window
const limitState = Object.create(null);

// org -> { at, result } — cached live-usage responses, so multi-account polling
// stays gentle rather than hitting the endpoint on every UI refresh.
const apiCache = new Map();
const API_MIN_INTERVAL_MS = 3 * 60 * 1000;

const t = (key, params) => i18n.translate(lang, key, params);

/** Reads plan usage with the stored weekly anchors applied, and decorates it. */
function readUsage() {
  return decorate(usage.readPlanUsage({ anchors: config.get('weeklyAnchors') || {} }));
}

/* ----------------------------------------------------- exact figures, bridge */

/** True when two moments are the same point of the weekly cycle. */
function sameWeeklyMoment(a, b) {
  const d = Math.abs(a - b) % pace.SEVEN_DAYS;
  return Math.min(d, pace.SEVEN_DAYS - d) < 60 * 1000;
}

/**
 * Reloads the figures the status line script recorded from Claude Code.
 *
 * These are the exact percentages and real reset moments Anthropic hands to
 * Claude Code, arriving here through a local file and no network of our own. A
 * weekly reset seen this way is kept as an anchor: it is the same moment every
 * week, so one observation makes every later estimate exact.
 */
function reloadBridge() {
  const cutoff = Number(config.get('lastSwitchAt')) || 0;
  const orgs = Object.create(null);
  for (const [org, e] of Object.entries(statusline.readBridge().orgs)) {
    if (!e || typeof e.at !== 'number') continue;
    if (e.at < cutoff + BRIDGE_SETTLE_MS) continue;
    orgs[org] = e;
  }
  bridgeOrgs = orgs;

  const anchors = config.get('weeklyAnchors') || {};
  for (const [org, e] of Object.entries(orgs)) {
    const at = e.sd && e.sd.resetAt;
    if (at && !(anchors[org] && sameWeeklyMoment(anchors[org], at))) config.setWeeklyAnchor(org, at);
  }
}

/**
 * The best figures known for one organization.
 *
 * The bridge and the optional API both give an exact percentage and a real
 * reset time. The sample file gives neither, but is sometimes the most recent
 * thing available — so its value wins when it is newer, while the exact reset
 * time is kept either way. `stale` says the value came from the sample file.
 */
function exactFor(org, u) {
  const sources = [];
  const b = bridgeOrgs[org];
  if (b && b.at) sources.push({ at: b.at, source: 'code', fh: b.fh, sd: b.sd });

  const cached = apiCache.get(org);
  if (cached && cached.result && cached.result.ok) {
    sources.push({
      at: cached.result.fetchedAt || cached.at,
      source: 'api',
      fh: cached.result.fiveHour,
      sd: cached.result.weekly,
    });
  }
  if (!sources.length) return null;

  sources.sort((x, y) => y.at - x.at);
  const best = sources[0];
  const sampleIsNewer = u.last > best.at;
  const now = Date.now();

  const pick = (w, sampleValue) => {
    if (!w || !Number.isFinite(w.value)) return null;
    // A reset time already in the past describes a window that has since rolled
    // over, so the whole entry is out of date.
    if (w.resetAt && w.resetAt <= now) return null;
    return {
      value: Math.round(sampleIsNewer ? sampleValue : w.value),
      resetAt: w.resetAt || null,
      source: best.source,
      at: best.at,
      stale: sampleIsNewer,
    };
  };

  const fh = pick(best.fh, u.latest.fh);
  const sd = pick(best.sd, u.latest.sd);
  if (!fh && !sd) return null;
  return { fh, sd, source: best.source, at: best.at };
}

/** Pace for both windows, from the best window bounds available. */
function paceFor(u, exact) {
  const compute = (value, endMs, span, isExact) => {
    const bounds = pace.boundsFromEnd(endMs, span);
    if (!bounds) return null;
    const p = pace.pace({ value, startMs: bounds.startMs, endMs: bounds.endMs });
    return p ? Object.assign(p, { exact: isExact, endMs }) : null;
  };

  const fhExact = !!(exact && exact.fh && exact.fh.resetAt);
  const sdExact = !!(exact && exact.sd && exact.sd.resetAt);

  return {
    fh: compute(
      exact && exact.fh ? exact.fh.value : u.latest.fh,
      fhExact ? exact.fh.resetAt : u.fiveHour.resetBefore,
      pace.FIVE_HOURS,
      fhExact
    ),
    sd: compute(
      exact && exact.sd ? exact.sd.value : u.latest.sd,
      sdExact ? exact.sd.resetAt : u.weekly.resetAt,
      pace.SEVEN_DAYS,
      sdExact || !!(u.weekly && u.weekly.exact)
    ),
  };
}

/** Adds the exact-source and pace fields the interface draws. */
function decorate(plan) {
  if (!plan || !plan.ok) return plan;
  const orgs = {};
  for (const [org, u] of Object.entries(plan.orgs)) {
    const exact = exactFor(org, u);
    orgs[org] = Object.assign({}, u, { exact, pace: paceFor(u, exact) });
  }
  return Object.assign({}, plan, { orgs });
}

/** The percentage to act on: exact when known, otherwise the last sample. */
function currentValue(u, key) {
  if (!u) return null;
  if (u.exact && u.exact[key]) return u.exact[key].value;
  return u.latest[key];
}

/**
 * Persists a weekly reset the moment it is first observed, so the exact time is
 * known from then on even if the sample history is later trimmed. Free and local.
 */
function learnAnchors(plan) {
  if (!plan || !plan.ok) return;
  const anchors = config.get('weeklyAnchors') || {};
  for (const [org, u] of Object.entries(plan.orgs)) {
    if (u.weekly.observedReset && !anchors[org]) config.setWeeklyAnchor(org, u.weekly.observedReset);
  }
}

/* --------------------------------------------------------- manual API tokens */

function encryptToken(plain) {
  try {
    if (safeStorage.isEncryptionAvailable()) return 'v1:' + safeStorage.encryptString(plain).toString('base64');
  } catch {
    /* fall through to plaintext-with-marker below */
  }
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64');
}

function decryptToken(stored) {
  if (!stored) return null;
  try {
    if (stored.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(stored.slice(3), 'base64'));
    if (stored.startsWith('raw:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  } catch {
    return null;
  }
  return null;
}

function manualTokenFor(slot) {
  const tokens = config.get('apiTokens') || {};
  return tokens[slot] ? decryptToken(tokens[slot]) : null;
}

function storeManualToken(slot, plainOrNull) {
  const tokens = Object.assign({}, config.get('apiTokens') || {});
  if (plainOrNull) tokens[slot] = encryptToken(plainOrNull.trim());
  else delete tokens[slot];
  config.set({ apiTokens: tokens });
  apiCache.clear();
}

/**
 * Live usage for one profile, honouring the min-interval cache. Returns null
 * when API mode does not cover this profile.
 */
async function apiUsageFor(profile, force) {
  const mode = config.get('apiMode');
  if (mode === 'off') return null;
  if (mode === 'active' && !profile.isActive) return null;

  const org = profile.account && profile.account.organizationUuid;
  if (!org) return null;

  const cached = apiCache.get(org);
  if (!force && cached && Date.now() - cached.at < API_MIN_INTERVAL_MS) return cached.result;

  const result = await apiUsage.usageForProfile({
    slot: profile.slot,
    isActive: profile.isActive,
    manualToken: manualTokenFor(profile.slot),
  });
  if (result.ok) result.fetchedAt = Date.now();
  apiCache.set(org, { at: Date.now(), result });
  return result;
}

/* -------------------------------------------------------------- status line */

/** Unicode by default; the ASCII set exists for terminals with a legacy font. */
function statuslineGlyphs() {
  return config.get('statuslineAscii')
    ? { sep: ' | ', full: '#', empty: '.', mark: '|', branch: '' }
    : { sep: ' │ ', full: '█', empty: '░', mark: '┃', branch: '⎇' };
}

/** Whether the interface language formats time on a 12-hour clock. */
function prefers24h() {
  try {
    const locale = i18n.dict(lang).locale;
    return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 !== true;
  } catch {
    return true;
  }
}

/**
 * Publishes everything the status line script needs: the display choices, the
 * translated labels, and this app's own figures as a fallback for accounts
 * where Claude Code does not report rate limits.
 */
function pushStatuslineState({ force = false } = {}) {
  if (!force && !config.get('statuslineEnabled')) return;

  let list = [];
  try {
    list = profiles.listProfiles({ withSize: false });
  } catch {
    // Storage may not exist yet; the status line then simply has no profile.
  }
  const active = list.find((p) => p.isActive) || null;
  const org = active && active.account ? active.account.organizationUuid : null;

  const plan = readUsage();
  const u = org && plan.ok ? plan.orgs[org] : null;

  statusline.writeState({
    version: 1,
    updatedAt: Date.now(),
    profile: active ? { slot: active.slot, label: active.label || active.slot, org } : null,
    segments: config.get('statuslineSegments') || [],
    labels: !!config.get('statuslineLabels'),
    labelsText: {
      ctx: t('sl.label.ctx'),
      usage: t('sl.label.usage'),
      week: t('sl.label.week'),
      reset: t('sl.label.reset'),
      cost: t('sl.label.cost'),
    },
    pace: !!config.get('statuslinePace'),
    color: config.get('statuslineColor') || 'multi',
    bridge: !!config.get('statuslineBridge'),
    time24: prefers24h(),
    glyphs: statuslineGlyphs(),
    fallback: u
      ? {
          fh: currentValue(u, 'fh'),
          sd: currentValue(u, 'sd'),
          fhResetAt: (u.exact && u.exact.fh && u.exact.fh.resetAt) || u.fiveHour.resetBefore || null,
          sdResetAt: (u.exact && u.exact.sd && u.exact.sd.resetAt) || u.weekly.resetAt || null,
        }
      : null,
  });
}

function startBridgeWatch() {
  if (bridgeWatcher) return;
  try {
    fs.mkdirSync(statusline.DIR, { recursive: true });
    bridgeWatcher = fs.watch(statusline.DIR, (_event, filename) => {
      if (!filename || !String(filename).startsWith('bridge.json')) return;
      clearTimeout(startBridgeWatch._t);
      startBridgeWatch._t = setTimeout(() => {
        reloadBridge();
        broadcast('usage:changed');
        buildTray();
      }, 400);
    });
  } catch {
    // Without the watcher the figures still arrive, just on the next refresh.
  }
}

function stopBridgeWatch() {
  if (!bridgeWatcher) return;
  bridgeWatcher.close();
  bridgeWatcher = null;
}

/** Brings ~/.claude/settings.json in line with the setting. */
function applyStatusline() {
  if (config.get('statuslineEnabled')) {
    const res = statusline.install({ refreshSec: config.get('statuslineRefreshSec') });
    if (res.ok) {
      // Remember a status line that was already configured, so switching this
      // off puts the user's own one back rather than leaving them without.
      if (res.previous && !config.get('statuslinePrev')) config.set({ statuslinePrev: res.previous });
      pushStatuslineState();
      reloadBridge();
      startBridgeWatch();
    }
    broadcast('statusline:changed', Object.assign({ enabled: true }, res));
    return res;
  }

  const res = statusline.uninstall(config.get('statuslinePrev'));
  if (res.ok && config.get('statuslinePrev')) config.set({ statuslinePrev: null });
  stopBridgeWatch();
  broadcast('statusline:changed', Object.assign({ enabled: false }, res));
  return res;
}

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
  for (const w of [mainWin, settingsWin, consentWin, popupWin]) send(w, channel, payload);
}

function dictPayload() {
  const d = i18n.dict(lang);
  return { lang, locale: d.locale, dict: d };
}

function themePayload() {
  return { source: config.get('theme'), dark: nativeTheme.shouldUseDarkColors };
}

function applyLanguage() {
  // Documentation images are shot in English, whatever the machine's language,
  // so the screenshots in the README match the text around them.
  lang = DEMO ? 'en' : i18n.resolveLang(config.get('language'), app.getLocale());
  broadcast('i18n:changed', dictPayload());
  buildTray();
}

function applyTheme() {
  const source = config.get('theme');
  nativeTheme.themeSource = ['dark', 'light'].includes(source) ? source : 'system';
  const bg = nativeTheme.shouldUseDarkColors ? '#1b1a19' : '#faf9f5';
  for (const w of [mainWin, settingsWin, consentWin, popupWin]) {
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

/* ------------------------------------------------------------- tray popup */

const POPUP_W = 340;
const POPUP_H = 560;

function createPopup() {
  popupWin = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a19' : '#faf9f5',
    webPreferences: webPreferences(),
  });

  popupWin.loadFile(path.join(__dirname, 'renderer', 'popup.html'));
  popupWin.setMenu(null);

  // Behaves like a tray flyout: clicking anywhere else dismisses it.
  popupWin.on('blur', () => {
    if (popupWin && !popupWin.isDestroyed() && popupWin.isVisible()) popupWin.hide();
  });
  popupWin.on('closed', () => {
    popupWin = null;
  });
  popupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Places the flyout next to the tray icon, clamped to the working area. */
function positionPopup() {
  if (!popupWin || !tray) return;
  let bounds;
  try {
    bounds = tray.getBounds();
  } catch {
    return;
  }
  const display = screen.getDisplayMatching(bounds.width ? bounds : { x: bounds.x, y: bounds.y, width: 1, height: 1 });
  const area = display.workArea;
  const [w, h] = popupWin.getSize();

  let x = Math.round(bounds.x + bounds.width / 2 - w / 2);
  // Taskbar at the bottom is the common case; flip above when there is no room below.
  let y = bounds.y > area.y + area.height / 2 ? bounds.y - h - 8 : bounds.y + bounds.height + 8;

  x = Math.max(area.x + 6, Math.min(x, area.x + area.width - w - 6));
  y = Math.max(area.y + 6, Math.min(y, area.y + area.height - h - 6));
  popupWin.setPosition(x, y, false);
}

function togglePopup() {
  if (!popupWin) createPopup();
  if (popupWin.isVisible()) {
    popupWin.hide();
    return;
  }
  send(popupWin, 'popup:refresh');
  positionPopup();
  popupWin.show();
  popupWin.focus();
}

/* -------------------------------------------------------------------- tray */

function activeUsage(list) {
  const active = list.find((p) => p.isActive);
  if (!active || !active.account) return { active, u: null };
  const plan = readUsage();
  const u = plan.ok ? plan.orgs[active.account.organizationUuid] : null;
  return { active, u: u || null };
}

/**
 * Repaints the tray icon for the current usage. The static mark is loaded from
 * disk; the data-driven styles are drawn at 16 and 32 px so Windows has a crisp
 * bitmap at both common DPI settings.
 */
function updateTrayIcon(pct) {
  if (!tray) return;
  const style = config.get('trayStyle');

  if (style === 'icon' || pct == null) {
    tray.setImage(nativeImage.createFromPath(path.join(ASSETS, 'tray.ico')));
    return;
  }

  try {
    const mono = !!config.get('trayMono');
    const img = nativeImage.createFromBuffer(trayIcon.render({ style, pct, size: 16, mono }), { scaleFactor: 1 });
    img.addRepresentation({
      scaleFactor: 2,
      buffer: trayIcon.render({ style, pct, size: 32, mono }),
    });
    tray.setImage(img);
  } catch {
    tray.setImage(nativeImage.createFromPath(path.join(ASSETS, 'tray.ico')));
  }
}

function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.ico')));
    // Left click opens the flyout; the full menu stays on right click.
    tray.on('click', () => togglePopup());
    tray.on('double-click', () => showMain());
  }

  let list = [];
  try {
    list = profiles.listProfiles({ withSize: false });
  } catch {
    // Storage may not exist yet.
  }

  const { active, u } = activeUsage(list);
  const running = lastRunning && lastRunning.running;

  const fhNow = currentValue(u, 'fh');
  const sdNow = currentValue(u, 'sd');

  const header = [
    { label: active ? `${active.label || active.slot}${active.account ? ` — ${active.account.email}` : ''}` : t('tray.noProfile'), enabled: false },
  ];
  if (u) header.push({ label: t('tray.usageLine', { fh: fhNow, sd: sdNow }), enabled: false });

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
    u ? t('tray.tooltipProfile', { slot: active.label || active.slot, fh: fhNow, sd: sdNow }) : t('tray.tooltipIdle')
  );
  tray.setContextMenu(menu);
  updateTrayIcon(u ? (config.get('trayMetric') === 'sd' ? sdNow : fhNow) : null);
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

  if (res.ok && !res.unchanged) {
    // The status line now belongs to a different account: re-publish its state
    // and mark the moment, so figures recorded around it are not mis-attributed.
    config.set({ lastSwitchAt: Date.now() });
    reloadBridge();
    pushStatuslineState();
  }

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

  // All configured thresholds, highest first: crossing 95 should announce 95,
  // not the 75 it also passed.
  const thresholds = [Number(config.get('notifyThreshold')) || 90]
    .concat((config.get('notifyThresholdsExtra') || []).map(Number))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => b - a);
  const wantReset = !!config.get('notifyOnReset');

  let list = [];
  try {
    list = profiles.listProfiles({ withSize: false });
  } catch {
    return;
  }

  const plan = readUsage();
  if (!plan.ok) return;
  learnAnchors(plan);

  for (const p of list) {
    const org = p.account && p.account.organizationUuid;
    const u = org && plan.orgs[org];
    if (!u) continue;

    const name = p.label || p.slot;
    if (!limitState[org]) limitState[org] = {};

    for (const key of ['fh', 'sd']) {
      const value = currentValue(u, key);
      // Identifies the current limit window, so one notification is sent per
      // window. An exact reset time is the sharper identifier when there is one.
      const exact = u.exact && u.exact[key] && u.exact[key].resetAt;
      const window = exact || (key === 'fh' ? u.fiveHour.openedBy : u.weekly.resetAt);
      const prev = limitState[org][key];

      if (wantReset && prev && prev.value - value >= RESET_MIN_DROP) {
        notify(
          t('notif.resetTitle'),
          t('notif.resetBody', { slot: name, window: t(`notif.window.${key}`), was: prev.value, now: value })
        );
      }

      // Announce the highest threshold reached, once per threshold per window.
      const reached = thresholds.find((th) => value >= th) || null;
      const seen = prev && prev.window === window ? prev.seen || [] : [];
      let notifiedSeen = seen;

      // A stale sample file says nothing about now — unless an exact figure
      // arrived through the status line bridge or the API, which is current.
      const stale = u.stale && !exact;

      if (!stale && reached != null && window && !seen.includes(reached)) {
        notify(
          t('notif.limitTitle', { pct: reached }),
          t('notif.limitBody', { slot: name, window: t(`notif.window.${key}`), pct: value })
        );
        notifiedSeen = seen.concat(reached);
      }

      limitState[org][key] = { value, window, seen: notifiedSeen };
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
        pushStatuslineState(); // keep the terminal's fallback figures current
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

  // The status line tab, once its preview has actually run the script.
  await settingsWin.webContents.executeJavaScript("document.querySelector('.tab[data-tab=statusline]').click()");
  await wait(3500);
  const slimg = await settingsWin.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'screenshot-statusline.png'), slimg.toPNG());

  if (popupWin && !popupWin.isDestroyed()) {
    send(popupWin, 'popup:refresh');
    positionPopup();
    popupWin.show();
    await wait(1500);
    const pimg = await popupWin.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'screenshot-tray.png'), pimg.toPNG());
  }

  isQuitting = true;
  app.quit();
}

/* -------------------------------------------------------------------- start */

app.whenReady().then(() => {
  config.init(app.getPath('userData'));
  statusline.init(app.getPath('userData'));
  applyLanguage();
  applyTheme();

  // An unknown platform cannot even locate Claude's data, so there is nothing
  // to show. A known-but-unverified one runs read-only; profiles.js blocks the
  // file moves and the UI explains why.
  if (!platformInfo.supported) {
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
    if (changed.some((k) => k === 'trayStyle' || k === 'trayMetric' || k === 'trayMono')) buildTray();
    if (changed.includes('apiMode')) apiCache.clear();

    // The status line: switching it on or changing the refresh timer rewrites
    // ~/.claude/settings.json; everything else only rewrites our own state file.
    if (changed.includes('statuslineEnabled') || changed.includes('statuslineRefreshSec')) applyStatusline();
    else if (changed.some((k) => k.startsWith('statusline')) || changed.includes('language')) pushStatuslineState();

    broadcast('config:changed', config.all());
  });

  app.on('activate', () => showMain());
});

function startApp() {
  reloadBridge();
  createMainWindow();
  buildTray();
  createPopup(); // built hidden up front so the flyout opens instantly
  startPolling();
  startUsageWatch();
  checkLimits();

  // Keeps the installed script and its state in step with the app: an update
  // may ship a newer script, and the labels follow the interface language.
  if (config.get('statuslineEnabled')) applyStatusline();

  if (process.argv.includes('--settings')) openSettings();
  if (process.argv.includes('--screenshot')) runScreenshots();

  // One-time question: offer live usage via the API. Shown once, after the main
  // window is ready, and never again regardless of the answer.
  if (!config.get('apiPrompted') && config.get('apiMode') === 'off' && mainWin && !process.argv.includes('--screenshot')) {
    mainWin.webContents.once('did-finish-load', () => setTimeout(() => send(mainWin, 'ui:apiPrompt'), 1200));
  }
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
  stopBridgeWatch();
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
    platform: {
      id: platformInfo.current ? platformInfo.current.id : process.platform,
      label: platformInfo.current ? platformInfo.current.label : process.platform,
      canSwitch: platformInfo.canSwitch,
    },
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
      statuslineDir: statusline.DIR,
      claudeSettings: statusline.SETTINGS_FILE,
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
  const plan = readUsage();
  learnAnchors(plan);
  return DEMO ? maskUsage(plan) : plan;
});

// Live usage for the in-scope profiles, keyed by organization uuid.
ipcMain.handle('usage:api', async (_e, { force } = {}) => {
  const mode = config.get('apiMode');
  if (mode === 'off') return { mode, results: {} };

  const list = profiles.listProfiles({ withSize: false });
  const results = {};
  for (const p of list) {
    if (!p.account) continue;
    if (mode === 'active' && !p.isActive) continue;
    const res = await apiUsageFor(p, force);
    if (res) results[p.account.organizationUuid] = res;
  }
  return { mode, results };
});

ipcMain.handle('api:tokenState', (_e, slot) => {
  const list = profiles.listProfiles({ withSize: false });
  const p = list.find((x) => x.slot === slot);
  const isActive = !!(p && p.isActive);
  const tok = apiUsage.tokenForProfile(slot, isActive);
  return {
    hasManual: !!manualTokenFor(slot),
    hasCode: !!tok,
    codeExpired: tok ? tok.expired : false,
  };
});

ipcMain.handle('api:setToken', (_e, { slot, token }) => {
  storeManualToken(slot, token || null);
  broadcast('config:changed', config.all());
  return { ok: true };
});

/* -------------------------------------------------------- status line IPC */

ipcMain.handle('statusline:status', () => {
  const st = statusline.status();
  const orgs = Object.entries(bridgeOrgs).map(([org, e]) => ({ org, at: e.at, cc: e.cc || null }));
  return Object.assign(st, {
    bridge: orgs,
    paths: DEMO ? maskPaths({ scriptPath: st.scriptPath, settingsPath: st.settingsPath }) : null,
  });
});

/**
 * Runs the script exactly as Claude Code would and returns the line. Previewing
 * writes the script and its state, but never touches ~/.claude/settings.json —
 * so the terminal is only changed once the setting is actually turned on.
 */
ipcMain.handle('statusline:preview', async () => {
  const sync = statusline.syncScript();
  if (!sync.ok) return sync;
  pushStatuslineState({ force: true });

  let list = [];
  try {
    list = profiles.listProfiles({ withSize: false });
  } catch {
    /* no storage yet */
  }
  const active = list.find((p) => p.isActive);
  const org = active && active.account ? active.account.organizationUuid : null;
  const e = org ? bridgeOrgs[org] : null;

  const extra = {};
  if (e && (e.fh || e.sd)) {
    const win = (w) => (w ? { used_percentage: w.value, resets_at: w.resetAt ? Math.round(w.resetAt / 1000) : null } : undefined);
    extra.rate_limits = { five_hour: win(e.fh), seven_day: win(e.sd) };
  }
  // The home directory carries the Windows user name, which must not appear in
  // documentation images; a plain project path shows the same thing.
  if (DEMO) {
    const dir = 'C:/Users/alex/projects/web-app';
    Object.assign(extra, { cwd: dir, workspace: { current_dir: dir, project_dir: dir } });
  }
  return statusline.preview(statusline.sampleInput(extra));
});

/** Rewrites the script and the settings entry, for when either drifted. */
ipcMain.handle('statusline:reinstall', () => applyStatusline());

/** Compact payload for the tray flyout: one call, everything it draws. */
ipcMain.handle('popup:data', async () => {
  const list = profiles.listProfiles({ withSize: false });
  const plan = readUsage();
  learnAnchors(plan);

  const claude = lastRunning || (await claudeApp.isRunning());
  const masked = DEMO ? maskUsage(plan) : plan;

  return {
    claude,
    profiles: (DEMO ? maskProfiles(list) : list).map((p) => ({
      slot: p.slot,
      label: p.label,
      isActive: p.isActive,
      email: p.account ? p.account.email : null,
      plan: p.account ? p.account.plan : null,
      org: p.account ? p.account.organizationUuid : null,
    })),
    orgs: masked.ok ? masked.orgs : {},
    api: Object.fromEntries([...apiCache.entries()].map(([k, v]) => [k, v.result])),
    apiMode: config.get('apiMode'),
    versions: versions.detect(),
  };
});

ipcMain.handle('popup:switch', async (_e, slot) => {
  const state = await claudeApp.isRunning();
  if (popupWin && popupWin.isVisible()) popupWin.hide();
  if (state.running) {
    requestSwitchInWindow(slot);
    return { ok: false, code: 'CLAUDE_RUNNING', deferred: true };
  }
  return doSwitch(slot, false);
});

ipcMain.on('popup:hide', () => {
  if (popupWin && !popupWin.isDestroyed()) popupWin.hide();
});

ipcMain.handle('app:showMain', (_e, tab) => {
  showMain(tab);
  return { ok: true };
});

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
  return { ok: true };
});

/**
 * Opens a console running `claude`, so signing in writes the credentials file
 * this app then finds by itself. Far friendlier than hunting for a JSON field.
 */
ipcMain.handle('claude:openTerminal', () => claudeApp.openTerminal());

ipcMain.handle('api:calibrate', (_e, { orgUuid, epochMs }) => {
  config.setWeeklyAnchor(orgUuid, epochMs);
  broadcast('usage:changed');
  return { ok: true };
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
  pushStatuslineState(); // the display name is shown in the terminal too
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
    filters: [platformInfo.current ? platformInfo.current.exeFilter : { name: 'Claude', extensions: ['*'] }],
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
    statuslineDir: statusline.DIR,
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

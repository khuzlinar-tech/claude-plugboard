'use strict';

const fs = require('fs');
const path = require('path');

// Bump when the consent text changes materially, so it is shown again.
// v2: added the optional live-usage feature, which can make network requests.
const CONSENT_VERSION = 2;

const DEFAULTS = {
  language: 'auto', // auto | en | ru | de | es | fr | pt | zh | ja
  theme: 'system', // system | dark | light
  autoStart: false,
  startMinimized: false,
  closeToTray: true,
  minimizeToTray: false,
  notifications: true,
  notifyThreshold: 90,
  notifyThresholdsExtra: [], // additional percentages, e.g. [75, 95]
  notifyOnReset: true,

  // Tray icon: what it draws and which window it tracks.
  trayStyle: 'icon', // icon | bar | percent | battery
  trayMetric: 'fh', // fh (5-hour) | sd (weekly)
  trayMono: false,
  launchAfterSwitch: true,
  pollIntervalSec: 4,
  switchScope: 'both', // both | desktop | code
  consentVersion: 0,

  // Exact weekly reset anchors, per organization uuid. A value is one epoch-ms
  // moment when the weekly window is known to reset; the rest is derived by
  // rolling forward whole weeks. Learned automatically from an observed reset,
  // or entered by hand. Nothing here leaves the machine.
  weeklyAnchors: {},

  // Live usage via Anthropic's OAuth usage endpoint. Off unless the user opts in.
  //   apiMode: 'off' | 'active' | 'all'
  //   apiPrompted: whether the one-time startup question has been shown
  //   apiTokens: manually entered tokens, encrypted at rest, keyed by slot
  apiMode: 'off',
  apiPrompted: false,
  apiTokens: {},

  // Claude Code status line. The app writes a script and a `statusLine` entry
  // into ~/.claude/settings.json; Claude Code then shows usage in the terminal.
  // Entirely local — the script reads the JSON Claude Code hands it and the
  // figures this app already has.
  //   statuslineSegments: which parts are shown, in this order
  //   statuslineColor:    multi | mono | none
  //   statuslineBridge:   let the script report exact rate limits back
  //   statuslinePrev:     a foreign statusLine we replaced, restored on removal
  statuslineEnabled: false,
  statuslineSegments: ['dir', 'git', 'model', 'profile', 'usage', 'bar', 'reset'],
  statuslineColor: 'multi',
  statuslineLabels: true,
  statuslineAscii: false,
  statuslinePace: true,
  statuslineRefreshSec: 30,
  statuslineBridge: true,
  statuslinePrev: null,

  // When the active profile last changed. Rate limits captured by the status
  // line before that moment belonged to the previous account.
  lastSwitchAt: 0,

  // Manual override for the Claude install: { kind: 'store', appId } | { kind: 'exe', path }
  claudeApp: null,
  windowBounds: null,
};

let file = null;
let data = Object.assign({}, DEFAULTS);
const listeners = new Set();

function init(userDataDir) {
  file = path.join(userDataDir, 'settings.json');
  let existed = true;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = Object.assign({}, DEFAULTS, raw);
  } catch {
    data = Object.assign({}, DEFAULTS);
    existed = false;
  }
  if (!existed) save(); // create the file so it can be found and hand-edited
  return data;
}

function all() {
  return Object.assign({}, data);
}

function get(key) {
  return data[key];
}

function save() {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Settings are convenience only; failing to persist must not break the app.
  }
}

function set(patch) {
  const before = Object.assign({}, data);
  data = Object.assign({}, data, patch);
  save();
  const changed = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(data[k]));
  if (changed.length) for (const fn of listeners) fn(all(), changed);
  return all();
}

function reset() {
  // Window geometry, accepted consent and learned reset anchors survive a reset.
  // Tokens and the API opt-in are cleared — resetting settings should not silently
  // keep a live-usage connection running. A status line configuration that this
  // app replaced is kept so that removing ours can still put the original back.
  return set(Object.assign({}, DEFAULTS, {
    windowBounds: data.windowBounds,
    consentVersion: data.consentVersion,
    weeklyAnchors: data.weeklyAnchors,
    statuslinePrev: data.statuslinePrev,
  }));
}

/** Records a known weekly-reset moment for an org, used to compute exact resets. */
function setWeeklyAnchor(orgUuid, epochMs) {
  if (!orgUuid || !epochMs) return;
  const anchors = Object.assign({}, data.weeklyAnchors);
  anchors[orgUuid] = epochMs;
  set({ weeklyAnchors: anchors });
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { DEFAULTS, CONSENT_VERSION, init, all, get, set, reset, setWeeklyAnchor, onChange };

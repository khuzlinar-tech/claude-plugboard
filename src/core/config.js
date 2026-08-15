'use strict';

const fs = require('fs');
const path = require('path');

// Bump when the consent text changes materially, so it is shown again.
const CONSENT_VERSION = 1;

const DEFAULTS = {
  language: 'auto', // auto | en | ru | de | es | fr | pt | zh | ja
  theme: 'system', // system | dark | light
  autoStart: false,
  startMinimized: false,
  closeToTray: true,
  minimizeToTray: false,
  notifications: true,
  notifyThreshold: 90,
  notifyOnReset: true,
  launchAfterSwitch: true,
  pollIntervalSec: 4,
  switchScope: 'both', // both | desktop | code
  consentVersion: 0,
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
  // Window geometry and the accepted consent survive a settings reset.
  return set(Object.assign({}, DEFAULTS, {
    windowBounds: data.windowBounds,
    consentVersion: data.consentVersion,
  }));
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { DEFAULTS, CONSENT_VERSION, init, all, get, set, reset, onChange };

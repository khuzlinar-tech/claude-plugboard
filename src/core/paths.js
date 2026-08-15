'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const P = {
  HOME,
  APPDATA,
  CLAUDE_APPDATA: path.join(APPDATA, 'Claude'),
  CLAUDE_DIR: path.join(HOME, '.claude'),
  CLAUDE_JSON: path.join(HOME, '.claude.json'),
  PROFILES_DIR: path.join(HOME, '.claude-profiles'),
};

P.STATE_FILE = path.join(P.PROFILES_DIR, 'current.txt');
P.META_FILE = path.join(P.PROFILES_DIR, 'profiles.json');
P.TRASH_DIR = path.join(P.PROFILES_DIR, '_trash');
P.USAGE_HISTORY = path.join(P.CLAUDE_APPDATA, 'plan-usage-history.json');
P.PROJECTS_DIR = path.join(P.CLAUDE_DIR, 'projects');

// Account-bound files, grouped by the Claude surface they belong to.
// The set matches the original claude-switch.ps1 so that external shortcuts
// built around the same storage layout keep working.
P.DESKTOP_ITEMS = ['Network', 'Local Storage', 'Session Storage', 'IndexedDB', 'Local State', 'config.json'];
P.HOME_ITEMS = ['.claude.json'];
P.CLAUDE_DIR_ITEMS = ['.credentials.json'];

// Kept for backwards compatible naming in the UI payload.
P.APP_ITEMS = P.DESKTOP_ITEMS;

// What a switch touches. "code" covers the CLI and the editor extensions,
// which all authenticate through ~/.claude.
P.SCOPES = ['both', 'desktop', 'code'];

// plan-usage-history.json is deliberately NOT switched: every sample carries an
// organization id, so one shared file holds the limit history of every account.

/**
 * Live path <-> storage path pairs for a slot.
 * @param {string} slot
 * @param {'both'|'desktop'|'code'} scope
 */
P.pairsFor = function pairsFor(slot, scope = 'both') {
  const store = path.join(P.PROFILES_DIR, slot);
  const pairs = [];

  if (scope !== 'code') {
    for (const item of P.DESKTOP_ITEMS) {
      pairs.push({ live: path.join(P.CLAUDE_APPDATA, item), store: path.join(store, `app_${item}`) });
    }
  }

  if (scope !== 'desktop') {
    for (const item of P.HOME_ITEMS) {
      pairs.push({ live: path.join(P.HOME, item), store: path.join(store, `home_${item}`) });
    }
    for (const item of P.CLAUDE_DIR_ITEMS) {
      pairs.push({ live: path.join(P.CLAUDE_DIR, item), store: path.join(store, `dir_${item}`) });
    }
  }

  return pairs;
};

module.exports = P;

'use strict';

/*
 * Claude Code status line integration.
 *
 * Claude Code renders a status line by running a command and printing its
 * stdout, handing it a JSON document with the session's model, workspace,
 * context window and — for Pro/Max accounts — the exact rate-limit windows.
 * Configuring one is a matter of a `statusLine` block in ~/.claude/settings.json.
 *
 * The script is PowerShell rather than Node so the integration does not depend
 * on a Node install being on PATH, and it is copied out of the app into the
 * user data directory because a packaged build lives inside an asar archive,
 * which PowerShell cannot execute from. The copy also means the status line
 * keeps working while the app is closed, and survives an app update.
 *
 * Not into profile storage: everything there is enumerated as a profile.
 *
 * The path in the command is written with forward slashes: on Windows Claude
 * Code runs status line commands through Git Bash when it is installed, and Git
 * Bash swallows unquoted backslashes.
 *
 * Everything here is local. No network, no tokens.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./paths');

const SCRIPT_NAME = 'claude-usage-statusline.ps1';
const SETTINGS_FILE = path.join(P.CLAUDE_DIR, 'settings.json');
const SOURCE_FILE = path.join(__dirname, '..', 'statusline', SCRIPT_NAME);

// Where our own files live. Electron hands over the real user data directory at
// startup; the default is the same place, so the module is usable on its own.
let DIR = path.join(process.env.APPDATA || P.HOME, 'Claude Profile Manager', 'statusline');
let SCRIPT = path.join(DIR, SCRIPT_NAME);
let STATE_FILE = path.join(DIR, 'state.json');
let BRIDGE_FILE = path.join(DIR, 'bridge.json');

function init(userDataDir) {
  DIR = path.join(userDataDir, 'statusline');
  SCRIPT = path.join(DIR, SCRIPT_NAME);
  STATE_FILE = path.join(DIR, 'state.json');
  BRIDGE_FILE = path.join(DIR, 'bridge.json');
  Object.assign(module.exports, { DIR, SCRIPT, STATE_FILE, BRIDGE_FILE });
}

// Bumped when the shipped script changes, so an installed copy is refreshed.
const SCRIPT_VERSION = 1;

const PREVIEW_TIMEOUT_MS = 8000;

/** The exact string written into settings.json. */
function commandFor() {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT.replace(/\\/g, '/')}"`;
}

/** True when a settings.json command points at our script, whatever the wrapper. */
function isOurs(command) {
  return typeof command === 'string' && command.toLowerCase().includes(SCRIPT_NAME.toLowerCase());
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** The `# script-version: N` marker of the installed copy, or 0 if absent. */
function installedScriptVersion() {
  try {
    const head = fs.readFileSync(SCRIPT, 'utf8').slice(0, 400);
    const m = head.match(/script-version:\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return -1; // not installed
  }
}

/**
 * Copies the shipped script into place whenever the installed copy differs.
 *
 * Compared by content rather than by the version marker: an app update then
 * takes effect without anybody having to remember to bump a number, and a copy
 * that was edited or truncated repairs itself. Read and write rather than
 * copyFile, because the source may live inside an asar archive.
 */
function syncScript() {
  let source;
  try {
    source = fs.readFileSync(SOURCE_FILE, 'utf8');
  } catch (err) {
    return { ok: false, code: 'SL_SCRIPT_WRITE', detail: err.message };
  }

  let installed = null;
  try {
    installed = fs.readFileSync(SCRIPT, 'utf8');
  } catch {
    // Not installed yet.
  }
  if (installed === source) return { ok: true, updated: false };

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(SCRIPT, source, 'utf8');
    return { ok: true, updated: true };
  } catch (err) {
    return { ok: false, code: 'SL_SCRIPT_WRITE', detail: err.message };
  }
}

/* ------------------------------------------------------- settings.json edit */

/**
 * Rewrites ~/.claude/settings.json with one key changed and everything else
 * left exactly as it was. A missing file is created; a broken one is refused
 * rather than overwritten, because it is the user's file and not ours.
 */
function patchSettings(mutate) {
  let data = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    const parsed = readJson(SETTINGS_FILE);
    if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'SL_SETTINGS_BROKEN' };
    data = parsed;
  }

  const before = JSON.stringify(data.statusLine || null);
  mutate(data);
  if (JSON.stringify(data.statusLine || null) === before) return { ok: true, unchanged: true };

  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'SL_SETTINGS_WRITE', detail: err.message };
  }
}

/** What is currently configured, ours or somebody else's. */
function status() {
  const settings = fs.existsSync(SETTINGS_FILE) ? readJson(SETTINGS_FILE) : {};
  const broken = fs.existsSync(SETTINGS_FILE) && !settings;
  const line = settings && settings.statusLine ? settings.statusLine : null;
  const ours = !!(line && isOurs(line.command));

  return {
    broken,
    installed: ours,
    foreign: line && !ours ? line : null,
    command: line ? line.command || null : null,
    refreshInterval: line ? line.refreshInterval || null : null,
    scriptVersion: installedScriptVersion(),
    expectedScriptVersion: SCRIPT_VERSION,
    scriptPath: SCRIPT,
    settingsPath: SETTINGS_FILE,
    statePath: STATE_FILE,
    bridgePath: BRIDGE_FILE,
  };
}

/**
 * Installs the status line.
 * @param {{refreshSec?: number}} opts
 * @returns {{ok:boolean, previous?:object|null, code?:string, detail?:string}}
 */
function install(opts = {}) {
  const script = syncScript();
  if (!script.ok) return script;

  const before = status();
  const previous = before.foreign;

  const res = patchSettings((data) => {
    const line = { type: 'command', command: commandFor(), padding: 0 };
    // Anything time-based needs a timer: the event-driven triggers go quiet
    // while a session sits idle, and a reset countdown would freeze with it.
    const sec = Number(opts.refreshSec);
    if (Number.isFinite(sec) && sec >= 1) line.refreshInterval = Math.round(sec);
    data.statusLine = line;
  });
  if (!res.ok) return res;

  return { ok: true, previous: previous || null, scriptUpdated: script.updated };
}

/**
 * Removes our status line. A configuration that was replaced on install is put
 * back, so enabling and disabling this leaves the user where they started.
 */
function uninstall(previous) {
  const current = status();
  if (!current.installed) return { ok: true, unchanged: true };

  return patchSettings((data) => {
    if (previous && typeof previous === 'object') data.statusLine = previous;
    else delete data.statusLine;
  });
}

/* -------------------------------------------------------------- app ↔ script */

/** Publishes display settings and the app's own figures for the script to read. */
function writeState(payload) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'SL_STATE_WRITE', detail: err.message };
  }
}

/**
 * Exact rate limits the script captured from Claude Code, keyed by organization.
 * This is the only source of a genuinely exact reset time that costs nothing and
 * touches no network — Claude Code is handed the figures by the API and passes
 * them straight to the status line.
 */
function readBridge() {
  const data = readJson(BRIDGE_FILE);
  if (!data || !data.orgs || typeof data.orgs !== 'object') return { orgs: {} };
  return { orgs: data.orgs };
}

function clearBridge() {
  try {
    fs.unlinkSync(BRIDGE_FILE);
  } catch {
    // Nothing to clear.
  }
}

/* ------------------------------------------------------------------ preview */

const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, '');

/** A representative stdin document, so the preview shows the real thing. */
function sampleInput(extra = {}) {
  return Object.assign(
    {
      cwd: P.HOME,
      session_id: 'preview',
      transcript_path: '',
      model: { id: 'claude-opus-5', display_name: 'Opus' },
      workspace: { current_dir: P.HOME, project_dir: P.HOME },
      version: '2.1.0',
      output_style: { name: 'default' },
      cost: { total_cost_usd: 0.42, total_duration_ms: 60000 },
      context_window: { total_input_tokens: 96000, context_window_size: 200000, used_percentage: 48 },
    },
    extra
  );
}

/**
 * Runs the installed script exactly as Claude Code would and returns what it
 * printed. Better than reimplementing the formatting in JavaScript: what the
 * preview shows is what the terminal will show, and it proves the script runs.
 */
function preview(input) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SCRIPT)) return resolve({ ok: false, code: 'SL_NOT_INSTALLED' });

    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ ok: false, code: 'SL_SPAWN', detail: err.message });
    }

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ok: false, code: 'SL_TIMEOUT' });
    }, PREVIEW_TIMEOUT_MS);

    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.stderr.on('data', (b) => (err += b.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'SL_SPAWN', detail: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).filter((l) => l.length);
      resolve({ ok: true, lines: lines.map(stripAnsi), raw: out, stderr: err.trim() || null });
    });

    try {
      child.stdin.end(JSON.stringify(input || sampleInput()), 'utf8');
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, code: 'SL_SPAWN', detail: e.message });
    }
  });
}

module.exports = {
  DIR,
  SCRIPT,
  STATE_FILE,
  BRIDGE_FILE,
  SETTINGS_FILE,
  SCRIPT_VERSION,
  init,
  commandFor,
  status,
  install,
  uninstall,
  syncScript,
  writeState,
  readBridge,
  clearBridge,
  sampleInput,
  preview,
  stripAnsi,
};

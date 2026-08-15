'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./paths');
const platform = require('./platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Installed copies of Claude Desktop, however this platform ships them. */
function detectAll() {
  if (!platform.current) return [];
  try {
    return platform.current.detect();
  } catch {
    return [];
  }
}

/** The install to use: the manual override, otherwise the first one found. */
function resolve(override) {
  if (override && override.kind === 'exe' && override.path && exists(override.path)) {
    return Object.assign({ label: path.basename(override.path), source: 'manual' }, override);
  }
  if (override && override.kind === 'app' && override.path && exists(override.path)) {
    return Object.assign({ label: path.basename(override.path), source: 'manual' }, override);
  }
  if (override && override.kind === 'store' && override.appId) {
    return Object.assign({ label: override.appId, source: 'manual' }, override);
  }
  return detectAll()[0] || null;
}

function launch(override) {
  if (!platform.current) return { ok: false, error: 'PLATFORM_UNSUPPORTED' };
  const target = resolve(override);
  if (!target) return { ok: false, error: 'CLAUDE_NOT_FOUND' };
  try {
    const child = platform.current.launch(target);
    if (child && child.unref) child.unref();
    return { ok: true, target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function isRunning() {
  return new Promise((done) => {
    if (!platform.current) return done({ running: false, count: 0 });
    try {
      platform.current.listProcesses((count) => done({ running: count > 0, count }));
    } catch {
      done({ running: false, count: 0 });
    }
  });
}

function kill(force) {
  return new Promise((done) => {
    if (!platform.current) return done();
    try {
      platform.current.kill(force, done);
    } catch {
      done();
    }
  });
}

/** Closes Claude: politely first, forcefully if it does not go away. */
async function close() {
  let state = await isRunning();
  if (!state.running) return { ok: true, alreadyClosed: true };

  await kill(false);
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    state = await isRunning();
    if (!state.running) return { ok: true, forced: false };
  }

  await kill(true);
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    state = await isRunning();
    if (!state.running) return { ok: true, forced: true };
  }
  return { ok: false, error: 'CLOSE_TIMEOUT' };
}

/** Detects a Claude Code CLI install, which authenticates through ~/.claude. */
function detectCli() {
  return {
    present: exists(P.CLAUDE_DIR),
    credentials: exists(path.join(P.CLAUDE_DIR, '.credentials.json')),
    config: exists(P.CLAUDE_JSON),
    dir: P.CLAUDE_DIR,
  };
}

/** Opens a console already running `claude`, so signing in writes the token file. */
function openTerminal() {
  if (!platform.current) return { ok: false, error: 'PLATFORM_UNSUPPORTED' };
  try {
    const child = platform.current.openTerminalWithClaude();
    if (child && child.unref) child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  detectAll,
  detectCli,
  resolve,
  launch,
  isRunning,
  close,
  openTerminal,
  get PROCESS_NAME() {
    return platform.current ? platform.current.processName : '';
  },
};

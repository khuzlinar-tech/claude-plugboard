'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const LOCALAPPDATA = process.env.LOCALAPPDATA || '';
const PROCESS_NAME = 'claude.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds installed copies of Claude Desktop.
 * The Store edition ships as an MSIX package, the regular one via a Squirrel installer.
 */
function detectAll() {
  const found = [];

  // 1. MSIX: %LOCALAPPDATA%\Packages\Claude_<publisherHash>
  try {
    const packages = path.join(LOCALAPPDATA, 'Packages');
    for (const name of fs.readdirSync(packages)) {
      if (!/^Claude_[a-z0-9]+$/i.test(name)) continue;
      found.push({
        kind: 'store',
        appId: `${name}!Claude`,
        label: `Microsoft Store (${name})`,
        source: 'auto',
      });
    }
  } catch {
    // The Packages directory may not exist on this machine.
  }

  // 2. Squirrel stub, which resolves the current version itself.
  const squirrel = path.join(LOCALAPPDATA, 'AnthropicClaude', 'claude.exe');
  if (exists(squirrel)) {
    found.push({ kind: 'exe', path: squirrel, label: 'AnthropicClaude (installer)', source: 'auto' });
  }

  // 3. Fallback: a specific version folder inside AnthropicClaude\app-*
  if (!found.some((f) => f.kind === 'exe')) {
    try {
      const base = path.join(LOCALAPPDATA, 'AnthropicClaude');
      const versions = fs
        .readdirSync(base)
        .filter((n) => n.startsWith('app-'))
        .sort()
        .reverse();
      for (const v of versions) {
        const exe = path.join(base, v, 'claude.exe');
        if (exists(exe)) {
          found.push({ kind: 'exe', path: exe, label: `AnthropicClaude ${v.slice(4)}`, source: 'auto' });
          break;
        }
      }
    } catch {
      // No installer-based copy present.
    }
  }

  return found;
}

/** Returns the install to use: the manual override, otherwise the first one found. */
function resolve(override) {
  if (override && override.kind === 'exe' && override.path && exists(override.path)) {
    return Object.assign({ label: path.basename(override.path), source: 'manual' }, override);
  }
  if (override && override.kind === 'store' && override.appId) {
    return Object.assign({ label: override.appId, source: 'manual' }, override);
  }
  return detectAll()[0] || null;
}

function launch(override) {
  const target = resolve(override);
  if (!target) return { ok: false, error: 'CLAUDE_NOT_FOUND' };

  try {
    if (target.kind === 'store') {
      // explorer.exe can open packaged apps by AppUserModelID.
      const child = spawn('explorer.exe', [`shell:AppsFolder\\${target.appId}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else {
      const child = spawn(target.path, [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
    return { ok: true, target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function isRunning() {
  return new Promise((done) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${PROCESS_NAME}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return done({ running: false, count: 0 });
        const lines = String(stdout)
          .split(/\r?\n/)
          .filter((l) => l.trim().toLowerCase().startsWith(`"${PROCESS_NAME}"`));
        done({ running: lines.length > 0, count: lines.length });
      }
    );
  });
}

function kill(force) {
  return new Promise((done) => {
    const args = ['/IM', PROCESS_NAME, '/T'];
    if (force) args.push('/F');
    execFile('taskkill', args, { windowsHide: true }, () => done());
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
  const home = process.env.USERPROFILE || '';
  const claudeDir = path.join(home, '.claude');
  return {
    present: exists(claudeDir),
    credentials: exists(path.join(claudeDir, '.credentials.json')),
    config: exists(path.join(home, '.claude.json')),
    dir: claudeDir,
  };
}

module.exports = { detectAll, detectCli, resolve, launch, isRunning, close, PROCESS_NAME };

'use strict';

/*
 * Which Claude Code builds are installed on this machine.
 *
 * There are several independent ones and they drift apart: the copy bundled
 * inside Claude Desktop, the npm-installed CLI, and the editor extensions. All
 * of it is read from directory names and package.json files on disk.
 */

const fs = require('fs');
const path = require('path');
const P = require('./paths');

const APPDATA = process.env.APPDATA || '';

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Compares dotted numeric versions; returns the newer of the two. */
function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? a : b;
  }
  return a;
}

/** The build Claude Desktop ships and runs internally. */
function desktopBundled() {
  const dir = path.join(P.CLAUDE_APPDATA, 'claude-code');
  let best = null;
  for (const e of readDirSafe(dir)) {
    if (e.isDirectory() && /^\d+(\.\d+)*$/.test(e.name)) best = newer(best, e.name);
  }
  return best;
}

/** The CLI installed through npm. */
function npmCli() {
  const pkg = path.join(APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** Editor extensions, whose folder name carries the version. */
function editorExtensions() {
  const hosts = [
    { id: 'vscode', label: 'VS Code', dir: path.join(P.HOME, '.vscode', 'extensions') },
    { id: 'vscode-insiders', label: 'VS Code Insiders', dir: path.join(P.HOME, '.vscode-insiders', 'extensions') },
    { id: 'cursor', label: 'Cursor', dir: path.join(P.HOME, '.cursor', 'extensions') },
    { id: 'windsurf', label: 'Windsurf', dir: path.join(P.HOME, '.windsurf', 'extensions') },
  ];

  const out = [];
  for (const host of hosts) {
    let best = null;
    for (const e of readDirSafe(host.dir)) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^anthropic\.claude-code-(\d+(?:\.\d+)*)/i);
      if (m) best = newer(best, m[1]);
    }
    if (best) out.push({ id: host.id, label: host.label, version: best });
  }
  return out;
}

/** Everything found, ready for display. Never throws. */
function detect() {
  const items = [];
  const bundled = desktopBundled();
  if (bundled) items.push({ id: 'desktop', label: 'Claude Desktop', version: bundled });
  const cli = npmCli();
  if (cli) items.push({ id: 'cli', label: 'CLI', version: cli });
  for (const ext of editorExtensions()) items.push(ext);
  return items;
}

module.exports = { detect };

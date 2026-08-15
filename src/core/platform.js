'use strict';

/*
 * Platform adapter.
 *
 * Everything that differs between operating systems lives here: where Claude
 * keeps its data, how it is found, started and stopped, and how a terminal is
 * opened. The rest of core/ is platform-agnostic and must stay that way.
 *
 * `switchVerified` gates the file moves: the app refuses to shuffle session
 * files on a platform where the exact file set has not been confirmed, because
 * getting it wrong there signs the user out rather than merely showing
 * something incorrect.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const HOME = os.homedir();

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ win32 */

const win32 = {
  id: 'win32',
  label: 'Windows',
  switchVerified: true,
  processName: 'claude.exe',

  dataDir: path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude'),

  // Files inside the data directory that belong to the signed-in account.
  desktopItems: ['Network', 'Local Storage', 'Session Storage', 'IndexedDB', 'Local State', 'config.json'],

  detect() {
    const local = process.env.LOCALAPPDATA || '';
    const found = [];

    // Store build: %LOCALAPPDATA%\Packages\Claude_<publisherHash>
    try {
      for (const name of fs.readdirSync(path.join(local, 'Packages'))) {
        if (!/^Claude_[a-z0-9]+$/i.test(name)) continue;
        found.push({ kind: 'store', appId: `${name}!Claude`, label: `Microsoft Store (${name})`, source: 'auto' });
      }
    } catch {
      /* no packaged apps on this machine */
    }

    // Installer build: a stub that resolves the current version itself.
    const squirrel = path.join(local, 'AnthropicClaude', 'claude.exe');
    if (exists(squirrel)) found.push({ kind: 'exe', path: squirrel, label: 'AnthropicClaude (installer)', source: 'auto' });

    if (!found.some((f) => f.kind === 'exe')) {
      try {
        const base = path.join(local, 'AnthropicClaude');
        const versions = fs.readdirSync(base).filter((n) => n.startsWith('app-')).sort().reverse();
        for (const v of versions) {
          const exe = path.join(base, v, 'claude.exe');
          if (exists(exe)) {
            found.push({ kind: 'exe', path: exe, label: `AnthropicClaude ${v.slice(4)}`, source: 'auto' });
            break;
          }
        }
      } catch {
        /* not installed this way */
      }
    }
    return found;
  },

  launch(target) {
    if (target.kind === 'store') {
      // explorer.exe opens packaged apps by AppUserModelID.
      return spawn('explorer.exe', [`shell:AppsFolder\\${target.appId}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    return spawn(target.path, [], { detached: true, stdio: 'ignore', windowsHide: true });
  },

  listProcesses(cb) {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${this.processName}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, stdout) => {
      if (err) return cb(0);
      cb(String(stdout).split(/\r?\n/).filter((l) => l.trim().toLowerCase().startsWith(`"${this.processName}"`)).length);
    });
  },

  kill(force, cb) {
    const args = ['/IM', this.processName, '/T'];
    if (force) args.push('/F');
    execFile('taskkill', args, { windowsHide: true }, () => cb());
  },

  openTerminalWithClaude() {
    return spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', 'claude'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  },

  exeFilter: { name: 'claude.exe', extensions: ['exe'] },
};

/*
 * macOS is deliberately absent.
 *
 * Claude-Usage-Tracker already covers the Mac properly, as a native menu-bar
 * app, and shipping a second unverified implementation would help nobody. The
 * README points Mac users there. The adapter shape stays so that a future port
 * has one obvious place to live.
 */

const table = { win32 };
const current = table[process.platform] || null;

module.exports = {
  current,
  supported: !!current,
  /** True when moving profile files has been verified on this platform. */
  canSwitch: !!current && current.switchVerified,
  platforms: table,
};

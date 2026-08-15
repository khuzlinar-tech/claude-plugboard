'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const claudeApp = require('./claudeApp');
const platform = require('./platform');

const SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

/* --------------------------------------------------------------- helpers */

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Move with a copy+delete fallback and a few retries for lingering file locks. */
async function movePath(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (err.code === 'EXDEV') {
        fs.cpSync(from, to, { recursive: true, force: true });
        rmrf(from);
        return;
      }
      if (attempt === 3) throw err;
      await sleep(150 * (attempt + 1)); // the exiting process may still hold handles
    }
  }
}

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(cur, e));
    } else {
      total += st.size;
    }
  }
  return total;
}

/* ------------------------------------------------------- state and meta */

function readCurrentSlot() {
  try {
    const v = fs.readFileSync(P.STATE_FILE, 'utf8').replace(/^﻿/, '').trim();
    return v || null;
  } catch {
    return null;
  }
}

function writeCurrentSlot(slot) {
  fs.mkdirSync(P.PROFILES_DIR, { recursive: true });
  // UTF-8 with BOM, matching what PowerShell 5.1 Set-Content -Encoding utf8 writes,
  // so scripts built around the same storage keep reading the file the same way.
  fs.writeFileSync(P.STATE_FILE, '﻿' + slot + '\r\n', 'utf8');
}

function readMeta() {
  return readJson(P.META_FILE) || { profiles: {} };
}

function writeMeta(meta) {
  writeJson(P.META_FILE, meta);
}

/* ----------------------------------------------------- account parsing */

function planLabel(acc) {
  if (!acc) return null;
  const type = acc.organizationType || '';
  const tier = acc.organizationRateLimitTier || '';
  if (type === 'claude_max') {
    if (/20x/i.test(tier)) return 'Max 20x';
    if (/5x/i.test(tier)) return 'Max 5x';
    return 'Max';
  }
  const map = {
    claude_pro: 'Pro',
    claude_team: 'Team',
    claude_enterprise: 'Enterprise',
    claude_free: 'Free',
  };
  return map[type] || type || null;
}

function billingKey(value) {
  const map = {
    apple_subscription: 'apple',
    google_play_subscription: 'google',
    stripe: 'stripe',
    stripe_subscription: 'stripe',
    invoice: 'invoice',
    none: 'none',
  };
  return map[value] || null;
}

function accountFrom(claudeJson) {
  const acc = claudeJson && claudeJson.oauthAccount;
  if (!acc || !acc.emailAddress) return null;
  return {
    email: acc.emailAddress,
    displayName: acc.displayName || null,
    accountUuid: acc.accountUuid || null,
    organizationUuid: acc.organizationUuid || null,
    organizationName: acc.organizationName || null,
    organizationType: acc.organizationType || null,
    rateLimitTier: acc.organizationRateLimitTier || acc.userRateLimitTier || null,
    plan: planLabel(acc),
    billingType: acc.billingType || null,
    billingKey: billingKey(acc.billingType),
    hasExtraUsageEnabled: !!acc.hasExtraUsageEnabled,
    accountCreatedAt: acc.accountCreatedAt || null,
    subscriptionCreatedAt: acc.subscriptionCreatedAt || null,
    claudeCodeTrialEndsAt: acc.claudeCodeTrialEndsAt || null,
    profileFetchedAt: acc.profileFetchedAt || null,
    seatTier: acc.seatTier || null,
  };
}

/* -------------------------------------------------------------- profiles */

function listSlots() {
  let entries = [];
  try {
    entries = fs.readdirSync(P.PROFILES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function listProfiles({ withSize = true, scope = 'both' } = {}) {
  const current = readCurrentSlot();
  const meta = readMeta();
  const slots = listSlots();

  // The active slot may not have a storage folder yet; it is still a profile.
  if (current && !slots.includes(current)) slots.unshift(current);

  return slots.map((slot) => {
    const isActive = slot === current;
    const storeDir = path.join(P.PROFILES_DIR, slot);
    const source = isActive ? P.CLAUDE_JSON : path.join(storeDir, 'home_.claude.json');
    const account = accountFrom(readJson(source));
    const m = (meta.profiles && meta.profiles[slot]) || {};

    let lastUsed = null;
    try {
      lastUsed = fs.statSync(isActive ? P.CLAUDE_JSON : storeDir).mtimeMs;
    } catch {
      // Empty profile, nothing stored yet.
    }

    // For the active profile the files live in their working locations,
    // so the storage folder is empty and would report zero.
    let sizeBytes = null;
    if (withSize) {
      if (isActive) {
        sizeBytes = P.pairsFor(slot, scope).reduce(
          (sum, pair) => sum + (exists(pair.live) ? dirSize(pair.live) : 0),
          0
        );
      } else if (exists(storeDir)) {
        sizeBytes = dirSize(storeDir);
      }
    }

    return {
      slot,
      label: m.label || null,
      isActive,
      configured: !!account,
      account,
      storeDir,
      sizeBytes,
      lastUsed,
    };
  });
}

/* ---------------------------------------------------------- switching */

/**
 * Moves account files between their working locations and the slot storage.
 * Every move is journalled so a failure halfway through can be rolled back.
 */
async function movePairs(slot, direction, scope, journal) {
  fs.mkdirSync(path.join(P.PROFILES_DIR, slot), { recursive: true });
  for (const pair of P.pairsFor(slot, scope)) {
    const from = direction === 'save' ? pair.live : pair.store;
    const to = direction === 'save' ? pair.store : pair.live;
    if (!exists(from)) continue;
    if (exists(to)) rmrf(to);
    await movePath(from, to);
    journal.push({ from: to, to: from }); // the inverse move, for rollback
  }
}

async function rollback(journal) {
  for (const step of journal.reverse()) {
    try {
      if (!exists(step.from)) continue;
      if (exists(step.to)) rmrf(step.to);
      await movePath(step.from, step.to);
    } catch {
      // Roll back as far as possible; nothing better can be done here.
    }
  }
}

/**
 * Switches the active profile.
 * @param {string} target slot name
 * @param {{launch?: boolean, autoClose?: boolean, scope?: string, claudeApp?: object}} opts
 */
async function switchProfile(target, opts = {}) {
  const { launch = true, autoClose = false, scope = 'both', claudeApp: appOverride = null } = opts;

  if (!SLOT_RE.test(target)) return { ok: false, code: 'BAD_NAME' };

  // Refuse to move session files where the file set has not been confirmed.
  // Guessing wrong here costs the user their sign-in, not just a wrong reading.
  if (!platform.canSwitch) return { ok: false, code: 'PLATFORM_UNVERIFIED' };

  const state = await claudeApp.isRunning();
  if (state.running) {
    if (!autoClose) return { ok: false, code: 'CLAUDE_RUNNING' };
    const closed = await claudeApp.close();
    if (!closed.ok) return { ok: false, code: 'CLOSE_FAILED' };
    await sleep(1200); // let the OS release file handles
  }

  fs.mkdirSync(P.PROFILES_DIR, { recursive: true });
  const current = readCurrentSlot() || 'acc1';

  if (current === target) {
    if (launch) claudeApp.launch(appOverride);
    return { ok: true, unchanged: true, current: target };
  }

  const journal = [];
  try {
    await movePairs(current, 'save', scope, journal);
    await movePairs(target, 'restore', scope, journal);
  } catch (err) {
    await rollback(journal);
    return { ok: false, code: 'MOVE_FAILED', detail: err.message };
  }

  writeCurrentSlot(target);
  if (launch) claudeApp.launch(appOverride);
  return { ok: true, from: current, current: target };
}

/* ------------------------------------------------------ slot management */

function addProfile(name) {
  const slot = String(name || '').trim();
  if (!SLOT_RE.test(slot)) return { ok: false, code: 'BAD_NAME' };
  const dir = path.join(P.PROFILES_DIR, slot);
  if (exists(dir)) return { ok: false, code: 'EXISTS', slot };
  fs.mkdirSync(dir, { recursive: true });
  return { ok: true, slot };
}

/** Creates a slot from the current live session — the first-run path. */
function adoptCurrent(name) {
  const res = addProfile(name);
  if (!res.ok && res.code !== 'EXISTS') return res;
  const slot = res.slot || String(name).trim();
  writeCurrentSlot(slot);
  return { ok: true, slot };
}

function deleteProfile(slot) {
  if (!platform.canSwitch) return { ok: false, code: 'PLATFORM_UNVERIFIED' };
  if (slot === readCurrentSlot()) return { ok: false, code: 'IS_ACTIVE' };
  const dir = path.join(P.PROFILES_DIR, slot);
  if (!exists(dir)) return { ok: false, code: 'NOT_FOUND' };

  // Recycled, not erased: the account data stays recoverable by hand.
  fs.mkdirSync(P.TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(P.TRASH_DIR, `${slot}-${stamp}`);
  fs.renameSync(dir, dest);

  const meta = readMeta();
  if (meta.profiles) delete meta.profiles[slot];
  writeMeta(meta);

  return { ok: true, movedTo: dest };
}

function setProfileMeta(slot, patch) {
  const meta = readMeta();
  if (!meta.profiles) meta.profiles = {};
  meta.profiles[slot] = Object.assign({}, meta.profiles[slot], patch);
  if (!meta.profiles[slot].label) delete meta.profiles[slot].label;
  writeMeta(meta);
  return { ok: true };
}

module.exports = {
  SLOT_RE,
  readJson,
  readCurrentSlot,
  listProfiles,
  switchProfile,
  addProfile,
  adoptCurrent,
  deleteProfile,
  setProfileMeta,
  planLabel,
};

'use strict';

/*
 * Optional live usage, off unless the user turns it on.
 *
 * When enabled, this reads the OAuth access token that Claude Code stores in
 * plaintext and asks Anthropic's own usage endpoint for the exact figures —
 * the same approach as the reference projects linked in the README. The token
 * belongs to the user, stays on the machine, and is sent only to its issuer
 * (api.anthropic.com) over TLS, only in the Authorization header.
 *
 * ── Verification note ────────────────────────────────────────────────────────
 * The network path in this file was NOT exercised by the author's tooling; the
 * request shape follows the reference project's documented API. Treat the exact
 * endpoint, headers and response fields as needing confirmation on a real run.
 * Everything that does not touch the network — token discovery and expiry — is
 * covered by the app's own checks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const P = require('./paths');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 12000;

/** Reads and parses a Claude Code credentials file into its oauth block. */
function readCredsFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const o = j && j.claudeAiOauth;
    if (!o || !o.accessToken) return null;
    return { accessToken: o.accessToken, refreshToken: o.refreshToken || null, expiresAt: o.expiresAt || 0 };
  } catch {
    return null;
  }
}

/**
 * Finds the Claude Code token for a profile without any network access.
 * The active profile keeps it live in ~/.claude; others keep a copy in storage.
 * Returns { source, accessToken, expiresAt, expired } or null.
 */
function tokenForProfile(slot, isActive) {
  const file = isActive
    ? path.join(P.CLAUDE_DIR, '.credentials.json')
    : path.join(P.PROFILES_DIR, slot, 'dir_.credentials.json');

  const creds = readCredsFile(file);
  if (!creds) return null;
  return {
    source: 'claudeCode',
    accessToken: creds.accessToken,
    expiresAt: creds.expiresAt,
    expired: creds.expiresAt > 0 && creds.expiresAt <= Date.now(),
  };
}

/** True when a Claude Code token exists for the profile, expired or not. */
function hasToken(slot, isActive) {
  return !!tokenForProfile(slot, isActive);
}

function mapWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  const resetAt = w.resets_at ? Date.parse(w.resets_at) : null;
  return {
    value: Math.round(w.utilization),
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
  };
}

/**
 * Calls the usage endpoint with a bearer token.
 * @returns {Promise<{ok:true, fiveHour, weekly, raw} | {ok:false, code, status?}>}
 */
async function fetchUsage(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) return { ok: false, code: 'API_UNAUTHORIZED', status: res.status };
    if (!res.ok) return { ok: false, code: 'API_HTTP', status: res.status };

    const data = await res.json();
    return {
      ok: true,
      fiveHour: mapWindow(data.five_hour),
      weekly: mapWindow(data.seven_day),
      fetchedAt: null, // stamped by the caller; Date.now() is avoided in core
    };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, code: 'API_TIMEOUT' };
    return { ok: false, code: 'API_NETWORK', detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves usage for a profile: finds its token (or uses a supplied manual one)
 * and calls the endpoint. Never throws; returns a tagged result.
 * @param {{slot:string, isActive:boolean, manualToken?:string}} profile
 */
async function usageForProfile(profile) {
  let accessToken = profile.manualToken || null;
  let source = profile.manualToken ? 'manual' : null;

  if (!accessToken) {
    const tok = tokenForProfile(profile.slot, profile.isActive);
    if (!tok) return { ok: false, code: 'API_NO_TOKEN' };
    if (tok.expired) return { ok: false, code: 'API_TOKEN_EXPIRED' };
    accessToken = tok.accessToken;
    source = tok.source;
  }

  const res = await fetchUsage(accessToken);
  return res.ok ? Object.assign(res, { source }) : res;
}

module.exports = {
  USAGE_URL,
  tokenForProfile,
  hasToken,
  fetchUsage,
  usageForProfile,
};

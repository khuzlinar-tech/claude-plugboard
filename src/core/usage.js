'use strict';

const fs = require('fs');
const P = require('./paths');

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const STALE_AFTER = 45 * 60 * 1000; // Claude records a sample roughly every 15 minutes

/*
 * On estimating reset times.
 *
 * The file stores rounded percentages sampled roughly every 15 minutes, and
 * nothing else. The exact moment a window opened cannot be recovered from that:
 * a small first request rounds to 0%, so even the last zero-valued sample is not
 * a reliable lower bound.
 *
 * What can be stated with confidence is an upper bound. Usage was already
 * non-zero at a known sample, so the window opened no later than that sample,
 * and therefore resets no later than that sample plus the window length. The UI
 * presents it that way rather than inventing a precise clock time.
 *
 * Claude's own usage dialog knows the exact values; this is only an estimate
 * derived from what is on disk.
 */

/** Index of the most recent sample where the counter fell, meaning a reset happened. */
function lastDropIndex(series, key) {
  for (let i = series.length - 1; i > 0; i--) {
    if (series[i][key] < series[i - 1][key]) return i;
  }
  return -1;
}

/** Five-hour session: bounded by the first sample that already showed usage. */
function fiveHourWindow(series) {
  const value = series.length ? series[series.length - 1].fh : 0;
  if (!value) return { value, resetBefore: null, known: false, openedBy: null };

  const from = Math.max(lastDropIndex(series, 'fh'), 0);
  let openedBy = null;
  for (let i = from; i < series.length; i++) {
    if (series[i].fh > 0) {
      openedBy = series[i].t;
      break;
    }
  }
  if (openedBy == null) return { value, resetBefore: null, known: false, openedBy: null };

  const resetBefore = openedBy + FIVE_HOURS;
  return {
    value,
    openedBy,
    resetBefore: resetBefore > Date.now() ? resetBefore : null,
    known: resetBefore > Date.now(),
  };
}

/** Rolls a known reset moment forward in whole weeks until it lands in the future. */
function nextWeekly(anchorMs) {
  let r = anchorMs;
  const now = Date.now();
  while (r <= now) r += SEVEN_DAYS;
  return r;
}

/**
 * Weekly window.
 *
 * Precision depends on what is known, best first:
 *   - a stored anchor (learned from a past reset, or entered by hand) → exact
 *   - a reset actually seen in this history → exact for this cycle
 *   - neither → unknown; first use is NOT used as an anchor, because the weekly
 *     cycle is tied to the account, not to when it was first exercised.
 *
 * `observedReset` is surfaced so the caller can persist it as a future anchor.
 */
function weeklyWindow(series, anchorMs) {
  const value = series.length ? series[series.length - 1].sd : 0;
  const drop = lastDropIndex(series, 'sd');
  const observedReset = drop >= 0 ? series[drop].t : null;

  if (anchorMs) {
    return { value, resetAt: nextWeekly(anchorMs), exact: true, known: true, observedReset };
  }
  if (observedReset != null) {
    return { value, resetAt: nextWeekly(observedReset), exact: false, known: true, observedReset };
  }
  return { value, resetAt: null, exact: false, known: false, observedReset: null };
}

/** Peak value per local day, for the bar chart. */
function dailyPeaks(series, key) {
  const byDay = new Map();
  for (const s of series) {
    const d = new Date(s.t);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(day, Math.max(byDay.get(day) || 0, s[key] || 0));
  }
  return [...byDay.entries()].map(([day, value]) => ({ day, value })).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.anchors] org uuid -> known weekly reset epoch ms
 */
function readPlanUsage(opts = {}) {
  const anchors = opts.anchors || {};
  let raw;
  let stat;
  try {
    stat = fs.statSync(P.USAGE_HISTORY);
    raw = fs.readFileSync(P.USAGE_HISTORY, 'utf8');
  } catch {
    return { ok: false, code: 'USAGE_FILE_MISSING', orgs: {} };
  }

  let data;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, code: 'USAGE_FILE_BROKEN', detail: err.message, orgs: {} };
  }

  const samples = Array.isArray(data.samples) ? data.samples : [];
  const byOrg = new Map();
  for (const s of samples) {
    if (!s || !s.org || !s.u) continue;
    if (!byOrg.has(s.org)) byOrg.set(s.org, []);
    // fh = five-hour window usage %, sd = seven-day (weekly) usage %
    byOrg.get(s.org).push({ t: s.t, fh: s.u.fh || 0, sd: s.u.sd || 0 });
  }

  const now = Date.now();
  const orgs = {};
  for (const [org, series] of byOrg) {
    series.sort((a, b) => a.t - b.t);
    const latest = series[series.length - 1];
    orgs[org] = {
      org,
      count: series.length,
      first: series[0].t,
      last: latest.t,
      ageMs: now - latest.t,
      stale: now - latest.t > STALE_AFTER,
      latest,
      fiveHour: fiveHourWindow(series),
      weekly: weeklyWindow(series, anchors[org]),
      series,
      dailySd: dailyPeaks(series, 'sd'),
      dailyFh: dailyPeaks(series, 'fh'),
    };
  }

  return {
    ok: true,
    file: P.USAGE_HISTORY,
    mtime: stat.mtimeMs,
    version: data.version || null,
    totalSamples: samples.length,
    orgs,
  };
}

module.exports = { readPlanUsage, FIVE_HOURS, SEVEN_DAYS };

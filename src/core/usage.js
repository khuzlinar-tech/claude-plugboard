'use strict';

const fs = require('fs');
const P = require('./paths');

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const STALE_AFTER = 45 * 60 * 1000; // Claude records a sample roughly every 15 minutes

/**
 * Finds the start of the current window: the last point where the counter
 * dropped (a reset), then the first sample after it with non-zero usage.
 */
function windowStart(series, key) {
  if (!series.length) return null;
  const latest = series[series.length - 1][key];
  if (!latest) return null; // no usage means no active window

  let resetAt = 0;
  for (let i = series.length - 1; i > 0; i--) {
    if (series[i][key] < series[i - 1][key]) {
      resetAt = i;
      break;
    }
  }
  for (let i = resetAt; i < series.length; i++) {
    if (series[i][key] > 0) return series[i].t;
  }
  return series[resetAt].t;
}

function buildWindow(series, key, span) {
  const value = series.length ? series[series.length - 1][key] : 0;
  const start = windowStart(series, key);
  if (start == null) return { value, start: null, resetAt: null };
  const resetAt = start + span;
  return { value, start, resetAt: resetAt > Date.now() ? resetAt : null };
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

function readPlanUsage() {
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
      fiveHour: buildWindow(series, 'fh', FIVE_HOURS),
      weekly: buildWindow(series, 'sd', SEVEN_DAYS),
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

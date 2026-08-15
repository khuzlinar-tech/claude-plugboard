'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const P = require('./paths');

/*
 * Claude Code token usage is computed from the transcripts in
 * ~/.claude/projects/ ** / *.jsonl.
 *
 * That folder is not part of the switched set, so the numbers cover every
 * account at once. The UI says so explicitly.
 */

const EMPTY = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0, messages: 0 });

function add(target, u) {
  target.input += u.input_tokens || 0;
  target.output += u.output_tokens || 0;
  target.cacheWrite += u.cache_creation_input_tokens || 0;
  target.cacheRead += u.cache_read_input_tokens || 0;
  target.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
  target.messages += 1;
}

function mergeInto(map, key, part) {
  if (!key) return;
  if (!map[key]) map[key] = EMPTY();
  const t = map[key];
  t.input += part.input;
  t.output += part.output;
  t.cacheWrite += part.cacheWrite;
  t.cacheRead += part.cacheRead;
  t.thinking += part.thinking;
  t.messages += part.messages;
}

function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function walkJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

/** Reduces one transcript to per-day / per-model / per-project aggregates. */
async function parseFile(file) {
  const days = {};
  const models = {};
  const projects = {};
  const seen = new Set(); // the same response can repeat when a session branches

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || line.length < 20 || line.indexOf('"usage"') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;

    const id = obj.message.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    const part = EMPTY();
    add(part, obj.message.usage);

    const day = localDay(obj.timestamp);
    if (day) mergeInto(days, day, part);
    mergeInto(models, obj.message.model || 'unknown', part);

    const cwd = obj.cwd || '';
    mergeInto(projects, cwd ? path.basename(cwd) || cwd : 'unknown', part);
  }

  return { days, models, projects };
}

function loadCache(cacheFile) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return { version: 1, files: {} };
  }
}

function saveCache(cacheFile, cache) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
  } catch {
    // The cache is an optimisation only.
  }
}

/**
 * @param {string} cacheFile path to the cache file inside userData
 * @param {(done:number, total:number)=>void} [onProgress]
 */
async function readCliUsage(cacheFile, onProgress) {
  const files = walkJsonl(P.PROJECTS_DIR);
  if (!files.length) return { ok: false, code: 'NO_TRANSCRIPTS' };

  const cache = loadCache(cacheFile);
  const days = {};
  const models = {};
  const projects = {};
  let bytes = 0;
  let parsed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    bytes += st.size;

    const hit = cache.files[file];
    let agg;
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      agg = hit.agg;
    } else {
      agg = await parseFile(file);
      cache.files[file] = { mtimeMs: st.mtimeMs, size: st.size, agg };
      parsed++;
    }

    for (const [k, v] of Object.entries(agg.days)) mergeInto(days, k, v);
    for (const [k, v] of Object.entries(agg.models)) mergeInto(models, k, v);
    for (const [k, v] of Object.entries(agg.projects)) mergeInto(projects, k, v);

    if (onProgress) onProgress(i + 1, files.length);
  }

  // Drop cache entries for transcripts that no longer exist.
  const alive = new Set(files);
  for (const key of Object.keys(cache.files)) if (!alive.has(key)) delete cache.files[key];
  saveCache(cacheFile, cache);

  const totals = EMPTY();
  for (const v of Object.values(days)) {
    totals.input += v.input;
    totals.output += v.output;
    totals.cacheWrite += v.cacheWrite;
    totals.cacheRead += v.cacheRead;
    totals.thinking += v.thinking;
    totals.messages += v.messages;
  }

  return {
    ok: true,
    files: files.length,
    reparsed: parsed,
    bytes,
    totals,
    days: Object.entries(days)
      .map(([day, v]) => Object.assign({ day }, v))
      .sort((a, b) => a.day.localeCompare(b.day)),
    models: Object.entries(models)
      .map(([model, v]) => Object.assign({ model }, v))
      .sort((a, b) => b.output - a.output),
    projects: Object.entries(projects)
      .map(([project, v]) => Object.assign({ project }, v))
      .sort((a, b) => b.output - a.output)
      .slice(0, 12),
  };
}

module.exports = { readCliUsage };

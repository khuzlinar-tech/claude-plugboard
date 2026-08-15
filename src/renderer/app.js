'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  state: null,
  plan: null,
  cli: null,
  cliLoading: false,
  selected: null,
  tab: 'overview',
  range: 24 * 3600e3,
  codeMode: 'all',
  busy: false,
};

let DICT = {};
let LOCALE = 'en-US';
let nf = new Intl.NumberFormat('en-US');

const t = (key, params) => {
  let s = DICT[key];
  if (s == null) return key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
};

/* ------------------------------------------------------------ форматтеры */

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Chromium does not resolve var() inside SVG presentation attributes, so chart
// colours are read out of the stylesheet as literals whenever the theme changes.
let C = {};

function refreshPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
  C = {
    accent: v('--accent', '#d97757'),
    blue: v('--blue', '#7ba7d7'),
    danger: v('--danger', '#d9605a'),
    warn: v('--warn', '#e0a458'),
    sand: v('--chart-input', '#c9a06a'),
    deep: v('--chart-cache-read', '#4d6b86'),
    grid: v('--grid', '#332f2c'),
    axis: v('--axis', '#7d7770'),
    crosshair: v('--crosshair', '#6b645d'),
  };
}

function applyTheme(payload) {
  document.documentElement.dataset.theme = payload && payload.dark === false ? 'light' : 'dark';
  refreshPalette();
}

const DASH = '—';

function fmtDate(v) {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtTime(v) {
  return new Date(v).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

function fmtDateTime(v) {
  if (!v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(day) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
}

function fmtDuration(ms) {
  if (ms == null || ms < 0) return DASH;
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'always', style: 'short' });
  const m = Math.round(ms / 60000);
  if (m < 60) return rtf.formatToParts(m, 'minute').map((p) => p.value).join('').replace(/^in\s+/i, '').trim();
  const h = Math.floor(m / 60);
  if (h < 24) {
    const head = rtf.formatToParts(h, 'hour').map((p) => p.value).join('').replace(/^in\s+/i, '').trim();
    const rest = m % 60;
    if (!rest) return head;
    const tail = rtf.formatToParts(rest, 'minute').map((p) => p.value).join('').replace(/^in\s+/i, '').trim();
    return `${head} ${tail}`;
  }
  const d = Math.floor(h / 24);
  return rtf.formatToParts(d, 'day').map((p) => p.value).join('').replace(/^in\s+/i, '').trim();
}

function relTime(ts) {
  if (!ts) return DASH;
  const diff = Date.now() - ts;
  if (diff < 90e3 || diff < 0) {
    return new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style: 'short' }).format(0, 'minute');
  }
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'always', style: 'short' });
  const m = Math.round(diff / 60000);
  if (m < 60) return rtf.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  return rtf.format(-Math.round(h / 24), 'day');
}

function fmtBytes(n) {
  if (n == null) return DASH;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : i === 1 ? 0 : 1)} ${units[i]}`;
}

function fmtTok(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function usageColor(pct) {
  if (pct >= 90) return C.danger;
  if (pct >= 70) return C.warn;
  return C.accent;
}

function planBadgeClass(plan) {
  if (!plan) return 'badge-empty';
  if (plan.startsWith('Max')) return 'badge-max';
  if (plan === 'Pro') return 'badge-pro';
  return '';
}

function errorText(res) {
  if (!res) return t('err.unknown');
  if (res.code) return t(`err.${res.code}`, { detail: res.detail, slot: res.slot });
  return res.error || t('err.unknown');
}

/* ------------------------------------------------------------- служебное */

let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind || ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 4200);
}

function orgUsage(profile) {
  const uuid = profile && profile.account && profile.account.organizationUuid;
  if (!uuid || !S.plan || !S.plan.orgs) return null;
  return S.plan.orgs[uuid] || null;
}

function selectedProfile() {
  if (!S.state) return null;
  return S.state.profiles.find((p) => p.slot === S.selected) || S.state.profiles[0] || null;
}

function applyStaticI18n() {
  document.documentElement.lang = LOCALE.slice(0, 2);
  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$('[data-title]').forEach((el) => el.setAttribute('title', t(el.dataset.title)));
}

/* ------------------------------------------------------------- загрузка */

async function loadDict() {
  const payload = await window.api.dict();
  DICT = payload.dict;
  LOCALE = payload.locale;
  nf = new Intl.NumberFormat(LOCALE);
  applyStaticI18n();
}

async function refresh({ silent } = {}) {
  if (!silent) $('#btnRefresh').classList.add('spin');
  try {
    const [state, plan] = await Promise.all([window.api.getState(), window.api.planUsage()]);
    S.state = state;
    S.plan = plan;
    if (!S.selected || !state.profiles.some((p) => p.slot === S.selected)) {
      S.selected = state.current || (state.profiles[0] && state.profiles[0].slot) || null;
    }
    paintClaudeState(state.claude);
    render();
  } catch (err) {
    toast(t('toast.loadFailed', { msg: err.message }), 'err');
  } finally {
    $('#btnRefresh').classList.remove('spin');
  }
}

function paintClaudeState(st) {
  const pill = $('#claudeState');
  const text = $('#claudeStateText');
  if (!st) return;
  if (S.state && !S.state.claudeApp && !st.running) {
    pill.className = 'pill';
    text.textContent = t('claude.notFound');
    return;
  }
  if (st.running) {
    pill.className = 'pill pill-run';
    text.textContent = t('claude.running', { n: st.count });
  } else {
    pill.className = 'pill pill-off';
    text.textContent = t('claude.stopped');
  }
  if (S.state) S.state.claude = st;
}

/* -------------------------------------------------------------- сайдбар */

function renderSidebar() {
  const list = $('#profileList');
  const profiles = S.state ? S.state.profiles : [];
  $('#profileCount').textContent = profiles.length ? String(profiles.length) : '';

  list.innerHTML = profiles
    .map((p) => {
      const u = orgUsage(p);
      const acc = p.account;
      const name = p.label || p.slot;
      return `
      <button class="pcard ${p.isActive ? 'active' : ''} ${p.slot === S.selected ? 'selected' : ''}" data-slot="${esc(p.slot)}">
        <div class="pcard-top">
          <span class="pcard-name">${esc(name)}</span>
          ${p.isActive ? `<span class="badge badge-active">${esc(t('side.active'))}</span>` : ''}
        </div>
        <div class="pcard-mail">${acc ? esc(acc.email) : esc(t('side.notConfigured'))}</div>
        <div class="pcard-row">
          <span class="badge ${planBadgeClass(acc && acc.plan)}">${esc(acc ? acc.plan || t('common.unknown') : t('side.emptyBadge'))}</span>
          ${p.label ? `<span class="badge">${esc(p.slot)}</span>` : ''}
        </div>
        ${
          u
            ? `<div class="mini-bars" title="${t('lim.fh')}: ${u.latest.fh}% · ${t('lim.sd')}: ${u.latest.sd}%">
                 <span class="mini-bar"><i style="width:${u.latest.fh}%;background:${usageColor(u.latest.fh)}"></i></span>
                 <span class="mini-bar"><i style="width:${u.latest.sd}%;background:${C.blue}"></i></span>
               </div>`
            : ''
        }
      </button>`;
    })
    .join('');

  $$('.pcard', list).forEach((el) =>
    el.addEventListener('click', () => {
      S.selected = el.dataset.slot;
      render();
    })
  );
}

/* --------------------------------------------------------------- панели */

function render() {
  renderSidebar();
  $$('.tab').forEach((tb) => tb.classList.toggle('is-active', tb.dataset.tab === S.tab));
  const pane = $('#pane');

  if (!S.state) {
    pane.innerHTML = `<div class="empty">${esc(t('common.loading'))}</div>`;
    return;
  }

  const p = selectedProfile();
  if (!p) {
    renderOnboarding(pane);
    return;
  }

  if (S.tab === 'overview') renderOverview(pane, p);
  else if (S.tab === 'limits') renderLimits(pane, p);
  else renderCode(pane);
}

function renderOnboarding(pane) {
  pane.innerHTML = `
    <div class="empty">
      <h3>${esc(t('onb.title'))}</h3>
      <p style="max-width:520px;margin:0 auto">${esc(t('onb.body'))}</p>
      <p style="margin-top:18px">
        <button class="btn btn-primary" data-act="adopt">${esc(t('onb.create'))}</button>
      </p>
    </div>`;
  wireActions(pane);
}

/* ------------------------------------------------------------ Обзор */

function field(k, v, mono) {
  return `<div class="field"><div class="k">${esc(k)}</div><div class="v ${mono ? 'mono' : ''}">${v}</div></div>`;
}

function renderOverview(pane, p) {
  const acc = p.account;
  const u = orgUsage(p);
  const running = S.state.claude && S.state.claude.running;

  const header = `
    <div class="head">
      <div>
        <h1>${esc(p.label || p.slot)}${acc && acc.displayName ? ` · ${esc(acc.displayName)}` : ''}</h1>
        <div class="sub">${acc ? esc(acc.email) : esc(t('side.notConfigured'))}</div>
      </div>
      <div class="head-actions">
        ${
          p.isActive
            ? `<button class="btn btn-primary" data-act="launch">${esc(t('ov.launch'))}</button>`
            : `<button class="btn btn-primary" data-act="switch" data-slot="${esc(p.slot)}">${esc(t('ov.switch'))}</button>`
        }
        ${running ? `<button class="btn btn-danger" data-act="close">${esc(t('ov.closeClaude'))}</button>` : ''}
        <button class="btn btn-ghost" data-act="openStore" data-slot="${esc(p.slot)}">${esc(t('ov.openFolder'))}</button>
      </div>
    </div>`;

  const manage = `
    <div class="card">
      <h2>${esc(t('ov.manage'))}</h2>
      <div class="head-actions">
        <button class="btn btn-sm" data-act="rename" data-slot="${esc(p.slot)}">${esc(t('ov.rename'))}</button>
        <button class="btn btn-sm btn-ghost" data-act="openStore" data-slot="${esc(p.slot)}">${esc(t('ov.openFolder'))}</button>
        <button class="btn btn-sm btn-danger" data-act="delete" data-slot="${esc(p.slot)}"
          ${p.isActive ? `disabled title="${esc(t('ov.deleteActiveTip'))}"` : ''}>${esc(t('ov.delete'))}</button>
      </div>
      <div class="gauge-sub" style="margin-top:12px">${esc(t('ov.manageNote'))}</div>
    </div>`;

  if (!acc) {
    pane.innerHTML =
      header +
      `<div class="note"><div><b>${esc(t('ov.notConfiguredTitle'))}</b> ${esc(t('ov.notConfiguredBody'))}</div></div>` +
      manage;
    wireActions(pane);
    return;
  }

  pane.innerHTML =
    header +
    `<div class="two-col">
      <div class="card">
        <h2>${esc(t('ov.subscription'))}</h2>
        <div class="grid">
          ${field(t('ov.plan'), `<span class="badge ${planBadgeClass(acc.plan)}">${esc(acc.plan || t('common.unknown'))}</span>`)}
          ${field(t('ov.tier'), esc(acc.rateLimitTier || DASH), true)}
          ${field(t('ov.billing'), esc(acc.billingKey ? t(`billing.${acc.billingKey}`) : acc.billingType || DASH))}
          ${field(t('ov.subSince'), fmtDate(acc.subscriptionCreatedAt))}
          ${field(t('ov.accCreated'), fmtDate(acc.accountCreatedAt))}
          ${field(
            t('ov.extraUsage'),
            acc.hasExtraUsageEnabled
              ? `<span style="color:var(--green)">${esc(t('common.on'))}</span>`
              : `<span class="muted">${esc(t('common.off'))}</span>`
          )}
          ${field(
            t('ov.trial'),
            acc.claudeCodeTrialEndsAt ? fmtDate(acc.claudeCodeTrialEndsAt) : `<span class="muted">${esc(t('common.none'))}</span>`
          )}
        </div>
      </div>

      <div class="card">
        <h2>${esc(t('ov.limits'))}</h2>
        ${u ? gaugesHtml(u) : `<div class="muted" style="padding:8px 0">${esc(t('ov.noSamples'))}</div>`}
        ${
          u
            ? `<div class="gauge-sub" style="margin-top:14px">
                 ${esc(t('ov.lastSample', { when: relTime(u.last) }))}${
                   u.stale ? ` · <span style="color:var(--warn)">${esc(t('ov.stale'))}</span>` : ''
                 }
               </div>`
            : ''
        }
      </div>
    </div>

    <div class="card">
      <h2>${esc(t('ov.account'))}</h2>
      <div class="grid">
        ${field(t('ov.orgName'), esc(acc.organizationName || DASH))}
        ${field(t('ov.orgType'), esc(acc.organizationType || DASH), true)}
        ${field(t('ov.accountUuid'), esc(acc.accountUuid || DASH), true)}
        ${field(t('ov.orgUuid'), esc(acc.organizationUuid || DASH), true)}
        ${field(t('ov.fetched'), acc.profileFetchedAt ? fmtDateTime(acc.profileFetchedAt) : DASH)}
        ${field(t('ov.size'), fmtBytes(p.sizeBytes))}
      </div>
    </div>` +
    manage;

  wireActions(pane);
}

function gaugeSvg(pct, color) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const on = (Math.max(0, Math.min(100, pct)) / 100) * c;
  return `<svg viewBox="0 0 96 96">
    <circle class="track" cx="48" cy="48" r="${r}"></circle>
    <circle class="fill" cx="48" cy="48" r="${r}" stroke="${color}"
      stroke-dasharray="${on.toFixed(1)} ${(c - on).toFixed(1)}"></circle>
  </svg>`;
}

function gaugesHtml(u) {
  const fh = u.latest.fh;
  const sd = u.latest.sd;
  const fhReset = u.fiveHour.resetAt
    ? t('lim.resetIn', { dur: fmtDuration(u.fiveHour.resetAt - Date.now()), time: fmtTime(u.fiveHour.resetAt) })
    : t('lim.notStarted');
  const sdReset = u.weekly.resetAt ? t('lim.resetAt', { when: fmtDateTime(u.weekly.resetAt) }) : t('lim.noReset');

  return `<div class="gauges">
    <div class="gauge">
      ${gaugeSvg(fh, usageColor(fh))}
      <div>
        <div class="gauge-label">${esc(t('lim.fh'))}</div>
        <div class="gauge-value">${fh}<small>%</small></div>
        <div class="gauge-sub">${esc(fhReset)}</div>
      </div>
    </div>
    <div class="gauge">
      ${gaugeSvg(sd, sd >= 90 ? C.danger : C.blue)}
      <div>
        <div class="gauge-label">${esc(t('lim.sd'))}</div>
        <div class="gauge-value">${sd}<small>%</small></div>
        <div class="gauge-sub">${esc(sdReset)}</div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------- Лимиты */

function renderLimits(pane, p) {
  const u = orgUsage(p);
  const ranges = [
    [6 * 3600e3, t('range.6h')],
    [24 * 3600e3, t('range.24h')],
    [7 * 86400e3, t('range.7d')],
    [30 * 86400e3, t('range.30d')],
  ];

  const others = S.state.profiles.map((pr) => ({ pr, u: orgUsage(pr) })).filter((x) => x.u);

  pane.innerHTML = `
    <div class="head">
      <div>
        <h1>${esc(t('lim.title'))}</h1>
        <div class="sub">${esc(p.account ? p.account.email : p.slot)}</div>
      </div>
      <div class="range" id="rangeSel">
        ${ranges.map(([ms, label]) => `<button data-ms="${ms}" class="${S.range === ms ? 'on' : ''}">${esc(label)}</button>`).join('')}
      </div>
    </div>

    ${
      u
        ? `<div class="card">${gaugesHtml(u)}</div>

    <div class="card">
      <div class="card-head">
        <h2>${esc(t('lim.history'))}</h2>
        <div class="legend">
          <span><i style="background:${C.accent}"></i>${esc(t('lim.fh'))}</span>
          <span><i style="background:${C.blue}"></i>${esc(t('lim.sd'))}</span>
        </div>
      </div>
      <div class="chart-wrap" id="chartWrap"></div>
      <div class="gauge-sub" style="margin-top:10px">
        ${esc(t('lim.samplesInfo', { n: nf.format(u.count), from: fmtDateTime(u.first), to: fmtDateTime(u.last) }))}
        ${esc(t('lim.gaps'))}
      </div>
    </div>

    <div class="card">
      <h2>${esc(t('lim.daily'))}</h2>
      <div id="dailyWrap"></div>
    </div>`
        : `<div class="note">${esc(S.plan && S.plan.ok === false ? errorText(S.plan) : t('lim.noOrgData'))}</div>`
    }

    ${
      others.length > 1
        ? `<div class="card">
      <h2>${esc(t('lim.compare'))}</h2>
      <table class="tbl">
        <thead><tr>
          <th>${esc(t('lim.col.profile'))}</th><th>${esc(t('lim.col.plan'))}</th>
          <th class="num">${esc(t('lim.fh'))}</th><th style="width:110px"></th>
          <th class="num">${esc(t('lim.sd'))}</th><th style="width:110px"></th>
          <th>${esc(t('lim.col.sample'))}</th>
        </tr></thead>
        <tbody>
          ${others
            .map(
              ({ pr, u: ou }) => `<tr class="${pr.slot === p.slot ? 'is-active' : ''}">
              <td>${esc(pr.label || pr.slot)}</td>
              <td><span class="badge ${planBadgeClass(pr.account && pr.account.plan)}">${esc((pr.account && pr.account.plan) || DASH)}</span></td>
              <td class="num">${ou.latest.fh}%</td>
              <td><span class="bar-track"><i style="width:${ou.latest.fh}%;background:${usageColor(ou.latest.fh)}"></i></span></td>
              <td class="num">${ou.latest.sd}%</td>
              <td><span class="bar-track"><i style="width:${ou.latest.sd}%;background:${C.blue}"></i></span></td>
              <td class="muted">${esc(relTime(ou.last))}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`
        : ''
    }

    <div class="note info"><div>${esc(t('lim.source'))}</div></div>`;

  $$('#rangeSel button').forEach((b) =>
    b.addEventListener('click', () => {
      S.range = Number(b.dataset.ms);
      render();
    })
  );

  if (u) {
    drawUsageChart($('#chartWrap'), u.series, S.range);
    drawDailyBars($('#dailyWrap'), u.dailyFh, S.range);
  }
}

function drawUsageChart(wrap, series, rangeMs) {
  if (!wrap) return;
  const W = Math.max(360, wrap.clientWidth);
  const H = 230;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 26;

  const now = Date.now();
  const pts = series.filter((s) => s.t >= now - rangeMs);

  if (pts.length < 2) {
    wrap.innerHTML = `<div class="empty" style="padding:30px">${esc(t('lim.noPeriodData'))}</div>`;
    return;
  }

  const tMin = pts[0].t;
  const tMax = Math.max(now, pts[pts.length - 1].t);
  const x = (ts) => padL + ((ts - tMin) / Math.max(1, tMax - tMin)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / 100) * (H - padT - padB);

  // разрыв линии там, где приложение было закрыто и замеры не писались
  const GAP = 45 * 60e3;
  const segments = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t > GAP) {
      segments.push(cur);
      cur = [];
    }
    cur.push(pts[i]);
  }
  segments.push(cur);

  const line = (key) =>
    segments
      .filter((sg) => sg.length > 1)
      .map(
        (sg) => `<polyline points="${sg.map((s) => `${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ')}"
        fill="none" stroke="${key === 'fh' ? C.accent : C.blue}" stroke-width="1.8"
        stroke-linejoin="round" stroke-linecap="round"/>`
      )
      .join('');

  const grid = [0, 25, 50, 75, 100]
    .map(
      (v) => `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="${C.grid}" stroke-width="1"/>
      <text x="${padL - 7}" y="${y(v) + 3.5}" text-anchor="end" fill="${C.axis}" font-size="10">${v}</text>`
    )
    .join('');

  const ticks = 5;
  const xAxis = Array.from({ length: ticks + 1 }, (_, i) => {
    const ts = tMin + ((tMax - tMin) * i) / ticks;
    const label = rangeMs > 3 * 86400e3
      ? new Date(ts).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' })
      : fmtTime(ts);
    return `<text x="${x(ts).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}"
      fill="${C.axis}" font-size="10">${label}</text>`;
  }).join('');

  wrap.innerHTML =
    `<svg id="usageSvg" width="${W}" height="${H}" style="display:block">
      ${grid}${xAxis}${line('sd')}${line('fh')}
      <line id="crosshair" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="${C.crosshair}" stroke-width="1" opacity="0"/>
      <circle id="dotFh" r="3.2" fill="${C.accent}" opacity="0"/>
      <circle id="dotSd" r="3.2" fill="${C.blue}" opacity="0"/>
    </svg><div class="chart-tip" id="chartTip"></div>`;

  const svg = $('#usageSvg', wrap);
  const tipEl = $('#chartTip', wrap);
  const cross = $('#crosshair', wrap);
  const dotFh = $('#dotFh', wrap);
  const dotSd = $('#dotSd', wrap);

  svg.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const ts = tMin + ((ev.clientX - rect.left - padL) / (W - padL - padR)) * (tMax - tMin);
    let best = pts[0];
    let bd = Infinity;
    for (const s of pts) {
      const d = Math.abs(s.t - ts);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    const bx = x(best.t);
    cross.setAttribute('x1', bx);
    cross.setAttribute('x2', bx);
    cross.setAttribute('opacity', '.7');
    dotFh.setAttribute('cx', bx);
    dotFh.setAttribute('cy', y(best.fh));
    dotFh.setAttribute('opacity', '1');
    dotSd.setAttribute('cx', bx);
    dotSd.setAttribute('cy', y(best.sd));
    dotSd.setAttribute('opacity', '1');
    tipEl.innerHTML = `${esc(fmtDateTime(best.t))}<br>
      <b style="color:${C.accent}">${best.fh}%</b> ${esc(t('lim.fh'))} ·
      <b style="color:${C.blue}">${best.sd}%</b> ${esc(t('lim.sd'))}`;
    tipEl.style.opacity = '1';
    const tw = tipEl.offsetWidth;
    tipEl.style.left = `${Math.max(0, Math.min(W - tw, bx - tw / 2))}px`;
    tipEl.style.top = `${Math.max(0, y(Math.max(best.fh, best.sd)) - 56)}px`;
  });

  svg.addEventListener('mouseleave', () => {
    tipEl.style.opacity = '0';
    cross.setAttribute('opacity', '0');
    dotFh.setAttribute('opacity', '0');
    dotSd.setAttribute('opacity', '0');
  });
}

function drawDailyBars(wrap, daily, rangeMs) {
  if (!wrap) return;
  const days = Math.max(7, Math.min(45, Math.round(rangeMs / 86400e3) || 14));
  const data = daily.slice(-days);
  if (!data.length) {
    wrap.innerHTML = `<div class="muted">${esc(t('lim.noPeriodData'))}</div>`;
    return;
  }

  const W = Math.max(360, wrap.clientWidth);
  const H = 130;
  const padB = 22;
  const gap = 3;
  const bw = Math.max(4, (W - gap * (data.length - 1)) / data.length);

  const bars = data
    .map((d, i) => {
      const h = Math.max(2, ((H - padB) * d.value) / 100);
      return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - padB - h).toFixed(1)}"
        width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"
        fill="${usageColor(d.value)}" opacity="${d.value ? 0.9 : 0.3}">
        <title>${esc(t('lim.peakTip', { day: fmtDay(d.day), v: d.value }))}</title></rect>`;
    })
    .join('');

  const labels = data
    .map((d, i) => {
      if (data.length > 16 && i % Math.ceil(data.length / 10) !== 0) return '';
      return `<text x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle"
        fill="${C.axis}" font-size="9.5">${esc(fmtDay(d.day))}</text>`;
    })
    .join('');

  wrap.innerHTML = `<svg width="${W}" height="${H}" style="display:block">${bars}${labels}</svg>`;
}

/* --------------------------------------------------------- Claude Code */

async function loadCli() {
  if (S.cliLoading) return;
  S.cliLoading = true;
  render();
  S.cli = await window.api.cliUsage();
  S.cliLoading = false;
  render();
}

function renderCode(pane) {
  if (S.cliLoading) {
    pane.innerHTML = `<div class="empty"><h3>${esc(t('code.calculating'))}</h3>
      <p id="cliProgress" class="muted">${esc(t('code.reading'))}</p></div>`;
    return;
  }

  if (!S.cli) {
    pane.innerHTML = `<div class="head"><div><h1>${esc(t('code.title'))}</h1></div></div>
      <div class="empty"><h3>${esc(t('code.calcTitle'))}</h3>
        <p class="muted">${esc(t('code.calcBody'))}</p>
        <p style="margin-top:14px"><button class="btn btn-primary" data-act="loadCli">${esc(t('code.calc'))}</button></p>
      </div>`;
    wireActions(pane);
    return;
  }

  if (!S.cli.ok) {
    pane.innerHTML = `<div class="empty"><h3>${esc(t('code.failed'))}</h3>
      <p>${esc(errorText(S.cli))}</p></div>`;
    return;
  }

  const c = S.cli;
  const tot = c.totals;

  pane.innerHTML = `
    <div class="head">
      <div>
        <h1>${esc(t('code.title'))}</h1>
        <div class="sub">${esc(t('code.sub', { files: nf.format(c.files), size: fmtBytes(c.bytes), n: nf.format(tot.messages) }))}</div>
      </div>
      <div class="head-actions">
        <div class="range" id="codeMode">
          <button data-mode="all" class="${S.codeMode === 'all' ? 'on' : ''}">${esc(t('code.all'))}</button>
          <button data-mode="nocache" class="${S.codeMode === 'nocache' ? 'on' : ''}">${esc(t('code.noCache'))}</button>
        </div>
        <button class="btn btn-ghost" data-act="loadCli">${esc(t('code.recalc'))}</button>
      </div>
    </div>

    <div class="note info"><div>${esc(t('code.note'))}</div></div>

    <div class="card">
      <h2>${esc(t('code.totals'))}</h2>
      <div class="grid">
        ${field(t('code.input'), nf.format(tot.input))}
        ${field(t('code.output'), nf.format(tot.output))}
        ${field(t('code.thinking'), nf.format(tot.thinking))}
        ${field(t('code.cacheWrite'), nf.format(tot.cacheWrite))}
        ${field(t('code.cacheRead'), nf.format(tot.cacheRead))}
        ${field(t('code.billable'), nf.format(tot.input + tot.output + tot.cacheWrite))}
      </div>
    </div>

    <div class="card">
      <h2>${esc(t('code.byDay'))}</h2>
      <div id="codeChart"></div>
    </div>

    <div class="two-col">
      <div class="card">
        <h2>${esc(t('code.byModel'))}</h2>
        <table class="tbl">
          <thead><tr><th>${esc(t('code.model'))}</th><th class="num">${esc(t('code.output'))}</th>
            <th class="num">${esc(t('code.input'))}</th><th class="num">${esc(t('code.answers'))}</th></tr></thead>
          <tbody>${c.models
            .map(
              (m) => `<tr><td class="mono">${esc(m.model)}</td>
              <td class="num">${fmtTok(m.output)}</td><td class="num">${fmtTok(m.input + m.cacheWrite)}</td>
              <td class="num">${nf.format(m.messages)}</td></tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>${esc(t('code.byProject'))}</h2>
        <table class="tbl">
          <thead><tr><th>${esc(t('code.project'))}</th><th class="num">${esc(t('code.output'))}</th>
            <th class="num">${esc(t('code.answers'))}</th></tr></thead>
          <tbody>${c.projects
            .map(
              (pr) => `<tr><td>${esc(pr.project)}</td>
              <td class="num">${fmtTok(pr.output)}</td><td class="num">${nf.format(pr.messages)}</td></tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
    </div>`;

  $$('#codeMode button').forEach((b) =>
    b.addEventListener('click', () => {
      S.codeMode = b.dataset.mode;
      render();
    })
  );
  wireActions(pane);
  drawCodeChart($('#codeChart'), c.days.slice(-30));
}

function drawCodeChart(wrap, days) {
  if (!wrap || !days.length) return;
  const W = Math.max(360, wrap.clientWidth);
  const H = 190;
  const padB = 24;
  const gap = 4;
  const bw = Math.max(5, (W - gap * (days.length - 1)) / days.length);

  const parts = [
    ['output', C.accent],
    ['input', C.sand],
    ['cacheWrite', C.blue],
    ['cacheRead', C.deep],
  ].filter(([key]) => S.codeMode !== 'nocache' || key !== 'cacheRead');

  const total = (d) => parts.reduce((sum, [key]) => sum + d[key], 0);
  const max = Math.max(1, ...days.map(total));

  const bars = days
    .map((d, i) => {
      const xx = i * (bw + gap);
      let acc = 0;
      const segs = parts
        .map(([key, color]) => {
          if (!d[key]) return '';
          const h = ((H - padB) * d[key]) / max;
          const yy = H - padB - acc - h;
          acc += h;
          return `<rect x="${xx.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.6, h).toFixed(1)}" fill="${color}"/>`;
        })
        .join('');
      const tip = parts.map(([key]) => `${t(`code.legend.${key}`)}: ${fmtTok(d[key])}`).join('\n');
      return `<g><title>${esc(fmtDay(d.day))}\n${esc(tip)}\n${esc(t('code.max', { v: fmtTok(total(d)) }))}</title>${segs}</g>`;
    })
    .join('');

  const labels = days
    .map((d, i) => {
      if (days.length > 16 && i % Math.ceil(days.length / 10) !== 0) return '';
      return `<text x="${(i * (bw + gap) + bw / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" fill="${C.axis}" font-size="9.5">${esc(fmtDay(d.day))}</text>`;
    })
    .join('');

  const legend = parts.map(([key, color]) => `<span><i style="background:${color}"></i>${esc(t(`code.legend.${key}`))}</span>`).join('');

  wrap.innerHTML =
    `<div class="legend" style="margin-bottom:10px">${legend}<span class="spacer"></span>
      <span class="muted">${esc(t('code.max', { v: fmtTok(max) }))}</span></div>` +
    `<svg width="${W}" height="${H}" style="display:block">${bars}${labels}</svg>`;
}

/* ------------------------------------------------------------ действия */

function wireActions(root) {
  $$('[data-act]', root).forEach((el) => el.addEventListener('click', () => handleAction(el.dataset)));
}

async function handleAction(d) {
  if (S.busy) return;

  switch (d.act) {
    case 'launch': {
      const res = await window.api.launchClaude();
      toast(res.ok ? t('toast.launching') : errorText({ code: res.error }), res.ok ? 'ok' : 'err');
      return;
    }

    case 'close': {
      S.busy = true;
      toast(t('toast.closing'));
      const res = await window.api.closeClaude();
      S.busy = false;
      toast(res.ok ? t('toast.closed') : errorText(res), res.ok ? 'ok' : 'err');
      refresh({ silent: true });
      return;
    }

    case 'switch':
      await doSwitch(d.slot);
      return;

    case 'openStore': {
      const p = S.state.profiles.find((x) => x.slot === d.slot);
      if (p) await window.api.openPath(p.storeDir);
      return;
    }

    case 'loadCli':
      loadCli();
      return;

    case 'adopt': {
      const created = await ui.prompt({
        title: t('onb.title'),
        message: t('onb.name'),
        value: 'acc1',
        confirmText: t('common.create'),
        cancelText: t('common.cancel'),
        // The action runs inside validate so a rejected name keeps the dialog open.
        validate: async (value) => {
          const res = await window.api.adoptProfile(value.trim());
          if (!res.ok) return errorText(res);
          S.selected = res.slot;
          return null;
        },
      });
      if (created !== null) refresh({ silent: true });
      return;
    }

    case 'rename': {
      const p = S.state.profiles.find((x) => x.slot === d.slot);
      if (!p) return;
      const label = await ui.prompt({
        title: t('modal.renameTitle'),
        message: t('modal.renameHint', { slot: p.slot }),
        value: p.label || '',
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      });
      if (label === null) return;
      await window.api.setProfileMeta(p.slot, { label: label.trim() || null });
      refresh({ silent: true });
      return;
    }

    case 'delete': {
      const p = S.state.profiles.find((x) => x.slot === d.slot);
      if (!p) return;
      const confirmed = await ui.confirm({
        title: t('dlg.deleteTitle'),
        message: t('dlg.deleteMsg', { slot: p.slot }),
        detail: t('dlg.deleteDetail'),
        confirmText: t('common.delete'),
        cancelText: t('common.cancel'),
        danger: true,
      });
      if (!confirmed) return;
      const res = await window.api.deleteProfile(p.slot);
      toast(res.ok ? t('toast.deleted') : errorText(res), res.ok ? 'ok' : 'err');
      refresh({ silent: true });
    }
  }
}

async function doSwitch(slot) {
  const running = S.state.claude && S.state.claude.running;
  let autoClose = false;

  if (running) {
    const confirmed = await ui.confirm({
      title: t('dlg.switchTitle'),
      message: t('dlg.switchMsg'),
      detail: t('dlg.switchDetail'),
      confirmText: t('dlg.switchOk'),
      cancelText: t('common.cancel'),
    });
    if (!confirmed) return;
    autoClose = true;
  }

  S.busy = true;
  toast(t('toast.switching', { slot }));
  const res = await window.api.switchProfile(slot, autoClose);
  S.busy = false;

  if (res.ok) toast(t(res.unchanged ? 'toast.alreadyActive' : 'toast.switched', { slot }), 'ok');
  else toast(errorText(res), 'err');

  setTimeout(() => refresh({ silent: true }), 600);
}

/* ---------------------------------------------------------------- start */

/** A switch asked for from the tray, confirmed here so the dialog matches the app. */
function runTraySwitch(slot) {
  if (!S.state || !S.state.profiles.some((p) => p.slot === slot)) return;
  S.selected = slot;
  S.tab = 'overview';
  render();
  doSwitch(slot);
}

async function init() {
  // Registered before the first await so a tray request during startup is not lost.
  let pendingSwitch = null;
  window.api.onSwitchRequest((slot) => {
    if (!S.state) pendingSwitch = slot;
    else runTraySwitch(slot);
  });

  applyTheme(await window.api.theme());
  await loadDict();

  $('#winMin').addEventListener('click', () => window.api.win.minimize());
  $('#winMax').addEventListener('click', () => window.api.win.maximize());
  $('#winClose').addEventListener('click', () => window.api.win.close());
  $('#btnRefresh').addEventListener('click', () => refresh());
  $('#btnSettings').addEventListener('click', () => window.api.openSettings());

  $$('.tab').forEach((tb) =>
    tb.addEventListener('click', () => {
      S.tab = tb.dataset.tab;
      render();
      if (S.tab === 'code' && !S.cli && !S.cliLoading) loadCli();
    })
  );

  $('#btnAdd').addEventListener('click', async () => {
    let created = null;
    const value = await ui.prompt({
      title: t('modal.newTitle'),
      message: t('modal.newHint'),
      value: '',
      confirmText: t('common.create'),
      cancelText: t('common.cancel'),
      validate: async (name) => {
        const res = await window.api.addProfile(name);
        if (!res.ok) return errorText(res);
        created = res.slot;
        return null;
      },
    });
    if (value === null || !created) return;
    S.selected = created;
    toast(t('toast.created', { slot: created }), 'ok');
    refresh({ silent: true });
  });

  window.api.onClaudeState((st) => {
    paintClaudeState(st);
    if (S.tab === 'overview') render();
  });
  window.api.onUsageChanged(async () => {
    S.plan = await window.api.planUsage();
    render();
  });
  window.api.onProfilesChanged(() => refresh({ silent: true }));
  window.api.onLanguageChanged((payload) => {
    DICT = payload.dict;
    LOCALE = payload.locale;
    nf = new Intl.NumberFormat(LOCALE);
    applyStaticI18n();
    render();
  });
  window.api.onThemeChanged((payload) => {
    applyTheme(payload);
    render();
  });
  window.api.onNavigate((tab) => {
    if (!['overview', 'limits', 'code'].includes(tab)) return;
    S.tab = tab;
    render();
    if (tab === 'code' && !S.cli && !S.cliLoading) loadCli();
  });
  window.api.onCliProgress(({ done, total }) => {
    const el = $('#cliProgress');
    if (el) el.textContent = t('code.progress', { done, total });
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (S.tab === 'limits' || S.tab === 'code') render();
    }, 180);
  });

  await refresh();
  if (pendingSwitch) runTraySwitch(pendingSwitch);
  setInterval(() => refresh({ silent: true }), 60000);
}

init();

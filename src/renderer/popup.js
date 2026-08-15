'use strict';

/* The tray flyout: account, usage bars and quick profile switching. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let DICT = {};
let LOCALE = 'en-US';
let data = null;

const t = (key, params) => {
  const s = DICT[key];
  if (s == null) return key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTime = (v) => new Date(v).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (v) => new Date(v).toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function fmtDuration(ms) {
  if (ms == null || ms < 0) return '';
  const unit = (v, n) => new Intl.NumberFormat(LOCALE, { style: 'unit', unit: n, unitDisplay: 'short' }).format(v);
  const m = Math.round(ms / 60000);
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rest = m % 60;
    return rest ? `${unit(h, 'hour')} ${unit(rest, 'minute')}` : unit(h, 'hour');
  }
  return unit(Math.floor(h / 24), 'day');
}

function usageColor(pct) {
  const cs = getComputedStyle(document.documentElement);
  const pick = (n, fb) => (cs.getPropertyValue(n) || fb).trim();
  if (pct >= 90) return pick('--danger', '#d9605a');
  if (pct >= 70) return pick('--warn', '#e0a458');
  return pick('--accent', '#d97757');
}

function applyTheme(payload) {
  document.documentElement.dataset.theme = payload && payload.dark === false ? 'light' : 'dark';
}

/** One labelled progress row: percentage, bar, and the reset caption. */
function meter(label, pct, caption, color, tag) {
  return `<div class="meter">
    <div class="meter-top">
      <span class="meter-label">${esc(label)}</span>
      <span class="meter-pct">${pct}%</span>
    </div>
    <div class="meter-track"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></i></div>
    ${caption ? `<div class="meter-sub">${esc(caption)}${tag ? ` <span class="src-tag">${esc(tag)}</span>` : ''}</div>` : ''}
  </div>`;
}

function fhCaption(u, api) {
  const exact = api && api.fiveHour && api.fiveHour.resetAt;
  if (exact) {
    const d = exact - Date.now();
    return { text: d > 0 ? t('lim.resetExactIn', { when: fmtDateTime(exact), dur: fmtDuration(d) }) : t('lim.resetExact', { when: fmtDateTime(exact) }), tag: t('lim.viaApi') };
  }
  if (!u.fiveHour.known) return { text: t('lim.notStarted'), tag: null };
  return {
    text: t('lim.resetBefore', { time: fmtTime(u.fiveHour.resetBefore), dur: fmtDuration(u.fiveHour.resetBefore - Date.now()) }),
    tag: null,
  };
}

function sdCaption(u, api) {
  const exact = api && api.weekly && api.weekly.resetAt;
  if (exact) return { text: t('lim.resetExact', { when: fmtDateTime(exact) }), tag: t('lim.viaApi') };
  if (!u.weekly.known) return { text: t('lim.resetUnknown'), tag: null };
  if (u.weekly.exact) return { text: t('lim.resetExact', { when: fmtDateTime(u.weekly.resetAt) }), tag: null };
  return { text: t('lim.resetBeforeAt', { when: fmtDateTime(u.weekly.resetAt) }), tag: null };
}

function render() {
  const body = $('#popupBody');
  if (!data) {
    body.innerHTML = `<div class="popup-empty">${esc(t('common.loading'))}</div>`;
    return;
  }

  const active = data.profiles.find((p) => p.isActive) || null;
  const u = active && active.org ? data.orgs[active.org] : null;
  const api = active && active.org && data.api[active.org] && data.api[active.org].ok ? data.api[active.org] : null;

  const account = active
    ? `<div class="popup-sec">${esc(t('ov.account'))}</div>
       <div class="popup-row"><span>${esc(t('lim.col.profile'))}</span><b>${esc(active.label || active.slot)}</b></div>
       ${active.email ? `<div class="popup-row"><span>Email</span><b>${esc(active.email)}</b></div>` : ''}
       ${active.plan ? `<div class="popup-row"><span>${esc(t('ov.plan'))}</span><b>${esc(active.plan)}</b></div>` : ''}`
    : `<div class="popup-empty">${esc(t('tray.noProfile'))}</div>`;

  const usage = u
    ? `<div class="popup-sec">${esc(t('ov.limits'))}</div>
       ${(() => {
         const c = fhCaption(u, api);
         const v = api && api.fiveHour ? api.fiveHour.value : u.latest.fh;
         return meter(t('lim.fh'), v, c.text, usageColor(v), c.tag);
       })()}
       ${(() => {
         const c = sdCaption(u, api);
         const v = api && api.weekly ? api.weekly.value : u.latest.sd;
         const cs = getComputedStyle(document.documentElement);
         return meter(t('lim.sd'), v, c.text, (cs.getPropertyValue('--blue') || '#7ba7d7').trim(), c.tag);
       })()}`
    : `<div class="popup-sec">${esc(t('ov.limits'))}</div><div class="popup-empty">${esc(t('ov.noSamples'))}</div>`;

  const others = data.profiles.filter((p) => !p.isActive);
  const switcher = others.length
    ? `<div class="popup-sec">${esc(t('tray.switchTo'))}</div>
       ${others
         .map(
           (p) => `<button class="popup-switch" data-slot="${esc(p.slot)}">
             <span class="ps-name">${esc(p.label || p.slot)}</span>
             <span class="ps-mail">${esc(p.email || t('side.notConfigured'))}</span>
             ${p.plan ? `<span class="badge">${esc(p.plan)}</span>` : ''}
           </button>`
         )
         .join('')}`
    : '';

  const running = data.claude && data.claude.running;
  const status = `<div class="popup-status ${running ? 'on' : 'off'}">
      <span class="dot"></span>${esc(running ? t('claude.running', { n: data.claude.count }) : t('claude.stopped'))}
    </div>`;

  const versions = (data.versions || []).length
    ? `<div class="popup-sec">${esc(t('ver.title'))}</div>` +
      data.versions
        .map((v) => `<div class="popup-row"><span>${esc(v.label)}</span><b class="mono">${esc(v.version)}</b></div>`)
        .join('')
    : '';

  body.innerHTML = status + account + usage + switcher + versions;

  $$('.popup-switch', body).forEach((el) =>
    el.addEventListener('click', async () => {
      el.disabled = true;
      await window.api.popupSwitch(el.dataset.slot);
      load();
    })
  );
}

async function load() {
  try {
    data = await window.api.popupData();
  } catch {
    data = null;
  }
  render();
}

async function init() {
  applyTheme(await window.api.theme());
  const payload = await window.api.dict();
  DICT = payload.dict;
  LOCALE = payload.locale;
  document.documentElement.lang = LOCALE.slice(0, 2);
  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$('[data-title]').forEach((el) => el.setAttribute('title', t(el.dataset.title)));

  $('#pClose').addEventListener('click', () => window.api.popupHide());
  $('#pSettings').addEventListener('click', () => {
    window.api.popupHide();
    window.api.openSettings();
  });
  $('#pOpen').addEventListener('click', () => {
    window.api.popupHide();
    window.api.openMain();
  });
  $('#pLaunch').addEventListener('click', () => {
    window.api.launchClaude();
    window.api.popupHide();
  });
  $('#pQuit').addEventListener('click', () => window.api.quitApp());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.api.popupHide();
  });

  window.api.onPopupRefresh(load);
  window.api.onThemeChanged(applyTheme);
  window.api.onClaudeState(() => load());
  window.api.onUsageChanged(() => load());

  load();
}

init();

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

/** Ticking countdown: seconds matter inside the last hour, and only there. */
function fmtCountdown(ms) {
  if (ms == null || ms < 0) return '';
  const unit = (v, n) => new Intl.NumberFormat(LOCALE, { style: 'unit', unit: n, unitDisplay: 'short' }).format(v);

  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  if (days >= 1) {
    const hours = Math.floor((total % 86400) / 3600);
    return hours ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours >= 1) return minutes ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
  const seconds = total % 60;
  return minutes ? `${unit(minutes, 'minute')} ${unit(seconds, 'second')}` : unit(seconds, 'second');
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

// Marks where the ticking countdown goes; an invisible separator survives
// escaping, which a placeholder like {dur} would not.
const CD = '⁣';

/**
 * One labelled progress row: percentage, bar with the pace marker at the
 * elapsed fraction of the window, and the reset caption.
 */
function meter(label, pct, caption, color, pace) {
  const mark =
    pace && pace.elapsed != null
      ? `<b class="pace-mark" style="left:${(Math.max(0, Math.min(1, pace.elapsed)) * 100).toFixed(1)}%"></b>`
      : '';
  return `<div class="meter">
    <div class="meter-top">
      <span class="meter-label">${esc(label)}</span>
      <span class="meter-pct">${pct}%</span>
    </div>
    <div class="meter-track"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></i>${mark}</div>
    ${caption ? `<div class="meter-sub">${captionHtml(caption)}</div>` : ''}
  </div>`;
}

function captionHtml(c) {
  if (!c || !c.text) return '';
  let html = esc(c.text);
  if (c.until) {
    html = html.replace(CD, `<span class="cd" data-until="${c.until}">${esc(fmtCountdown(c.until - Date.now()))}</span>`);
  }
  return `${html}${c.tag ? ` <span class="src-tag">${esc(c.tag)}</span>` : ''}`;
}

function sourceTag(source) {
  if (source === 'code') return t('lim.viaCode');
  if (source === 'api') return t('lim.viaApi');
  return null;
}

function fhCaption(u) {
  const e = u.exact && u.exact.fh;
  if (e && e.resetAt) {
    return { text: t('lim.resetExactIn', { when: fmtDateTime(e.resetAt), dur: CD }), tag: sourceTag(e.source), until: e.resetAt };
  }
  if (!u.fiveHour.known) return { text: t('lim.notStarted') };
  return { text: t('lim.resetBefore', { time: fmtTime(u.fiveHour.resetBefore), dur: CD }), until: u.fiveHour.resetBefore };
}

function sdCaption(u) {
  const e = u.exact && u.exact.sd;
  if (e && e.resetAt) {
    return { text: t('lim.resetExactIn', { when: fmtDateTime(e.resetAt), dur: CD }), tag: sourceTag(e.source), until: e.resetAt };
  }
  if (!u.weekly.known) return { text: t('lim.resetUnknown') };
  if (u.weekly.exact) return { text: t('lim.resetExactIn', { when: fmtDateTime(u.weekly.resetAt), dur: CD }), until: u.weekly.resetAt };
  return { text: t('lim.resetBeforeAt', { when: fmtDateTime(u.weekly.resetAt) }) };
}

function render() {
  const body = $('#popupBody');
  if (!data) {
    body.innerHTML = `<div class="popup-empty">${esc(t('common.loading'))}</div>`;
    return;
  }

  const active = data.profiles.find((p) => p.isActive) || null;
  const u = active && active.org ? data.orgs[active.org] : null;

  const account = active
    ? `<div class="popup-sec">${esc(t('ov.account'))}</div>
       <div class="popup-row"><span>${esc(t('lim.col.profile'))}</span><b>${esc(active.label || active.slot)}</b></div>
       ${active.email ? `<div class="popup-row"><span>Email</span><b>${esc(active.email)}</b></div>` : ''}
       ${active.plan ? `<div class="popup-row"><span>${esc(t('ov.plan'))}</span><b>${esc(active.plan)}</b></div>` : ''}`
    : `<div class="popup-empty">${esc(t('tray.noProfile'))}</div>`;

  const pace = (u && u.pace) || {};
  const usage = u
    ? `<div class="popup-sec">${esc(t('ov.limits'))}</div>
       ${(() => {
         const v = u.exact && u.exact.fh ? u.exact.fh.value : u.latest.fh;
         return meter(t('lim.fh'), v, fhCaption(u), usageColor(v), pace.fh);
       })()}
       ${(() => {
         const v = u.exact && u.exact.sd ? u.exact.sd.value : u.latest.sd;
         const cs = getComputedStyle(document.documentElement);
         return meter(t('lim.sd'), v, sdCaption(u), (cs.getPropertyValue('--blue') || '#7ba7d7').trim(), pace.sd);
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

  // One shared tick drives every countdown; a window running out reloads the
  // panel, because the figures behind it are stale the moment it does.
  setInterval(() => {
    const now = Date.now();
    let expired = false;
    $$('[data-until]').forEach((el) => {
      const left = Number(el.dataset.until) - now;
      if (left > 0) {
        el.textContent = fmtCountdown(left);
        return;
      }
      el.textContent = t('lim.resetNow');
      el.removeAttribute('data-until');
      expired = true;
    });
    if (expired) load();
  }, 1000);

  load();
}

init();

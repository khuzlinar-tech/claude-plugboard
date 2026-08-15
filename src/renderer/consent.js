'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let DICT = {};

const t = (key) => (DICT[key] == null ? key : DICT[key]);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Order matters: the practical rules come before the legal boilerplate.
const SECTIONS = ['personalUse', 'rules', 'unofficial', 'local', 'ai', 'warranty'];

function applyTheme(payload) {
  document.documentElement.dataset.theme = payload && payload.dark === false ? 'light' : 'dark';
}

function render() {
  $('#items').innerHTML = SECTIONS.map(
    (id) => `<section class="consent-item">
      <h2>${esc(t(`consent.${id}.h`))}</h2>
      <p>${esc(t(`consent.${id}.b`))}</p>
    </section>`
  ).join('');

  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$('[data-title]').forEach((el) => el.setAttribute('title', t(el.dataset.title)));
  document.title = t('consent.title');
}

async function init() {
  const [payload, theme, mode] = await Promise.all([
    window.api.dict(),
    window.api.theme(),
    window.api.consent.mode(),
  ]);

  DICT = payload.dict;
  document.documentElement.lang = payload.locale.slice(0, 2);
  applyTheme(theme);
  render();

  const gate = mode.gate;
  if (!gate) {
    // Opened from Settings for reference: no acceptance needed.
    $('#acceptWrap').classList.add('hidden');
    $('#btnDecline').classList.add('hidden');
    $('#btnAgree').disabled = false;
    $('#btnAgree').textContent = t('tb.close');
  }

  $('#acceptBox').addEventListener('change', (e) => {
    $('#btnAgree').disabled = !e.target.checked;
  });

  $('#btnAgree').addEventListener('click', () => {
    if (gate) window.api.consent.accept();
    else window.api.win.close();
  });

  $('#btnDecline').addEventListener('click', () => window.api.consent.decline());
  $('#winClose').addEventListener('click', () => window.api.win.close());

  window.api.onThemeChanged(applyTheme);
  window.api.onLanguageChanged((data) => {
    DICT = data.dict;
    render();
  });
}

init();

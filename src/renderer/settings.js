'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = { tab: 'general', cfg: null, info: null, claude: null, state: null, langs: [], tokens: [] };

/** Per-profile token availability, for the live-usage section. */
async function loadTokens() {
  S.cfg = await window.api.config.get();
  S.state = await window.api.getState();
  S.tokens = await Promise.all(
    S.state.profiles.map(async (p) => {
      const st = await window.api.apiTokenState(p.slot);
      return Object.assign({ slot: p.slot, label: p.label || p.slot, isActive: p.isActive }, st);
    })
  );
}

let DICT = {};
let LOCALE = 'en-US';

const t = (key, params) => {
  const s = DICT[key];
  if (s == null) return key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind || ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2400);
}

function applyTheme(payload) {
  document.documentElement.dataset.theme = payload && payload.dark === false ? 'light' : 'dark';
}

/* ------------------------------------------------------------- controls */

function toggle(key, label, hint, opts = {}) {
  return `
    <label class="row ${opts.disabled ? 'row-disabled' : ''}">
      <div class="row-text">
        <div class="row-t">${esc(label)}</div>
        ${hint ? `<div class="row-h">${esc(hint)}</div>` : ''}
      </div>
      <span class="switch">
        <input type="checkbox" data-cfg="${esc(key)}" ${S.cfg[key] ? 'checked' : ''} ${opts.disabled ? 'disabled' : ''}>
        <i></i>
      </span>
    </label>`;
}

function numberRow(key, label, min, max) {
  return `
    <label class="row">
      <div class="row-text"><div class="row-t">${esc(label)}</div></div>
      <input class="input input-num" type="number" min="${min}" max="${max}"
             value="${esc(S.cfg[key])}" data-cfg-num="${esc(key)}">
    </label>`;
}

function selectRow(key, label, options) {
  const opts = options
    .map((o) => `<option value="${esc(o.value)}" ${S.cfg[key] === o.value ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('');
  return `
    <label class="row">
      <div class="row-text"><div class="row-t">${esc(label)}</div></div>
      <select class="input input-sel" data-cfg-sel="${esc(key)}">${opts}</select>
    </label>`;
}

function section(title, body) {
  return `<div class="card"><h2>${esc(title)}</h2>${body}</div>`;
}

function pathRow(label, value, target) {
  return `
    <div class="row">
      <div class="row-text">
        <div class="row-t">${esc(label)}</div>
        <div class="row-h mono">${esc(value)}</div>
      </div>
      ${target ? `<button class="btn btn-sm" data-open="${esc(target)}">${esc(t('set.open'))}</button>` : ''}
    </div>`;
}

/* --------------------------------------------------------------- panels */

function render() {
  $$('.tab').forEach((tb) => tb.classList.toggle('is-active', tb.dataset.tab === S.tab));
  const pane = $('#pane');
  if (!S.cfg) {
    pane.innerHTML = `<div class="empty">${esc(t('common.loading'))}</div>`;
    return;
  }

  if (S.tab === 'general') renderGeneral(pane);
  else if (S.tab === 'claude') renderClaude(pane);
  else if (S.tab === 'paths') renderPaths(pane);
  else renderAbout(pane);

  wire(pane);
}

function renderGeneral(pane) {
  const languages = S.langs.map((l) => ({
    value: l.code,
    label: l.code === 'auto' ? t('common.auto') : l.nativeName,
  }));

  const themes = ['system', 'dark', 'light'].map((v) => ({ value: v, label: t(`theme.${v}`) }));
  const autoStartHint = S.info && S.info.autoStartSupported ? t('set.autoStartHint') : t('set.autoStartDev');

  pane.innerHTML =
    section(t('set.interface'), selectRow('language', t('set.language'), languages) + selectRow('theme', t('set.theme'), themes)) +
    section(
      t('set.startup'),
      toggle('autoStart', t('set.autoStart'), autoStartHint, { disabled: !(S.info && S.info.autoStartSupported) }) +
        toggle('startMinimized', t('set.startMinimized'))
    ) +
    section(
      t('set.tray'),
      toggle('closeToTray', t('set.closeToTray')) + toggle('minimizeToTray', t('set.minimizeToTray'), t('set.trayHint'))
    ) +
    section(
      t('set.trayIcon'),
      selectRow(
        'trayStyle',
        t('set.trayStyle'),
        ['icon', 'bar', 'percent', 'battery'].map((v) => ({ value: v, label: t(`trayStyle.${v}`) }))
      ) +
        (S.cfg.trayStyle !== 'icon'
          ? selectRow(
              'trayMetric',
              t('set.trayMetric'),
              ['fh', 'sd'].map((v) => ({ value: v, label: t(`trayMetric.${v}`) }))
            ) + toggle('trayMono', t('set.trayMono'), t('set.trayHintIcon'))
          : '')
    ) +
    section(
      t('set.notifications'),
      toggle('notifications', t('set.notifyEnabled'), t('set.notifyHint')) +
        toggle('notifyOnReset', t('set.notifyReset')) +
        numberRow('notifyThreshold', t('set.notifyThreshold'), 50, 100) +
        `<label class="row">
          <div class="row-text">
            <div class="row-t">${esc(t('set.notifyExtra'))}</div>
            <div class="row-h">${esc(t('set.notifyExtraHint'))}</div>
          </div>
          <input class="input input-sel" data-cfg-list="notifyThresholdsExtra"
                 value="${esc((S.cfg.notifyThresholdsExtra || []).join(', '))}" placeholder="75, 95">
        </label>`
    ) +
    section(
      t('set.behaviour'),
      toggle('launchAfterSwitch', t('set.launchAfterSwitch')) + numberRow('pollIntervalSec', t('set.pollInterval'), 2, 60)
    );
}

function renderClaude(pane) {
  const c = S.claude || { found: [], active: null, override: null, cli: {} };
  const override = S.cfg.claudeApp;

  const options = [
    {
      id: 'auto',
      label: t('set.useAuto'),
      hint: c.found.length ? c.found[0].label : t('set.noneDetected'),
      checked: !override,
    },
  ].concat(
    c.found.map((f) => ({
      id: f.kind === 'store' ? `store:${f.appId}` : `exe:${f.path}`,
      label: f.label,
      hint: f.kind === 'store' ? f.appId : f.path,
      checked:
        !!override &&
        ((override.kind === 'store' && override.appId === f.appId) ||
          (override.kind === 'exe' && override.path === f.path)),
    }))
  );

  if (override && override.kind === 'exe' && !c.found.some((f) => f.path === override.path)) {
    options.push({ id: `exe:${override.path}`, label: t('set.current'), hint: override.path, checked: true });
  }

  const installs = options
    .map(
      (o) => `<label class="row row-pick">
        <div class="row-text">
          <div class="row-t">${esc(o.label)}</div>
          <div class="row-h mono">${esc(o.hint)}</div>
        </div>
        <input type="radio" name="claudeApp" value="${esc(o.id)}" ${o.checked ? 'checked' : ''}>
      </label>`
    )
    .join('');

  const scopes = ['both', 'desktop', 'code']
    .map(
      (v) => `<label class="row row-pick">
        <div class="row-text"><div class="row-t">${esc(t(`scope.${v}`))}</div></div>
        <input type="radio" name="switchScope" value="${esc(v)}" ${S.cfg.switchScope === v ? 'checked' : ''}>
      </label>`
    )
    .join('');

  const apiModes = ['off', 'active', 'all']
    .map(
      (v) => `<label class="row row-pick">
        <div class="row-text">
          <div class="row-t">${esc(t(`apiMode.${v}`))}</div>
          ${v === 'all' ? `<div class="row-h" style="color:var(--warn)">${esc(t('set.apiAllWarning'))}</div>` : ''}
        </div>
        <input type="radio" name="apiMode" value="${esc(v)}" ${S.cfg.apiMode === v ? 'checked' : ''}>
      </label>`
    )
    .join('');

  // Status per profile, worded so the normal path (sign into Claude Code) reads
  // as the answer and pasting a token stays a fallback.
  const tokenRows = (S.tokens || [])
    .map((x) => {
      let state;
      let cls = 'ok';
      if (x.hasManual) state = t('set.apiTokenManual');
      else if (x.hasCode && !x.codeExpired) state = t('set.apiTokenFound');
      else if (x.hasCode) {
        state = t('set.apiTokenExpiredShort');
        cls = 'warn';
      } else {
        state = t('set.apiTokenMissing');
        cls = 'warn';
      }
      return `<div class="row">
        <div class="row-text">
          <div class="row-t">${esc(x.label)}${x.isActive ? ` <span class="badge badge-active">${esc(t('side.active'))}</span>` : ''}</div>
          <div class="row-h token-${cls}">${esc(state)}</div>
        </div>
        <div class="head-actions">
          ${x.hasManual ? `<button class="btn btn-sm btn-ghost" data-token-clear="${esc(x.slot)}">${esc(t('set.apiTokenClear'))}</button>` : ''}
        </div>
      </div>`;
    })
    .join('');

  const tokenBlock = `
    <div style="margin-top:14px">
      <div class="row-t" style="margin-bottom:6px">${esc(t('set.apiToken'))}</div>
      ${tokenRows}
      <div class="row-h" style="margin-top:10px">${esc(t('set.apiTokenHow'))}</div>
      <div class="row-h" style="margin-top:4px">${esc(t('set.apiTokenSwitchNote'))}</div>
      <div class="head-actions" style="margin-top:10px">
        <button class="btn btn-sm btn-primary" data-act="openTerminal">${esc(t('set.apiTokenOpenTerminal'))}</button>
        <button class="btn btn-sm" data-act="recheckTokens">${esc(t('set.apiTokenRecheck'))}</button>
      </div>
      <details class="advanced">
        <summary>${esc(t('set.apiTokenAdvanced'))}</summary>
        <div class="row-h" style="margin:8px 0 10px">${esc(t('set.apiTokenWhere'))}</div>
        <div class="head-actions">
          ${(S.tokens || [])
            .map((x) => `<button class="btn btn-sm" data-token-set="${esc(x.slot)}">${esc(x.label)}: ${esc(t('set.apiTokenEnter'))}</button>`)
            .join('')}
        </div>
      </details>
    </div>`;

  pane.innerHTML =
    section(
      t('set.liveUsage'),
      apiModes +
        `<div class="row-h" style="margin-top:10px">${esc(t('set.apiModeHint'))}</div>` +
        (S.cfg.apiMode !== 'off' ? tokenBlock : '')
    ) +
    section(
      t('set.scope'),
      scopes +
        `<div class="row-h" style="margin-top:10px">${esc(t('set.scopeHint'))}</div>
         <div class="row-h" style="margin-top:8px">
           ${c.cli && c.cli.present ? esc(t('set.cliDetected')) : esc(t('set.cliMissing'))}
           <span class="mono">${esc((c.cli && c.cli.dir) || '')}</span>
         </div>`
    ) +
    section(
      t('set.calibration'),
      `<div class="row"><div class="row-text"><div class="row-h">${esc(t('set.calibrationHint'))}</div></div></div>`
    ) +
    section(t('set.claudeApp'), installs) +
    `<div class="card">
      <div class="head-actions">
        <button class="btn btn-sm" data-act="recheck">${esc(t('set.recheck'))}</button>
        <button class="btn btn-sm" data-act="chooseExe">${esc(t('set.chooseExe'))}</button>
      </div>
      <div class="row-h" style="margin-top:12px">${esc(t('set.claudeHint'))}</div>
    </div>`;
}

function renderPaths(pane) {
  const p = S.state.paths;
  const sw = S.state.switched;

  pane.innerHTML =
    section(
      t('set.paths'),
      pathRow(t('set.profilesDir'), p.profilesDir, 'profilesDir') +
        pathRow(t('set.claudeAppData'), p.claudeAppData, 'claudeAppData') +
        pathRow(t('set.usageHistory'), p.usageHistory, null) +
        pathRow(t('set.projectsDir'), p.projectsDir, 'projectsDir') +
        pathRow(t('set.settingsFile'), p.settingsFile, 'settingsFile')
    ) +
    section(
      t('set.switched'),
      `<div class="row"><div class="row-text">
         <div class="row-t mono">${esc(p.claudeAppData)}</div>
         <div class="row-h">${sw.appItems.map((i) => `<span class="badge">${esc(i)}</span>`).join(' ')}</div>
       </div></div>
       <div class="row"><div class="row-text">
         <div class="row-t mono">${esc(p.claudeDir)}</div>
         <div class="row-h">${sw.claudeDirItems.map((i) => `<span class="badge">${esc(i)}</span>`).join(' ')}</div>
       </div></div>
       <div class="row"><div class="row-text">
         <div class="row-t mono">~</div>
         <div class="row-h">${sw.homeItems.map((i) => `<span class="badge">${esc(i)}</span>`).join(' ')}</div>
       </div></div>
       <div class="row-h" style="margin-top:10px">${esc(t('set.switchedHint'))}</div>`
    ) +
    section(
      t('set.notSwitched'),
      `<div class="row"><div class="row-text">
        <div class="row-t mono">plan-usage-history.json</div>
        <div class="row-h">${esc(t('set.notSwitchedHint'))}</div>
      </div></div>`
    );
}

function renderAbout(pane) {
  const i = S.info || {};
  const repo = i.repo && /^https:\/\//.test(i.repo) ? i.repo : null;

  pane.innerHTML =
    section(
      t('set.about'),
      `<div class="row"><div class="row-text"><div class="row-t">${esc(t('set.version'))}</div></div>
        <div class="mono">${esc(i.version || '')}</div></div>
      <div class="row"><div class="row-text"><div class="row-t">${esc(t('set.electron'))}</div></div>
        <div class="mono">${esc(i.electron || '')} · Chromium ${esc(i.chrome || '')}</div></div>
      <div class="row"><div class="row-text"><div class="row-t">${esc(t('set.license'))}</div></div>
        <div class="mono">${esc(i.license || 'MIT')}</div></div>
      ${
        repo
          ? `<div class="row"><div class="row-text"><div class="row-t">${esc(t('set.repo'))}</div>
              <div class="row-h mono">${esc(repo)}</div></div>
              <button class="btn btn-sm" data-ext="${esc(repo)}">${esc(t('set.open'))}</button></div>`
          : ''
      }`
    ) +
    `<div class="card">
      <div class="head-actions">
        <button class="btn btn-sm" data-act="terms">${esc(t('set.showTerms'))}</button>
        <button class="btn btn-sm btn-danger" data-act="reset">${esc(t('set.reset'))}</button>
      </div>
    </div>`;
}

/* -------------------------------------------------------------- actions */

function wire(pane) {
  $$('[data-cfg]', pane).forEach((el) =>
    el.addEventListener('change', async () => {
      S.cfg = await window.api.config.set({ [el.dataset.cfg]: el.checked });
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('[data-cfg-num]', pane).forEach((el) =>
    el.addEventListener('change', async () => {
      const value = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) || Number(el.min)));
      el.value = value;
      S.cfg = await window.api.config.set({ [el.dataset.cfgNum]: value });
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('[data-cfg-sel]', pane).forEach((el) =>
    el.addEventListener('change', async () => {
      S.cfg = await window.api.config.set({ [el.dataset.cfgSel]: el.value });
      // The tray style select reveals or hides its dependent options.
      if (el.dataset.cfgSel === 'trayStyle') render();
    })
  );

  // Comma-separated numbers, kept within 1..100 and de-duplicated.
  $$('[data-cfg-list]', pane).forEach((el) =>
    el.addEventListener('change', async () => {
      const nums = [...new Set(
        el.value
          .split(/[,\s;]+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
      )].sort((a, b) => a - b);
      el.value = nums.join(', ');
      S.cfg = await window.api.config.set({ [el.dataset.cfgList]: nums });
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('[data-open]', pane).forEach((el) => el.addEventListener('click', () => window.api.openPath(el.dataset.open)));
  $$('[data-ext]', pane).forEach((el) => el.addEventListener('click', () => window.api.openExternal(el.dataset.ext)));

  $$('input[name="claudeApp"]', pane).forEach((el) =>
    el.addEventListener('change', async () => {
      const v = el.value;
      let patch = { claudeApp: null };
      if (v.startsWith('store:')) patch = { claudeApp: { kind: 'store', appId: v.slice(6) } };
      else if (v.startsWith('exe:')) patch = { claudeApp: { kind: 'exe', path: v.slice(4) } };
      S.cfg = await window.api.config.set(patch);
      S.claude = await window.api.detectClaude();
      render();
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('input[name="switchScope"]', pane).forEach((el) =>
    el.addEventListener('change', async () => {
      S.cfg = await window.api.config.set({ switchScope: el.value });
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('input[name="apiMode"]', pane).forEach((el) =>
    el.addEventListener('change', async () => {
      S.cfg = await window.api.config.set({ apiMode: el.value, apiPrompted: true });
      await loadTokens();
      render();
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('[data-token-set]', pane).forEach((el) =>
    el.addEventListener('click', async () => {
      const token = await ui.prompt({
        title: t('dlg.tokenTitle'),
        message: t('set.apiTokenWhere'),
        value: '',
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
      });
      if (token === null || !token.trim()) return;
      await window.api.setApiToken(el.dataset.tokenSet, token.trim());
      await loadTokens();
      render();
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('[data-token-clear]', pane).forEach((el) =>
    el.addEventListener('click', async () => {
      await window.api.setApiToken(el.dataset.tokenClear, null);
      await loadTokens();
      render();
      toast(t('toast.saved'), 'ok');
    })
  );

  $$('[data-act]', pane).forEach((el) =>
    el.addEventListener('click', async () => {
      switch (el.dataset.act) {
        case 'recheck':
          S.claude = await window.api.detectClaude();
          render();
          return;

        case 'chooseExe': {
          const res = await window.api.chooseClaudeExe();
          if (!res.ok) return;
          S.cfg = await window.api.config.get();
          S.claude = await window.api.detectClaude();
          render();
          toast(t('toast.saved'), 'ok');
          return;
        }

        case 'openTerminal':
          await window.api.openClaudeTerminal();
          return;

        case 'recheckTokens':
          await loadTokens();
          render();
          toast(t('set.apiTokenRecheck'), 'ok');
          return;

        case 'terms':
          window.api.consent.show();
          return;

        case 'reset': {
          const confirmed = await ui.confirm({
            title: t('dlg.resetTitle'),
            message: t('dlg.resetMsg'),
            confirmText: t('dlg.resetOk'),
            cancelText: t('common.cancel'),
            danger: true,
          });
          if (!confirmed) return;
          S.cfg = await window.api.config.reset();
          render();
          toast(t('toast.saved'), 'ok');
        }
      }
    })
  );
}

function applyStaticI18n() {
  document.documentElement.lang = LOCALE.slice(0, 2);
  $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$('[data-title]').forEach((el) => el.setAttribute('title', t(el.dataset.title)));
  document.title = t('set.title');
}

async function init() {
  applyTheme(await window.api.theme());

  const payload = await window.api.dict();
  DICT = payload.dict;
  LOCALE = payload.locale;
  applyStaticI18n();

  [S.cfg, S.info, S.claude, S.state, S.langs] = await Promise.all([
    window.api.config.get(),
    window.api.getInfo(),
    window.api.detectClaude(),
    window.api.getState(),
    window.api.languages(),
  ]);
  await loadTokens();

  $('#winClose').addEventListener('click', () => window.api.win.close());
  $$('.tab').forEach((tb) =>
    tb.addEventListener('click', () => {
      S.tab = tb.dataset.tab;
      render();
    })
  );

  window.api.onLanguageChanged((data) => {
    DICT = data.dict;
    LOCALE = data.locale;
    applyStaticI18n();
    render();
  });
  window.api.onThemeChanged(applyTheme);
  window.api.onConfigChanged((cfg) => {
    S.cfg = cfg;
  });

  render();
}

init();

'use strict';

/*
 * In-app modal dialogs.
 *
 * Native message boxes look like Windows, not like this app, so confirmations
 * and prompts are drawn in the renderer instead. Shared by the main and the
 * settings window; both load this file before their own script.
 */

window.ui = (function () {
  const root = document.createElement('div');
  root.className = 'modal-backdrop hidden';
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3 class="modal-title"></h3>
      <p class="modal-message hidden"></p>
      <p class="modal-detail hidden"></p>
      <input class="input modal-input hidden" autocomplete="off" spellcheck="false">
      <div class="modal-error"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost modal-cancel"></button>
        <button class="btn modal-ok"></button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const el = {
    box: root.querySelector('.modal'),
    title: root.querySelector('.modal-title'),
    message: root.querySelector('.modal-message'),
    detail: root.querySelector('.modal-detail'),
    input: root.querySelector('.modal-input'),
    error: root.querySelector('.modal-error'),
    ok: root.querySelector('.modal-ok'),
    cancel: root.querySelector('.modal-cancel'),
  };

  let active = null;

  function setText(node, value) {
    node.textContent = value || '';
    node.classList.toggle('hidden', !value);
  }

  function close(result) {
    if (!active) return;
    const done = active.resolve;
    active = null;
    root.classList.add('hidden');
    el.input.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    done(result);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close(active.cancelValue);
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  async function submit() {
    if (!active || el.ok.disabled) return;
    const value = active.isPrompt ? el.input.value : true;

    if (active.validate) {
      el.ok.disabled = true;
      el.error.textContent = '';
      let error = null;
      try {
        error = await active.validate(value);
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }
      el.ok.disabled = false;
      if (error) {
        el.error.textContent = error;
        el.input.focus();
        return;
      }
    }
    close(active.isPrompt ? value : true);
  }

  function open(opts) {
    if (active) close(active.cancelValue);

    return new Promise((resolve) => {
      active = {
        resolve,
        isPrompt: !!opts.isPrompt,
        validate: opts.validate || null,
        cancelValue: opts.isPrompt ? null : false,
      };

      setText(el.title, opts.title);
      setText(el.message, opts.message);
      setText(el.detail, opts.detail);
      el.error.textContent = '';
      el.ok.textContent = opts.confirmText || 'OK';
      el.cancel.textContent = opts.cancelText || 'Cancel';
      el.ok.disabled = false;
      el.ok.className = `btn modal-ok ${opts.danger ? 'btn-danger' : 'btn-primary'}`;

      if (opts.isPrompt) {
        el.input.classList.remove('hidden');
        el.input.value = opts.value || '';
      } else {
        el.input.classList.add('hidden');
      }

      root.classList.remove('hidden');
      document.addEventListener('keydown', onKey, true);

      // Focus the field when there is one, otherwise the safest button.
      // A timer rather than requestAnimationFrame: animation frames are throttled
      // while the window is in the background, which would leave focus behind.
      const focusTarget = opts.isPrompt ? el.input : opts.danger ? el.cancel : el.ok;
      setTimeout(() => {
        focusTarget.focus();
        if (opts.isPrompt) el.input.select();
      }, 0);
    });
  }

  el.ok.addEventListener('click', submit);
  el.cancel.addEventListener('click', () => close(active && active.cancelValue));
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close(active && active.cancelValue);
  });

  return {
    /** Resolves true when confirmed, false otherwise. */
    confirm: (opts) => open(Object.assign({}, opts, { isPrompt: false })),

    /**
     * Resolves the entered string, or null when cancelled.
     * opts.validate may return an error message to keep the dialog open.
     */
    prompt: (opts) => open(Object.assign({}, opts, { isPrompt: true })),

    isOpen: () => !!active,
  };
})();

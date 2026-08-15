'use strict';

const dicts = {
  en: require('./en'),
  de: require('./de'),
  es: require('./es'),
  fr: require('./fr'),
  ja: require('./ja'),
  pt: require('./pt'),
  ru: require('./ru'),
  zh: require('./zh'),
};

const FALLBACK = 'en';

/** Maps the language setting and the system locale onto a dictionary code. */
function resolveLang(setting, systemLocale) {
  if (setting && setting !== 'auto' && dicts[setting]) return setting;
  const short = String(systemLocale || '').slice(0, 2).toLowerCase();
  return dicts[short] ? short : FALLBACK;
}

function dict(lang) {
  return dicts[lang] || dicts[FALLBACK];
}

/**
 * Substitutes {name} placeholders from params.
 * Missing keys fall back to English, then to the key itself, so a partially
 * translated dictionary still produces a usable interface.
 */
function translate(lang, key, params) {
  let s = dict(lang)[key];
  if (s == null) s = dicts[FALLBACK][key];
  if (s == null) return key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
}

const available = [{ code: 'auto', nativeName: null }].concat(
  Object.keys(dicts)
    .sort()
    .map((code) => ({ code, nativeName: dicts[code].nativeName }))
);

module.exports = { resolveLang, dict, translate, available, FALLBACK };

# Contributing

Thanks for taking the time. Issues and pull requests are welcome.

## Ground rules

Please read [DISCLAIMER.md](DISCLAIMER.md) first. Contributions that would turn this into a
tool for evading rate limits, sharing accounts, or otherwise breaking Anthropic's terms will
not be merged, however well written.

## Development

```bash
npm install
npm start
```

Useful flags:

| Flag | Effect |
|---|---|
| `--settings` | opens the settings window on launch |
| `--hidden` | starts minimized to the tray |
| `--user-data-dir=<path>` | uses a throwaway config, handy for testing first-run flows |
| `--screenshot` | captures the documentation images into `docs/` with placeholder account data, then exits |

Regenerate the icons after editing `tools/make-icon.js`:

```bash
npm run icon
```

Build Windows binaries into `dist/`:

```bash
npm run build
```

## House style

- **No runtime dependencies.** Everything ships with Electron alone — charts are hand-drawn
  inline SVG, the icons are generated from `zlib`. Please keep it that way unless there is a
  strong reason not to.
- **Comments and identifiers in English.**
- Four-space-free: two spaces, single quotes, semicolons. Match the surrounding code.
- Main process owns all filesystem and process work; renderers talk to it only through the
  `contextBridge` API in `src/preload.js`. `contextIsolation` stays on.
- Anything that moves files must be journalled and reversible, like `switchProfile`.

## Translations

Every language lives in one file under `src/i18n/`, keyed identically to `en.js`, which is
the source of truth. Missing keys fall back to English at runtime, so a partial translation
is still useful.

To add a language:

1. Copy `src/i18n/en.js` to `src/i18n/<code>.js`.
2. Set `locale` (a BCP 47 tag, used for date and number formatting) and `nativeName`.
3. Translate the values. Keep `{placeholders}` exactly as they are — they are substituted at
   runtime and a missing one shows up as literal text.
4. Register the file in `src/i18n/index.js`.

Before opening the PR, check that the key sets match:

```bash
node -e "const en=require('./src/i18n/en'),x=require('./src/i18n/de');const m=Object.keys(en).filter(k=>!(k in x));console.log(m.length?m:'complete')"
```

## Reporting bugs

Include your Windows version, the app version (Settings → About), which Claude Desktop build
you have (Store or installer), and what you expected to happen. If a switch failed, say
whether Claude was running at the time.

If the switched file set stops matching what Claude Desktop uses — the most likely way this
project breaks — please say which files changed. That is the highest-value bug report here.

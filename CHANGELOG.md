# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0]

### Added

- **A status line for Claude Code.** Settings → Status line installs a script into
  `~/.claude/settings.json` that shows the account, the 5-hour and weekly usage, a
  progress bar with a pace marker and the reset countdown at the bottom of the terminal.
  The parts shown, the colours, the labels and the refresh timer are all configurable,
  and the preview in Settings is the real script's output rather than an imitation. A
  status line you already had is remembered and restored when the feature is turned off.
- **Exact reset times without any network request.** Claude Code is told the exact
  percentages and reset moments by the API and passes them to whatever draws the status
  line — so with the status line installed, the app records them and uses them. That
  makes the weekly reset exact for accounts where it was previously an estimate, and it
  costs nothing: no token, no request, no account of ours involved.
- **Live countdowns.** Reset timers in the Limits view and the tray panel now tick, down
  to seconds inside the last hour, and reload the figures the moment a window rolls over.
- **Pace.** A marker on each gauge and meter shows how much of the window has already
  elapsed; a caption states where the current rate lands — "at this rate ≈72% by the
  reset", or the time the limit runs out if it will. It says nothing until enough of the
  window has passed for the rate to mean anything.

### Fixed

- Weekly limit notifications never fired: the code identified the window by a field that
  does not exist on the weekly window, so the threshold check was skipped every time.
- A stale sample file no longer suppresses notifications when exact figures are available
  from Claude Code or the API.

## [1.5.0]

### Added

- **The tray icon can show usage.** Four styles — app icon, icon with a bar, plain
  percentage, or a battery — tracking either the 5-hour or the weekly window, in
  threshold colours or a single colour. Drawn at 16 and 32 pixels from raw pixel data,
  so it stays sharp at any display scaling and still pulls in no image library.
- **Installed Claude Code versions** in the tray panel: the build bundled with Claude
  Desktop, the npm CLI, and the editor extensions, each read from disk.
- **Extra notification thresholds.** Alongside the main one, a comma-separated list such
  as `75, 95`. The highest threshold reached is announced, once per limit window, so
  passing several at once does not produce a burst.

### Changed

- Everything system-specific now lives in `src/core/platform.js`; the rest of the core
  has no platform coupling. The PNG and ICO writers moved to `src/core/png.js`, shared
  between the build-time icon generator and the runtime tray icon.
- macOS is explicitly out of scope: [Claude-Usage-Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker)
  already covers the Mac natively, and the README points there rather than shipping an
  unverified second implementation. Its feature set is the reference this project
  measures itself against.

## [1.4.0]

### Added

- **Tray flyout.** Left-clicking the tray icon now opens a small panel with the active
  account, usage meters with reset captions, one-click switching to the other profiles,
  and buttons to open the app or launch Claude — instead of jumping straight to the main
  window. The full menu stays on right click, and double click still opens the app.

### Changed

- **The token setup no longer asks you to dig through a JSON file.** The normal path is
  now stated plainly: open a terminal, run `claude`, sign in, and the app finds the token
  by itself. There is a button that opens a console already running the command, and a
  "Check again" button next to a per-profile status that says whether the token was found
  automatically, entered by hand, expired, or is missing. Pasting a token by hand is still
  possible, moved behind a collapsed "advanced" section where it belongs.
- The per-profile status no longer reports "token saved" for both automatic and manual
  tokens, which made it impossible to tell what was actually configured.

## [1.3.0]

### Fixed

- **Reset times were wrong.** The weekly window was anchored on first observed usage,
  but the weekly cycle is tied to the account, so the app reported a date it had no
  basis for — for a fresh account with no reset in its history it invented one outright.
  The anchor is now an actually observed reset, or a value you supply; with neither, the
  app says so instead of guessing.
- The 5-hour window is now given as a provable upper bound ("resets by 18:42") rather
  than a precise-looking time. The file stores whole-percent values every ~15 minutes and
  a small first request rounds to 0%, so the exact start of a window is not recoverable.
- Durations no longer read "resets in in 1 hr" in languages whose relative-time format
  supplies its own preposition; they are now formatted as plain units.
- The action buttons in the Limits view were rendered without their click handlers.

### Added

- **Weekly reset calibration.** Enter the time Claude's own usage view shows — the whole
  string such as "Resets Wed 7:00 AM" is understood — and reset times become exact. The
  anchor is also learned automatically the first time a reset is observed, and persists
  even if the sample history is later trimmed.
- **Live usage via Anthropic's usage endpoint**, off by default and asked about once at
  first run. Reads the OAuth token Claude Code stores locally, or one entered by hand,
  and reports exact figures and reset times. Limited to the active profile unless
  explicitly widened to all profiles, which the setting warns about. Manually entered
  tokens are encrypted at rest with Electron `safeStorage`.
- Consent version raised to 2, so the notice is shown again: the app can now make
  network requests, which the previous text ruled out.

### Changed

- README, SECURITY.md and DISCLAIMER.md rewritten around the optional network feature;
  the blanket "no network requests" claim is gone and replaced with a precise account of
  what is sent, when, and where.

## [1.2.0]

### Added

- Dark, light and system themes. Chart colours are read from the stylesheet, so SVG follows
  the theme too.
- Six more languages: Deutsch, Español, Français, 日本語, Português, 简体中文 — eight in total,
  every dictionary complete, missing keys falling back to English.
- First-run notice covering intended use, Anthropic's terms, the unofficial status, the
  local-only data handling, the AI authorship, and the absence of warranty. Must be accepted
  before the app opens, and can be reopened from Settings → About.
- Notification when a limit window resets, not only when it fills up.
- Richer tray menu: active profile and its usage as a header, direct link to the Limits view,
  and checkbox toggles for notifications and autostart.
- Switch scope setting — Claude Desktop, Claude Code, or both. Claude Code covers the CLI and
  the editor extensions, which authenticate through `~/.claude`.
- Claude Code CLI detection shown in Settings.
- `--screenshot` flag that captures the documentation images with placeholder account
  identities, so no e-mail address, account id, project name or Windows user name ends up in
  published images.
- `DISCLAIMER.md`, `CONTRIBUTING.md`, `SECURITY.md`, issue templates, and screenshots in the
  README.

### Changed

- Comments, identifiers and documentation are now English throughout.
- Billing method and plan names are translated rather than baked into the data layer; the
  core returns keys and error codes, the interface resolves them.
- A guard stops the app with an explanatory dialog on non-Windows platforms.

## [1.1.0]

### Added

- Tray icon with current usage in the tooltip, quick profile switching, and launch/close controls
  for Claude Desktop.
- Optional autostart at Windows sign-in, with a "start minimized to tray" option.
- Separate settings window: language, startup, tray behaviour, notifications, Claude installation
  and paths.
- Desktop notifications when a limit window crosses a configurable threshold.
- English and Russian interface, following the system language by default.
- Automatic detection of the Claude Desktop installation — both the Microsoft Store (MSIX) build and
  the Squirrel installer build — with a manual override.
- First-run flow that adopts the current Claude session as the first profile.
- Profile management moved into the overview: display name, open folder, delete.
- NSIS installer target alongside the portable build.

### Changed

- The hardcoded Store AppUserModelID was replaced by installation detection, so the app works on
  machines with either Claude Desktop distribution.
- New application icon: two offset cards, deliberately distinct from Claude's own mark.
- Profile size for the active slot is measured from the live paths instead of the empty store folder.
- Error handling moved to error codes translated in the renderer, instead of hardcoded strings.

## [1.0.0]

### Added

- Profile switching built on the storage layout of the original `claude-switch.ps1`, with a move
  journal and rollback on failure.
- Account overview: plan, rate-limit tier, billing method, subscription and account dates,
  organization, extra usage — including for inactive profiles.
- Limits view: 5-hour and weekly usage gauges, reset estimates, history chart with gaps, daily peaks
  and profile comparison, read from `plan-usage-history.json`.
- Claude Code token usage aggregated from local transcripts, cached by file mtime and size.
- Portable Windows build.

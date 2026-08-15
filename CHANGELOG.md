# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

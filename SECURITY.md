# Security policy

## Scope

This application handles files that authenticate you to Claude — session cookies, local
storage and `~/.claude/.credentials.json`. It moves them between folders on your own machine
and never transmits them. Bugs that could expose those files, or cause them to be lost, are
treated as security issues.

## Network access

The app makes **no** network requests unless you turn on **Live usage** (Settings →
Claude), which is off by default and asked about once at first run.

With it on, and only for the profiles you selected, the app:

- reads the OAuth access token that Claude Code stores in plaintext at
  `~/.claude/.credentials.json` (or the copy inside the profile store), or a token you
  entered by hand;
- sends `GET https://api.anthropic.com/api/oauth/usage` with that token in the
  `Authorization` header, to read exact usage percentages and reset times.

`api.anthropic.com` is the only host the app ever contacts. The token is never logged,
never written anywhere except — for manually entered tokens — the app's own settings
file, encrypted with Windows DPAPI via Electron's `safeStorage`. There is no telemetry
and no analytics, with the feature on or off.

Enabling it for several accounts at once means authenticated requests for multiple
accounts from one machine. That is your decision to make; the setting says so plainly.

## Files the app writes outside its own storage

One feature writes outside profile storage and the app's own data directory: the
**status line** (Settings → Status line), off by default.

Turning it on adds a `statusLine` entry to `~/.claude/settings.json` pointing at a
PowerShell script the app writes into its own data directory, and leaves every other key
in that file untouched. A status line you had configured before is remembered and put
back when the feature is turned off. If the file cannot be parsed, the app refuses to
write it rather than replacing it.

The script itself reads the JSON Claude Code hands it on stdin, plus a state file the app
writes, and prints one line. It makes no network request. With **Record the rate limits
Claude Code reports** on, it also writes the percentages and reset times Claude Code was
given into `bridge.json` in the app's data directory, so the app can show exact figures
without asking the API itself. That file holds usage percentages, reset timestamps and an
organization id — no tokens.

## What the app does not do

- No credentials are parsed or displayed beyond the single token field described above.
  Account details come from the non-secret `oauthAccount` block of `.claude.json`
  (e-mail, plan, organization) and the percentages in `plan-usage-history.json`.
- Renderers run with `contextIsolation` on and `nodeIntegration` off. All filesystem and
  process access lives in the main process behind a narrow `contextBridge` API.
- A strict Content-Security-Policy blocks remote script, style and image loading in every
  window.
- Only `https://` URLs are ever passed to the system browser, and only from the About screen.

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository, rather than in a public issue.

Include what you did, what happened, and the app and Windows versions. A proof of concept is
welcome but not required. Expect a first response within a few days; this is a hobby project
maintained in spare time, so please be patient.

## Supported versions

Only the latest release receives fixes.

## Binary integrity

Release binaries are unsigned, so Windows SmartScreen will warn about an unknown publisher.
Download them only from this repository's [Releases](../../releases) page, or build from
source with `npm run build`. Do not run copies obtained anywhere else.

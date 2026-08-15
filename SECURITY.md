# Security policy

## Scope

This application handles files that authenticate you to Claude — session cookies, local
storage and `~/.claude/.credentials.json`. It moves them between folders on your own machine
and never transmits them. Bugs that could expose those files, or cause them to be lost, are
treated as security issues.

## What the app does not do

- No network requests, telemetry, or analytics of any kind.
- No credentials are read, parsed, or displayed. The app reads only the non-secret
  `oauthAccount` block of `.claude.json` (e-mail, plan, organization) and the usage
  percentages in `plan-usage-history.json`.
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

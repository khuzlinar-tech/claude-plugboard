# Platform support

**Windows 10/11 only.** Reading and profile switching are both verified there.

## On macOS, use Claude Usage Tracker

[**Claude-Usage-Tracker**](https://github.com/hamed-elfayome/Claude-Usage-Tracker) by
Hamed Elfayome is a native macOS menu-bar app covering the same ground, and covering it
well — session and weekly windows, per-model breakdowns, API console costs, multiple
profiles, notifications, a Claude Code statusline, and more. It is MIT licensed, code
signed by Apple, and actively maintained.

There is no reason for a second, worse macOS implementation. This project stays on
Windows, that one stays on macOS, and the feature sets converge.

## Why not just port this app

The app moves the files that constitute a signed-in Claude session. Reading the wrong
file shows something incorrect; **moving** the wrong file signs you out. Confirming
which files make up a session on macOS requires a Mac to test on, and shipping an
unverified guess would risk other people's sessions for no benefit given the option
above already exists.

## Adding a platform anyway

Everything system-specific lives in `src/core/platform.js`: the data directory, the
account file set, and how Claude is found, launched, listed and stopped. The rest of
`src/core/` has no platform coupling — `profiles.js`, `usage.js`, `cliusage.js` and
`config.js` run anywhere Node does.

A port needs:

| Item | Windows value | What to confirm elsewhere |
|---|---|---|
| Data directory | `%APPDATA%\Claude` | where the Electron app stores its profile |
| Account file set | `Network`, `Local Storage`, `Session Storage`, `IndexedDB`, `Local State`, `config.json` | which of these carry the session |
| Usage history | `plan-usage-history.json` in the data directory | whether it exists at all |
| Process name | `claude.exe` | what the running process is called |
| Launch | AppUserModelID or executable | how to start the installed app |

`switchVerified` must stay `false` until somebody has actually switched profiles on that
system and confirmed both accounts still sign in afterwards. `profiles.js` refuses to
move anything while it is false.

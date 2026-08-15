# Disclaimer

## Not affiliated with Anthropic

Claude Plugboard is an independent, unofficial tool. It is **not** affiliated with,
endorsed by, sponsored by, or supported by Anthropic PBC.

"Claude", "Claude Desktop", "Claude Code" and "Anthropic" are trademarks of Anthropic PBC.
They are used in this project only descriptively — to identify the software this tool works
with — under nominative fair use. No trademark, logo, or brand asset of Anthropic is bundled
in this repository or in its release binaries; the application icon and all artwork are
original to this project.

Do not contact Anthropic support about problems caused by this tool. Report them
in this repository's issue tracker instead.

## Intended use

This tool is intended for a single person switching between Claude accounts that **they are
personally entitled to use** — for example a personal subscription and an employer-provided
account.

It is **not** intended for, and must not be used for:

- sharing one account between multiple people;
- accessing accounts belonging to someone else;
- creating or cycling accounts to obtain more usage than your plan allows;
- evading rate limits, trial restrictions, bans, or any other limitation applied to your account;
- any use that violates Anthropic's
  [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) or
  [Usage Policy](https://www.anthropic.com/legal/aup).

Your use of Claude remains governed by your agreement with Anthropic. Nothing in this
project modifies, overrides, or grants an exception to those terms. If switching accounts
would breach them in your situation, do not use this tool.

## What the software actually does

The application moves files that Claude Desktop and Claude Code have already written on
your own computer between folders on that same computer, and reads usage figures those
programs already store locally.

One optional feature, **off by default**, additionally reads the OAuth token Claude Code
has stored locally and calls Anthropic's own usage endpoint with it, to show exact
figures instead of estimates. It is opt-in, asked about once, and described in
[SECURITY.md](SECURITY.md). Note that this uses an undocumented internal endpoint with a
token issued for an official client; whether that fits your agreement with Anthropic is
your call, and the risk falls on your account.

The software does not:

- circumvent, patch, or modify any Anthropic software;
- intercept, proxy, or modify network traffic;
- bypass authentication, licensing, or any technical protection measure;
- decrypt credentials that another application stored encrypted;
- create accounts, or automate any part of Anthropic's services;
- collect telemetry or analytics of any kind.

## Written with AI assistance

This application was written largely by an AI assistant (Claude), with human direction and
review. This is disclosed openly so you can calibrate your trust accordingly. The complete
source is in this repository — read it before running it on anything you care about.

## No warranty

This software is provided "as is", without warranty of any kind, express or implied,
including but not limited to the warranties of merchantability, fitness for a particular
purpose and non-infringement. See [LICENSE](LICENSE) for the full text.

Switching profiles moves session files. In the worst case a session can be lost and you
will need to sign in again. Back up `~/.claude-profiles` if the data matters to you.
You remain solely responsible for your data and for your accounts.

## Removal requests

If you are a rights holder and believe something in this project infringes your rights,
open an issue or contact the maintainer through the repository. Concerns will be addressed
promptly and in good faith.

# Hallpass

**Let coding agents drive your own Chrome, one permission at a time.**

[![CI](https://github.com/norton77930/hallpass/actions/workflows/ci.yml/badge.svg)](https://github.com/norton77930/hallpass/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/norton77930/hallpass)](https://github.com/norton77930/hallpass/releases/latest)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2011-lightgrey)

English · [繁體中文](README.zh-TW.md)

Hallpass is a Chrome extension plus a local MCP server. Claude Code, Codex CLI, Cursor, Claude
Desktop or any stdio MCP client gets 34 browser tools that work in the Chrome you already use, with
your logins. Every site the agent touches, and every action that changes a page, is gated by a
decision you make in the side panel: allow once, allow this site from now on, or refuse. You can
stop the agent at any moment and take your tabs back.

> **Platform**: Windows 11. The installer registers the host for Google Chrome, Chromium,
> Microsoft Edge and Brave. Google Chrome is the browser the acceptance suite runs on; Edge and
> Brave are registered but not live-verified — see [issue #2](../../issues/2). macOS and Linux are
> not supported yet — see [issue #1](../../issues/1).
> **Licence**: Apache-2.0.

![A coding agent searches DuckDuckGo in the user's Chrome: before it types and before it presses Enter, the side panel asks the user and the agent waits for Allow once. The page half is Hallpass's own recording, with the action label, the step counter and the watermark](docs/media/demo.gif)

- **Your browser, your logins.** No separate profile, no browser started in debugging mode, no
  cookies copied anywhere.
- **You stay in the loop.** Reads are free; the first click, keystroke or navigation on a site asks
  you, and you choose how much to trust that site from then on.
- **You can take it back.** Stop a session, interrupt one step, or pull your tabs out of the agent's
  group at any moment from the side panel.
- **Local only.** The agent, the MCP server, the relay and the extension talk over stdio, loopback
  and Chrome native messaging. Hallpass has no server and no telemetry.

**Quick start** (details under [Install](#install)): download the
[latest release](../../releases/latest), run `install.ps1`, load the `extension\` folder at
`chrome://extensions`, and add the printed MCP server to your agent. Then ask it to *"use hallpass
to open wikipedia.org and tell me the page title"*.

## How it differs

| | **Hallpass** | Claude in Chrome | chrome-devtools-mcp | playwright-mcp | BrowserMCP |
| --- | --- | --- | --- | --- | --- |
| Runs in your everyday Chrome | yes (extension) | yes (extension) | no — a Chrome started in developer mode, separate profile | no — its own browser | yes (extension) |
| Keeps your logins | yes | yes | no | no | yes |
| Coding agents it serves | any stdio MCP client | Claude Code (CLI and VS Code) | any MCP client | any MCP client | any MCP client |
| Account or plan needed | no | a paid Claude plan (Pro, Max, Team, Enterprise); not with an API key or a third-party provider | no | no | not stated |
| Consent per site and per action | yes — three modes, side-panel cards | yes — site permissions; by default approves on its own and pauses when an action needs you | no | no | not stated |
| Stop from the browser, take tabs back | yes | not stated | no | no | not stated |
| Several agents on one browser | yes — one tab group each | a tab group per session | not stated | not stated | not stated |
| Records the run as a GIF | yes — one frame per action, labelled | yes | no | no | no |
| Answers native dialogs | yes — accept is gated | no — a dialog blocks it until you dismiss it | not stated | yes | not stated |
| Platform | Windows | Windows, macOS, Linux (not WSL) | Windows, macOS, Linux | Windows, macOS, Linux | Windows, macOS, Linux |
| Licence | Apache-2.0 | proprietary | Apache-2.0 | Apache-2.0 | MIT |

The official MCP servers give an agent *a* browser. BrowserMCP gives it *your* browser, whole.
Claude in Chrome gives your browser to Claude, under Anthropic's permission model and a paid
plan. Hallpass gives your browser to any coding agent, with you deciding per site and per action.
The design behind that is in [docs/design-notes.md](docs/design-notes.md).

<sub>Compared from each product's public documentation, September 2026. Corrections are welcome
as an issue.</sub>

## Install

You need **Node.js 24 or newer** (`node -v`) and Chrome. Nothing runs outside your machine: the
agent talks to a local MCP server over stdio, the server talks to a relay Chrome starts, the relay
talks to the extension.

1. Download `hallpass-<version>.zip` from the [latest release](../../releases/latest) and unzip it
   into a folder you will not move later (the path is written into the registry), for example
   `D:\hallpass\`.
2. In that folder, run the installer (no administrator rights needed; it registers the native host
   under `HKCU` and writes to `%LOCALAPPDATA%\hallpass\`):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
3. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, choose the `extension\` folder from the zip. The extension is called **Hallpass** and
   its ID is `adgpccmmbgnchnphfaoabfflfcepbopd` (fixed by a key in the manifest; the native host
   accepts only this ID). Pin it to the toolbar.
4. Add the MCP server to your client. The installer prints the definition and copies it to the
   clipboard. For Claude Code:
   ```powershell
   claude mcp add hallpass --scope user -- node "D:\hallpass\host\mcp-server.js"
   ```
   For Claude Desktop, Codex CLI, Cursor and CodeBuddy the zip's `README.md` shows where each keeps
   its MCP configuration and what to paste.

**From source** instead of the zip:

```powershell
git clone https://github.com/norton77930/hallpass.git
cd hallpass
npm install
npx tsc -b
npm run build                 # apps\extension\dist\agent
npm run agent-host:install    # registers the host pointing at this checkout
claude mcp add hallpass --scope user -- node "<checkout>\packages\agent-host\dist\mcp-server.js"
```

Load `apps\extension\dist\agent` as the unpacked extension. After a rebuild, reload the extension;
the host needs no reinstall.

## First use

1. With Chrome open, tell your agent: *"Use hallpass to open https://en.wikipedia.org and tell me
   the page title."*
2. The first tool call shows a **pairing card** in the side panel (click the toolbar icon or press
   Alt+A): "Claude Code wants to connect to this browser". Allow it. You pair once; Chrome remembers.
   If the panel is closed, the agent tells you so and the toolbar icon shows a red **!**; the card
   waits up to two minutes for you to open the panel.
3. The first action that **changes a page** (a click, typing, navigation) shows a **consent card**:
   "Claude Code wants to click on wikipedia.org". Choose *only this time*, *always on this site*, or
   *refuse*.
4. Tabs the agent drives sit in a tab group named **Hallpass** in the session's own colour — `⌛`
   while it works, `🔔` while it waits for you — with a glow at the page edge. The session appears
   as a card in the panel, titled with the agent and its project folder, with **End session**,
   **Interrupt this step** and **Take back tabs**.

![The side panel: a question card, the status row "Connected · 2 sessions", and two session cards named by project folder, one waiting for you and one idle, each with its colour stripe](docs/media/016-panel-en-US-light.png)

## The consent model

| Site mode | Meaning | Use it for |
| --- | --- | --- |
| **ask** (default) | Every page-changing action shows a consent card | Sites you do not know, sites with an account |
| **follow-a-plan** | A multi-step `browser_batch` is approved once as a plan (you can strike steps); single actions still ask | Fixed flows such as filling a form |
| **skip-checks** | Nothing is asked on this site; marked with a warning in the list | Sites you trust with no sensitive data |

- **A session site plan** covers a task that spans several sites. The agent proposes the sites with
  `propose_sites`; you approve them once in the panel and can untick any. For that agent session
  only, page actions on exactly those sites then run without a card, until the session ends, you
  unpair the agent, the browser closes, or you press **Withdraw site plan** on the session card. Page
  JavaScript, uploads and a move to an undecided site still ask, and unlisted sites are unchanged.
- **Reads never ask.** Reading the page, finding elements, screenshots and waiting need no consent.
- **Diagnostics** (console, network records, evaluating script) need a separate per-site grant you
  tick in the panel. Evaluating script also counts as an action.
- **Uploads** are limited to directories you list in `%LOCALAPPDATA%\hallpass\config.json` under
  `uploadRoots` (empty by default). A file outside them is not refused any more: the panel asks,
  and *this directory from now on* adds it to the list for you.
- **A move to a site you have not decided about** is reported by the call that caused it and asked
  at the next call on that tab: continue, always allow this pair, or decline.
- **Downloads** land in Chrome's download folder as usual; the agent is told the name and state and
  never starts, opens, moves or deletes one.
- **Form values** are readable except password, hidden, one-time-code and payment-card fields,
  which are reported as redacted.
- **Dialogs**: cancelling and acknowledging an alert never ask; pressing OK is gated like a click,
  except when it follows an action you just approved. Dialog text is logged on the session card.
- **End session** ends the session and tells the agent you stopped it. **Interrupt this step** ends
  only the step that is running and keeps the session. **Take back tabs** hands every tab back to
  you while the session continues.

Sensitive sites — banking, health, anything you would not hand to a stranger — do not belong in
`skip-checks`. The agent uses your profile and sees what you see.

## Security and privacy

**What stays on your machine.** Hallpass has no server, no account and no telemetry. The MCP server
talks to its relay over loopback TCP, the relay to the extension over Chrome native messaging, and
the extension makes no network requests of its own. The relay log
(`%LOCALAPPDATA%\hallpass\relay.log`) records stable codes, never page content.

**What leaves it.** Whatever a tool answers — page text, form values, screenshots — goes to your
coding agent, and from there to the model provider that agent uses, exactly as a file the agent
reads would. Hallpass redacts password, hidden, one-time-code and payment-card fields; everything
else the agent reads, its provider sees.

**Prompt injection.** A web page is untrusted input: its text can try to instruct the agent that
reads it. Hallpass does not detect that and does not claim to. What it gives you is a decision
point: under **ask**, every page-changing action on a site waits for you, and a move to a site you
have not decided about is asked at the next call. Read the card before you allow it, keep sites with
an account on **ask**, and use **End session** if the agent does something you did not expect.

Found a vulnerability? Report it privately as [SECURITY.md](SECURITY.md) describes.

## Tools

The agent sees these as `mcp__hallpass__<name>` in Claude Code.

| Tool | What it does |
| --- | --- |
| `tabs_context` | List every tab in the browser and who holds each one |
| `tabs_create` / `tabs_close` | Open a tab in the session's group; close one it owns |
| `tabs_claim` / `tabs_release` | Take one of your tabs into the session; give it back |
| `navigate` | Go to a URL or back/forward; stays on the page if it asks to (`force` to leave); landing on a site you have not decided about is reported and asked at the next call |
| `resize_window` | Resize the window holding a tab; restored when the session lets go |
| `viewport` | Give a tab an emulated viewport for a layout check; cleared when the session lets go; adds a frame to an open recording |
| `read_page` / `get_page_text` / `find` | Structure with refs and field values; visible text; elements by description |
| `screenshot` | PNG of a tab, optionally cropped to a region and taken at a smaller `scale`; the answer carries an `imageId` for `upload_image` |
| `click` / `right_click` / `double_click` / `triple_click` / `hover` / `drag` | Pointer actions delivered as real input; a click that lands the tab on a site you have not decided about is reported and asked at the next call |
| `type` / `key` / `scroll` / `form_input` | Keyboard, scrolling and form controls |
| `computer` | Act at a viewport point when the page's structure does not describe the target |
| `browser_batch` | Several steps on one tab in one call, approved once under follow-a-plan |
| `wait` | Fixed time, a page condition, or the next download to finish |
| `downloads_context` | The downloads this session caused, with paths and states |
| `read_console` / `read_network` / `evaluate` | Diagnostics, behind the per-site grant |
| `file_upload` | Put your files into a file input; one outside your allowed directories asks you (this file once / its directory from now on / decline) |
| `upload_image` | Put a screenshot the session took into a file input or onto a drop target |
| `propose_sites` | Propose the sites a task will use; the owner approves once in the side panel, for this session only |
| `gif_recorder` | Start, stop, export or clear a recording of the session |
| `dialog` | Accept or dismiss an alert, confirm or prompt |

## Testing

```powershell
npm run typecheck
npm test                 # unit + panel tests
npm run test:contract    # contract tests on the built artifacts
```

These three run in CI on Windows. Two more suites need a real Chrome and run locally before a
release: the packaged gate (`tests/e2e/packaged/agent-*.spec.ts`, attaching to a Chrome started
with `--remote-debugging-port=9222`) and the acceptance probes, which drive the bridge with a real
coding-agent session. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to run both.

## Changelog and upgrading

What each release added is in [CHANGELOG.md](CHANGELOG.md). Upgrading between releases is the same
every time unless the changelog says otherwise: reinstall the host (`install.ps1` from the zip, or
`npm run agent-host:install` from source) and reload the extension at `chrome://extensions`, in
either order.

## Upgrading from 0.2.0

0.3.0 renames the product: the MCP server is `hallpass` (was `poc-browser`), the host is
`com.hallpass.host` in `%LOCALAPPDATA%\hallpass\` (was `poc-agent-host`). Your pairing and site
modes are kept — they are stored under the extension's unchanged ID. Steps:

1. Unzip 0.3.0 into a folder and run its `install.ps1`. It removes the old host registration and
   tells you; delete `%LOCALAPPDATA%\poc-agent-host\` yourself when you are done.
2. Re-enter your upload roots in the new `config.json` if you had any.
3. Reload the extension from the new `extension\` folder (`chrome://extensions` → Load unpacked).
4. Re-register the server: `claude mcp remove poc-browser --scope user`, then the `claude mcp add
   hallpass …` line the installer printed.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the build, the
test suites, the two-attempts rule and the clean-room boundary, and [SECURITY.md](SECURITY.md) for
reporting a vulnerability privately. The specifications behind every feature are under
[specs/](specs/).

## Licence

[Apache-2.0](LICENSE). Third-party components are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

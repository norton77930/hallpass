# Chrome Web Store listing (draft)

Working draft for the first Web Store submission. Nothing here is submitted; the owner submits from
the developer dashboard. The Web Store replaces one install step — loading the unpacked extension in
developer mode. The host still comes from the release zip (`install.ps1`), because an extension
cannot install a native messaging host.

## Open before submitting

1. **Extension ID.** The manifest carries a fixed `key`, so every build has the ID the host accepts
   (`AGENT_HOST_ALLOWED_ORIGINS`, `packages/agent-host/src/install/manifest.ts`). The Web Store
   assigns its own ID and is expected to refuse an upload whose manifest has a `key` field. So:
   - the store build drops `key` (a build option, not a change to the default build), and
   - the host's `allowed_origins` gains the store ID once the dashboard shows it (the draft item gets
     its ID before review). That widens the host's origin check, which is the outer gate of the
     bridge — it gets a test and a review, and ships in a host release before or with the listing.
   Check first: whether the dashboard accepts the existing private key as `key.pem` at the zip root to
   keep the current ID. If it does, neither change is needed.
2. **`https://localhost/*`.** The agent build adds it for the test page fixtures
   (`TEST_HOST_PERMISSIONS`, `apps/extension/src/build-config.ts`). `<all_urls>` already covers it;
   the store build should leave it out so the listing shows only what the product needs.
3. **`activeTab`.** Declared in `AGENT_PROFILE_PERMISSIONS` but no source calls on it, and
   `<all_urls>` already grants what it would (the comment on `AGENT_HOST_PERMISSIONS` says why
   `activeTab` alone is not enough). The Web Store asks for the narrowest set; dropping it is a
   behaviour-neutral manifest change with its contract tests updated — confirm with one packaged
   gate run.
4. **Review time.** `debugger`, `nativeMessaging` and `<all_urls>` together mean an in-depth manual
   review; plan for weeks rather than days, and for questions about `debugger`.
5. **Account.** A developer account (one-time US$5) with a verified contact email.
6. **Privacy policy URL.** `PRIVACY.md` in the public repository
   (`https://github.com/norton77930/hallpass/blob/main/PRIVACY.md`) once it is in a public snapshot.

## Listing

- **Name:** Hallpass
- **Summary (≤ 132 characters):** Let coding agents drive your own Chrome, one permission at a time.
  Local MCP bridge with per-site, per-action consent.
- **Category:** Developer Tools
- **Language:** English (the extension is also localised to Traditional Chinese)

**Description:**

> Hallpass lets the coding agent you already use — Claude Code, Codex CLI, Cursor, CodeBuddy or any
> MCP client — work in your own Chrome, signed in as you, without handing it the browser.
>
> Every site starts on **ask**: when the agent wants to click, type, upload or navigate somewhere
> new, the side panel shows what it is about to do and waits for you. You can let a site follow a
> plan you approved, or skip checks for a site you trust, and change your mind at any time. The
> agent works in its own tab group, you see its cursor on the page, and **End session** stops it.
>
> What it can do: read pages (including iframes and form values), click, type, drag, scroll, upload
> files from folders you allow, handle dialogs, take screenshots, read console and network entries,
> record the run as a GIF, and more — 33 tools over the Model Context Protocol.
>
> How it is built: no server, no account, no telemetry. The extension talks only to a small helper
> program on your computer (installed from the GitHub release with one PowerShell script), and that
> helper talks only to your agent. Windows 11; Chrome, Chromium, Edge and Brave.
>
> Open source (Apache-2.0): https://github.com/norton77930/hallpass

**Single purpose:** Let a local coding agent operate the user's Chrome through tools the user approves
per site and per action in the side panel.

## Permission justifications

| Permission | Why Hallpass needs it |
| --- | --- |
| `debugger` | Performs the agent's input (mouse, keyboard, drag), screenshots, viewport changes and console/network reads in the tabs the agent works in, through the Chrome DevTools Protocol. Attached only to tabs in the agent's tab group, while a session is active; Chrome shows its own "is debugging this browser" bar. |
| `nativeMessaging` | The only channel to the local helper program that connects the extension to the user's coding agent. The helper accepts only this extension. |
| `<all_urls>` (host) | The user decides which sites the agent may use, and that can be any site; nothing runs on a site until the user allows it in the side panel. |
| `scripting` | Injects the page runtime that finds elements, reads text and form state, and draws the agent's cursor, in tabs the agent works in. |
| `tabs` | Opens, lists, switches and closes the agent's tabs and reports their URLs and titles to the agent. |
| `tabGroups` | Keeps the agent's tabs in a named, coloured group so the user can see which tabs the agent holds. |
| `sidePanel` | The consent and status UI: pairing, questions before actions, sessions, per-site modes. |
| `storage` | Saves the user's per-site decisions, paired agents and panel preferences, locally. |
| `alarms` | Expires unanswered questions and reconciles sessions after the service worker sleeps. |
| `downloads` | Reports downloads the agent's actions started, so the agent knows what was saved and where. |
| `offscreen` | Encodes the optional GIF recording of a run in an offscreen document. |

**Remote code:** none. All code is in the package; the extension pages' CSP is `script-src 'self'`.

## Data usage (dashboard "Privacy practices")

The extension handles website content, but only on the user's computer: it is passed to the local
helper and from there to the user's own agent; the developer receives nothing. Proposed answers —
the owner confirms each against the dashboard's wording before submitting:

- Data collected by the developer: **none**. If the form asks what the extension *handles*, declare
  **Website content** and **User activity** (the agent's clicks and keystrokes it performs) with the
  purpose "app functionality", not sold, not used for anything else.
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the single
  purpose; not used for creditworthiness or lending.

## Store assets

- Icon 128×128: the existing extension icon.
- Screenshots 1280×800 (up to 5): the 0.9.0 panel shots in `docs/media/016-panel-*.png` composed
  next to a page, plus a frame of the README demo with a question card. Never a shot that shows a
  local path or account name (`agent-panel-shots.spec.ts` guard).
- Small promo tile 440×280: optional.

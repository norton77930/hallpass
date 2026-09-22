# Research: First-Run Visibility

Numbering continues from 010 (R-159). R-160 and R-161 are **measurements**, made 2026-09-21
before this plan was written (SC-082).

## R-160 — Can the worker open the side panel without a gesture? (measured: no)

**Method**: `.scratch/r160-sidepanel-open.mjs` — Playwright launches a browser with the built
agent extension loaded, finds its service worker, and evaluates in the worker: `sidePanel.open({windowId})`,
`sidePanel.open({tabId})`, the same after a 300 ms timer, `sidePanel.setPanelBehavior`, and the
`chrome.action` badge/title calls.

**Result on the bundled Chromium 151** (`Chrome/151.0.0.0`):

| Call | Result |
| --- | --- |
| `sidePanel.open({windowId})` | refused: `sidePanel.open()` may only be called in response to a user gesture. |
| `sidePanel.open({tabId})` | refused, same message |
| `sidePanel.open` after a timer | refused, same message |
| `sidePanel.setPanelBehavior({openPanelOnActionClick:true})` | ok |
| `action.setBadgeText / setBadgeBackgroundColor / setTitle / getBadgeText` | ok, reads back `!` |

The branded Chrome 153 could not be launched with `--load-extension` (removed from branded builds
since Chrome 137), so the measurement is on Chromium 151; the gesture rule is Chromium code shared
by both. The reference bundles' programmatic calls (design notes §8) must sit inside a gesture or be
dead paths; either way not a route for us.

**Decision**: FR-152's "if Chrome accepts" branch is closed — no worker-initiated open. A + B are
the behaviour. `setPanelBehavior({openPanelOnActionClick: true})` was planned as belt and braces and
**withdrawn at review (L1, 2026-09-21)**: with the flag on, Chrome opens the panel *instead of* firing
`action.onClicked`, which would bypass the tab-scoped panel options the click handler sets today.
The icon keeps opening the panel through `action.onClicked` as before.

## R-161 — The MCP client's per-call bound vs a two-minute wait (looked up: safe)

**Source**: Claude Code documentation (`code.claude.com/docs/en/mcp`), read 2026-09-21:
`MCP_TOOL_TIMEOUT` defaults to about 28 hours wall clock; progress notifications do not extend it
(and need not); a separate idle bound `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` is 30 minutes for stdio.
`MCP_TIMEOUT` (10 s) is server start-up only. The "MCP client's own 60 s request bound" comment in
`mcp-server.ts` describes the MCP SDK's default, not Claude Code's; it is corrected in S1.

**Decision (FR-150)**: hold the call. A two-minute wait is well inside Claude Code's bounds; the
progress notification every 5 s is kept because it is the carrier of the message (A) and keeps the
idle bound trivially alive. Other MCP clients (Cursor, CodeBuddy) are not documented here; the
assumption that they tolerate 120 s is recorded in the spec and checked by the QA team's first use
(they run those clients), not by us.

**What still has to change**: the host's own per-call backstop (`router.ts`, 30 s) would end the
call first. R-162 gives the worker a way to say "still waiting" that the router treats as keep-alive.

## R-162 — The `prompt-waiting` frame

**Decision**: a new worker → host link frame, sent every 5 s while a pairing request or a consent
prompt **raised with no panel connected** is pending (review M1, 2026-09-21: nothing is sent for a
question raised with a panel connected — the existing bounds and the server's own pairing progress
apply, and an older relay is never fed a frame it would mis-route):

```
{ type: "prompt-waiting", sessionId, callId?, kind: "pairing" | "ask" | "plan" | "dialog" | "diagnostics",
  panelConnected: boolean, waitedMs, boundMs }
```

- The relay forwards it to the session's server like any frame (it reads `sessionId`).
- The router, on a `prompt-waiting` for a `callId` it holds, re-arms that call's backstop to
  `boundMs - waitedMs + 10 s`, capped at 130 s from the call's start; it never extends a call it
  does not hold.
- The server turns it into `notifications/progress` on the call (or on the pairing exchange when
  there is no `callId`), with `message` = the attention text of R-164 when `panelConnected` is false
  and the existing neutral text when true (kept for robustness; after M1 such a frame is not sent).
- `boundMs` is chosen by the worker at raise time (R-163) and does not change while the prompt
  lives; the frame repeats it so the host's arithmetic is stateless.

**Alternatives**: answering early with a "waiting, call again" outcome — rejected now that R-161
shows the client bound is not the constraint; it would move the retry burden onto every agent and
make a pending prompt attach to a second call, which the one-prompt-per-session rule forbids.

## R-163 — Attention state: bound and badge

**Decision**: "panel connected" = the worker's panel port has at least one connected document
(`agent-panel-port.ts`, the `connected` set). It is read **once, when the prompt is raised**, and
fixes that prompt's bound: 25 s (consent) / 45 s (pairing) when connected, 120 s when not. A panel
that connects mid-wait shows the prompt (FR-149, already the projection's behaviour) but does not
shorten the running bound (spec edge case).

The badge is a derived state, recomputed on every prompt change and every panel connect /
disconnect: `pending prompt exists && no panel connected` → `setBadgeText("!")`, red background,
title "Hallpass: a question is waiting — click to open the side panel"; otherwise clear. On worker
wake the same derivation runs once so a stale badge from a recycled worker is cleared. Pairing is
a prompt for this purpose (pairing-controller exposes "pending").

Pairing's bound lives in the server today (45 s); the worker cannot time it out. R-162's frame
carries `boundMs: 120000` for pairing when the panel is closed, and `awaitPairing` adopts the
frame's bound when it is larger than its own — so the server's 45 s stays the default and the
worker's knowledge of the panel is what extends it.

## R-164 — The words

**Decision**: one fixed sentence per kind, bilingual (English first, zh-TW second, one line each),
carried in `prompt-waiting` progress messages and in the `timed-out` outcome's new optional `hint`:

- pairing: "Hallpass is waiting for you to accept the pairing in Chrome's side panel, which is
  closed. Click the Hallpass icon in the toolbar or press Alt+A to open it." / 「Hallpass 正在等你在
  Chrome 側欄接受配對,但側欄沒有打開。請點工具列的 Hallpass 圖示或按 Alt+A 打開它。」
- consent (ask / plan / dialog / diagnostics): "Hallpass is waiting for your answer to a consent
  card in Chrome's side panel, which is closed. Click the Hallpass icon in the toolbar or press
  Alt+A to open it." / 「Hallpass 正在等你回答側欄裡的同意卡,但側欄沒有打開。請點工具列的 Hallpass 圖示或按 Alt+A
  打開它。」

No page content, no tool arguments (FR-151). The sentences live in `packages/contracts` so the
worker, the host and the tests share one source.

## R-165 — The pointer baseline

**Decision**: US3's baseline is pinned by a gate assertion, not changed: the pointer element is
present before each `Input.dispatchMouseEvent` press and the press follows the cursor's arrival
message. The curved-path / spring form (FR-154) is designed only after D-011-5; if the owner says
"keep", FR-155's document corrections are the whole of US3.

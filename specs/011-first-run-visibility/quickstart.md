# Quickstart: proving feature 011

## 1. Unit and contract

```
npm run test -- --maxWorkers=4
npm run test:contract
```

Expected new cases green: bound selection (connected → 25 s / 45 s, not → 120 s), router
keep-alive (re-arm and the 130 s cap), server progress message per kind and `panelConnected`,
pairing bound adoption, attention derivation table, `prompt-waiting` schema, sentences carry no
placeholder, no new manifest permission.

## 2. The packaged gate (SC-078..081, SC-083)

Unattended recipe (memory `unattended-attach-gate`): Playwright Chromium headed on 9222, private
LOCALAPPDATA shared by browser and runner, `HALLPASS_FOREIGN_AGENT_SERVERS=allow`. Then:

```
npx playwright test tests/e2e/packaged/agent-first-run.spec.ts
```

The spec drives a real MCP server with the panel page **not** opened: asserts the first progress
notification arrives within 5 s and carries the pairing sentence; reads the badge through the
worker (`chrome.action.getBadgeText`) = `!`; opens `side-panel.html` as a tab → the pairing card is
the first card; accepts → the original call completes; then, with
`HALLPASS_AGENT_PAIRING_TIMEOUT_MS`-style shortening of the closed-panel bound to 10 s for the test,
the expiry path: `timed-out` with `hint`, badge cleared. The consent variant repeats it with a
`click` on an `ask` site. The pointer baseline: three clicks, pointer present before each press.

## 3. The paid probe (SC-078, SC-079) — owner's go-ahead first

```
claude -p --model sonnet "…call mcp__hallpass__tabs_create with the panel closed…"
```

with the side panel closed on the owner's Chrome; expected: the agent's reply names the side panel
and Alt+A within 5 s of the call; opening the panel and pressing Accept at ~90 s completes the call.

## 4. Documents (FR-155)

`docs/design-notes.md` (pointer paragraph: the glide exists since 004; the first-run note), the
comparison page (row "動作前游標先移過去" → ✓ 004; new row for "面板關著時把人叫來"), README "First
use" (one line: if the agent tells you the panel is closed, click the icon or Alt+A).

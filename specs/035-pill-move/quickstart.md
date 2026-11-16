# Quickstart: Validate 035

## Prerequisites

- `npm ci`, `npm run build`; the test TLS certificate (`npm run test:certs:verify`).
- The attached test Chromium of the packaged gate (CLAUDE.md "Browser suites"): `--remote-debugging-port=9222`,
  `apps/extension/dist/agent` loaded, a private `LOCALAPPDATA`, `HALLPASS_FOREIGN_AGENT_SERVERS=allow`.
- Run: `HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222 npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-pill-move.spec.ts --reporter=list`

## Unit checks

`npx vitest run --project unit apps/extension/tests/indicator.test.ts apps/extension/tests/cursor.test.ts apps/extension/tests/pill-edge-store.test.ts apps/extension/tests/agent-pill-move.test.ts`

Covers: `placeFor` (clear, overlap owner edge, overlap both, box vs point, 8 px margin, short viewport); the
`box` validator; the edge store (default, bad value, write, restart load); the move press (trust, `to`
values, extra field, redraw of every held tab); the open press (open issued before any await, reply on
success and failure, no lease needed, extra field refused); the page's not-opened message and no resend.

## Live scenarios (packaged gate, en-US and zh-TW)

| # | Story | Steps | Expected |
|---|---|---|---|
| 1 | US1 | Session holds two tabs; trusted press on "Move to bottom" in tab 1 | Both pills at bottom-right within 1 s; control reads "Move to top" / 「移到上方」 |
| 2 | US1 | Navigate tab 1; add a third tab to the session | New pills drawn at the bottom from the start |
| 3 | US1 | Restart the worker (and, once, the browser) and start a new session | Pill at the bottom (SC-233) |
| 4 | US1 | Page-made `click()` on the move control | Nothing moves, stored edge unchanged |
| 5 | US2 | Fixture button under the top-right pill area; owner edge top; agent `click` by ref on it (×20) | Page button gets every click, no pill control pressed; pill was at the bottom during the step (SC-234) |
| 6 | US2 | Next agent step points at the page centre | Pill back at the top (SC-235) |
| 7 | US2 | Tall right-side element covering both areas; agent hovers it | Pill stays at the owner's edge |
| 8 | US2 | `computer` left_click at a point under the pill | Same as 5 for a point without a box |
| 9 | US3 | Panel closed; trusted press on "Open side panel" | Panel of that window opens within 1 s; no session or site mode changed (SC-236) |
| 10 | US3 | Panel already open; press again | Panel stays open, nothing else |
| 11 | US3 | Page-made `click()` on the open control | No panel opens |
| 12 | Edge | Held session (034) at the bottom: Stop, Resume, not-delivered message | Same behaviour as at the top |
| 13 | Edge | Screenshot while the pill is at the bottom | Pill hidden in the capture, visible after |

Owner's live run (SC-238), branded Chrome after reload: move the pill to the bottom on a real site, let an
agent click something that was under the old place, open the side panel from the pill; say whether the
look of the new controls is right.

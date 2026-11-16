# Quickstart: Validate Stop from the Page

## Prerequisites

- `npm ci`, `npm run build` in this worktree; the extension loaded from `apps/extension/dist/agent`.
- The attached test browser of the packaged gate (CLAUDE.md "Browser suites"): a Chromium with
  `--remote-debugging-port=9222`, a private `LOCALAPPDATA`, `HALLPASS_FOREIGN_AGENT_SERVERS=allow`,
  `HALLPASS_LOCALE=en-US` (and once `zh-TW` for the copy check), page fixtures from
  `npm run dev:test-pages` with the test certificate installed.

## Automated checks

```powershell
npx vitest run --project unit apps/extension/tests/agent-runtime-hold.test.ts apps/extension/tests/hold-store.test.ts
npx vitest run --project unit apps/extension/tests/indicator.test.ts apps/extension/tests/agent-indicator-sender.test.ts
npx vitest run --project extension-ui apps/extension/tests/session-card-hold.test.tsx
npm run build; npm run test:contract
$env:HALLPASS_CDP_ENDPOINT='http://127.0.0.1:9222'; npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-pill-stop.spec.ts --reporter=list
```

(The exact test file names are fixed by the tasks; these are the expected ones.)

## Live scenarios (packaged gate stories, main captures screenshots)

| # | Scenario | Expected | Covers |
|---|---|---|---|
| 1 | An outside session holds a fixture tab; a CDP mouse click on the pill's Stop | pill shows "Stopped" + Resume within 1 s; the card shows "Stopped from the page" + Resume | US1, FR-512, FR-520, SC-225 |
| 2 | While held, the agent calls `click`, `read_page`, `screenshot`, `tabs_context`, `find` | each answers `stopped` / `owner-held` with the hint; the page's click counter is unchanged | US1.2, FR-515, SC-226 |
| 3 | A consent card is up (site in `ask`), then Stop | card withdrawn, the waiting call answers `owner-interrupted`, the site mode is unchanged | US1.1, R-515 |
| 4 | Two sessions, two tabs; Stop on the first | the second session completes its calls | US1.3, SC-227 |
| 5 | Page-made `click()` on Stop and on Resume (20 each) | no state change | US1.5, US2.4, SC-229 |
| 6 | Resume on the pill; then hold again and Resume on the card | the next call runs each time; the refused call is not re-run | US2, FR-517 |
| 7 | Held, then stop the worker through its CDP target and let it restart; the session greets again | the call answers `owner-held`; the pill and the card still show the stopped state | US3.2, FR-518, SC-228 |
| 8 | Held, then reload the tab | the new page's pill is held | US3.4, R-518 |
| 9 | Held, then End session | the session ends; a new session on the same agent is not held | US2.3, US3.3, R-514 |
| 10 | Reload the extension (the page's old script loses its extension context; no shipped test switch), then Stop on the pill still on the page | the not-delivered words on the pill within 3 s | US5, FR-522, SC-230 |
| 11 | `HALLPASS_LOCALE=zh-TW`: scenario 1 | 「停止」, 「已停止」, 「繼續」, card 「已從頁面停止」 | FR-523 |

Side-panel conversation (US4) is Windows-only and needs a real conversation agent: main checks it once
by hand in the owner's Chrome, or the owner does in the look below.

## Owner's look (SC-231)

After the owner reloads the extension from the main checkout build: start a Claude Code task that uses
the browser, press Stop on the pill mid-task, type into the page by hand, press Resume, and confirm the
agent continues; also press Stop on the pill during a side-panel conversation turn.

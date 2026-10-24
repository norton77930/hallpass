# Quickstart: validating the settings page (024)

## Prerequisites

- Built tree: `npm install`, `npm run build`, `npm run agent-host:install` (host 0.16.0).
- Gate browser per CLAUDE.md "Browser suites": Chrome with `--remote-debugging-port=9222`, private
  `LOCALAPPDATA` shared by browser and runner, `HALLPASS_FOREIGN_AGENT_SERVERS=allow`,
  `apps/extension/dist/agent` loaded. Page fixtures: `npm run dev:test-pages` (certificate verified with
  `npm run test:certs:verify`).
- Fake agents: the broker test seams (`HALLPASS_BROKER_TEST_AGENT`, `FAKE_ACP_SCENARIO`) give the four
  agents without real installs; the slow-install knob added in S1 drives progress and Cancel.

## Machine checks

```powershell
npm run typecheck
npm test
npm run build:extension
npm run test:contract
npm run snapshot:check
```

Focused: `npx vitest run --project unit packages/agent-host/tests/broker-settings-024.test.ts`,
`npx vitest run --project extension-ui apps/extension/tests/settings-page.test.tsx`.

## Live gates (`tests/e2e/packaged/agent-settings-024.spec.ts`, one `live` gate each)

| Gate | Scenario | Pass when |
|---|---|---|
| L1 | Open from the panel menu, the picker and `chrome://extensions` → Details → Extension options | one settings tab, routed section shown (FR-375) |
| L2 | Four fake agents in four states | rows readable collapsed; attention cards open; "1 of 4 agents ready" (US1, SC-169) |
| L3 | Start a slow fake install, close the page, reopen | progress continues; Cancel returns Needs a download; finish tells once (US2) |
| L4 | Kill the gate browser during an install, relaunch | card says interrupted, offers Try again (D-024-9) |
| L5 | Test a working fake, an unreachable-model fake, Hermes fake without MCP component | passed with ms / failed naming the model server / partial naming the component (US3) |
| L6 | Test while a conversation with the same agent runs | conversation's turn and history unchanged (SC-176) |
| L7 | Switch off DeepSeek, make Hermes default, switch Hermes off | picker lists enabled only, Hermes preselected, then default moves by order and is announced (US4) |
| L8 | Sites: mode change, revoke + undo, unpair, remove upload folder | side-panel consent follows each change (US5) |
| L9 | Session card "Manage this site's permissions ↗" | page opens at Sites with the site marked; revoked site says not listed (SC-175) |
| L10 | Browser tools switch off | side-panel conversations chat only; outside agents unaffected (US6) |
| L11 | Connection & diagnostics: rename, copy details, show/copy last lines | name seen by `list_browsers`; no user path or key in copies (US7, SC-174) |
| L12 | Sessions tab with and without a session | no standing-permission controls; empty line + link (US8) |
| L13 | 375 px, keyboard only, en-US and zh-TW, light and dark | every control reachable, no sideways scroll (SC-173) |
| L14 | Open page and cards with a counting fake agent | zero model calls; states within 5 s with one hung `--version` (SC-177) |

Screenshots of L2, L3, L5, L11, L12, L13 go to `.scratch/024/shots/` and are compared with prototype A
(design source in spec.md) as a judged diff list, not pixel-exact.

## Real agents (owner machine, once before release)

Test on the owner's Claude, Codex and Hermes once each (costs three short model calls); DeepSeek install
measured for R-376 in `.scratch/024`.

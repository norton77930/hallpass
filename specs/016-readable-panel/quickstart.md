# Quickstart: validating 016

Prerequisites: the unattended attach recipe of `specs/015-honest-answers/quickstart.md` (Playwright
Chromium 151 on 9222, private LOCALAPPDATA, runner env), `npm run build:extension:agent` and
`npx tsc -b packages/agent-host` after every source change; stop any left-over fixture server on
19443 before a run that needs changed fixtures.

## Suites

```text
npm run typecheck
npm test                      # unit + extension-ui (panel components)
npm run test:contract         # frame + projection schemas, strings, version pins
npm run snapshot:check
```

## Gates (attach mode)

```text
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-panel-016.spec.ts
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-panel-shots.spec.ts
npm run test:e2e:agent        # whole suite; runs past the 20-min global bound → re-run the tail
```

Expected (`agent-panel-016`): two MCP sessions started from two scratch folders → two cards titled
by folder, different stripe colours matching their groups; one working (⌛ group, "working", interrupt
+ take back shown), one idle (plain title, "idle · last action", end only); a pending plan question →
🔔 group and "waiting for you"; a keystroke whose handler opens `alert` answers with the dialog;
status row "connected · 2 sessions", menu lists paired agents.

Screenshots (`agent-panel-shots`): zh-TW and en-US × light and dark, two sessions + two sites; saved
under the run's artifacts and copied to `docs/media/` for the owner.

## Owner checks (not automatable here)

- Their Claude Code sessions show their project folder on the card (R-203: depends on the client).
- Full `agent-*` gates on their current branded Chrome.
- Approve the screenshots before the 0.9.0 release.

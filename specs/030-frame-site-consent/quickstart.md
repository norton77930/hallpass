# Quickstart: validating spec 030

## Prerequisites

- `npm install`, `npm run build`, and the test certificate (`npm run test:certs:verify`).
- The packaged attach recipe from CLAUDE.md: Chromium with `--remote-debugging-port=9222`, a private
  `LOCALAPPDATA`, and `HALLPASS_FOREIGN_AGENT_SERVERS=allow`.

## Unit level

```powershell
npx vitest run --project unit apps/extension/tests/site-mode-gate.test.ts apps/extension/tests/agent-site-recheck.test.ts
npx vitest run --project unit apps/extension/tests/frame-site.test.ts
npx vitest run --project extension-ui apps/extension/tests/prompt-card.test.tsx
```

Expected: the gate prompts for `site: null` in every mode, a frame decision stores the frame's site, a
frame's own report is ignored, an opaque sender origin gives "unknown", and the card hides Allow always for an unknown site.

## Packaged gate

```powershell
$env:HALLPASS_CDP_ENDPOINT="http://127.0.0.1:9222"
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-frame-consent.spec.ts --reporter=list
```

| Scenario | Fixture | Expected |
| --- | --- | --- |
| Story 1 | top site in skip-checks; embedded form from the second site | a card naming both sites; the field is empty until Allow once |
| Story 1.3 | Allow always on that card | the site list shows the second site as skip-checks; the top site is unchanged |
| Story 2 | coordinate click on the embedded button | a card for the second site |
| Story 3 | sandboxed frame | a card for an unknown site, with no Allow always |
| Story 3.2 | `about:blank` and `srcdoc` frames | decided by the top site's mode |
| Story 4 | the frame navigates between the answer and the gesture | nothing reaches the new page; the agent is told that the frame moved |
| Story 5 | `read_page` on the fixture | the frame lists its site; references inside it carry it |
| Story 6 | a plan for the top site whose step 2 types into the frame | step 1 runs, step 2 asks |
| SC-206 | the existing `agent-frames`, `agent-input`, `agent-reads` and `agent-press-outcomes` gates | pass unchanged |

Gate screenshots of each frame card go to `test-results/<run-id>/` for SC-207.

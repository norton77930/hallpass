# Quickstart: validating the session site plan (017)

## Free checks

```powershell
npx tsc -b; npm run typecheck; npm test; npm run build; npm run test:contract; npm run snapshot:check
```

## Packaged gate (attach mode, real side panel)

Launch Playwright Chromium headed on 9222 with a private `LOCALAPPDATA` and `--no-sandbox` (test
Chromium sandbox issue on this machine, see the unattended-gate notes), then:

```powershell
$env:HALLPASS_CDP_ENDPOINT="http://127.0.0.1:9222"; $env:HALLPASS_FOREIGN_AGENT_SERVERS="allow"
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-site-plan.spec.ts --reporter=list
```

Expected (fixture pages on `https://localhost:19443` / `19444` / `19445` as three origins):

1. Agent proposes three origins → one card listing them with purpose and the steering warning.
2. Owner unticks one, approves → answer `approved` = 2, `leftOut` = 1.
3. Ten presses/types across the two approved origins → 0 consent cards (SC-121).
4. `evaluate` on an approved origin → card; upload → upload consent; press on the unticked origin →
   card; a second session pressing on an approved origin → card (SC-122).
5. Withdraw on the session card → next press asks; approve again, interrupt a step → plan kept; end
   session → new session asks; unpair → asks (SC-123).
6. Decline → `declined`, nothing granted. Invalid origin (`https://a.com/path`) → refused before any
   card.

## Release

- Owner's branded Chrome run of the same spec.
- Paid probe S17: `claude -p --model sonnet` with a three-site task; expect `propose_sites` first and
  one owner decision (SC-126).

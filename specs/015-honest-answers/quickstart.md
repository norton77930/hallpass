# Quickstart: validating 015

## Prerequisites

- `npm ci` in the worktree; `.test-pki` copied from the main checkout; `npm run build`.
- Unattended attach browser (developer Chromium 151): `tmp\m015-launch.ps1` pattern — Playwright's
  Chromium on port 9222 with a private `LOCALAPPDATA` holding a copy of the host manifest.
- Runner env: `HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222`, `HALLPASS_LOCALE=en-US`,
  `HALLPASS_FOREIGN_AGENT_SERVERS=allow`, `LOCALAPPDATA=<same private dir>`.

## Suites

```text
npm run typecheck && npm test && npm run test:contract && npm run snapshot:check
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-press-outcomes.spec.ts
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-batch-upload.spec.ts
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-downloads.spec.ts
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-   # full family
```

## Scenarios and expected results

| Scenario | Expected | Criterion |
| --- | --- | --- |
| Six link variants × press tools and batch | each answer names the real outcome ([press-outcomes](./contracts/press-outcomes.md)) | SC-109 |
| False-stale reproduction, 20 runs | 0 `stale` on an intact page; a hung page answers `page-not-responding` | SC-110 |
| Two downloads finishing B then A, two waits | B then A, then the third wait times out ([downloads](./contracts/downloads.md)) | SC-111 |
| Upload matrix standalone vs batch | identical outcomes; nothing outside roots without a yes ([batch-upload](./contracts/batch-upload.md)) | SC-112 |
| One session's pairing bound expires | card gone ≤ 2 s; with a second session it stays ([pairing-withdraw](./contracts/pairing-withdraw.md)) | SC-113 |

## Owner-run

- Chrome 153: launch with the gate script (debug port 9223, private profile), then the runner runs
  the new specs and repeats the FR-203 link measurement.
- Edge: register (already done by the installer since 010), load `dist/agent` unpacked, pair, read,
  press, upload; record results on issue #2 (SC-115).

## Unattended attach recipe used for 015 (T395)

The gates of this feature ran without the owner, on Playwright's own Chromium (151.0.7922.34):

1. Launch it with a private profile and a private `LOCALAPPDATA` that holds a copy of the host
   manifest (`<LOCALAPPDATA>\hallpass\com.hallpass.host.json`), with `--remote-debugging-port=9222
   --enable-unsafe-extension-debugging --lang=en-US --disable-features=LocalNetworkAccessChecks
   --no-first-run`. The launcher lived in the job's temporary folder, not in this repository.
2. Run the gates from this worktree with `HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222`,
   `HALLPASS_LOCALE=en-US`, `HALLPASS_FOREIGN_AGENT_SERVERS=allow` and `LOCALAPPDATA` set to the same
   private folder; the fixture loads `apps/extension/dist/agent` through `Extensions.loadUnpacked`.
3. After a rebuild the first gate can answer `stale-extension-build` once (the reload lands after the
   check); run it again.
4. The fixture servers are reused when their ports are busy (`reuseExistingServer`), so stop any
   left-over `page-fixtures.ts` process before a run that needs a fixture changed since it started.
5. To take the test harness out of a measurement (R-197 round 4), load the bundle with one raw
   `Extensions.loadUnpacked` call and drive the product only through the MCP client, with
   `HALLPASS_CDP_ENDPOINT` unset.

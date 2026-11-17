# Coverage: spec 036

Unit and UI tests live in `apps/extension/tests/`. Fixture captures come from
`apps/extension/tests/visual/capture-session-cards.mjs` (quickstart 3); the live run is
`tests/e2e/packaged/agent-panel-shots.spec.ts` in attached Playwright Chromium with a private `LOCALAPPDATA`.

## Requirements

| Requirement | Tasks | Tests | Captures / live |
|---|---|---|---|
| FR-538 two groups, order | T1053-T1055, T1057 | `session-card-model.test.ts` (groupSessions), `session-list.test.tsx` (grouping, Idle heading) | V1-V4; live zh-TW |
| FR-539, FR-540 open by default, owner's fold choice | T1053-T1055, T1057 | `session-card-model.test.ts` (isOpen, advanceFolds), `session-list.test.tsx` (toggle, transitions, vanished sessions) | live zh-TW |
| FR-541 header | T1057 | `session-card.test.tsx` | V1-V4 |
| FR-542, FR-543 primary action | T1056, T1057 | `session-list.test.tsx` (Answer focuses `#agent-consent-card`, Resume/Interrupt frames), `session-card-hold.test.tsx` | live zh-TW (Answer focus) |
| FR-544 last line | T1061 | `session-card.test.tsx` | V1-V4 |
| FR-545 - FR-548 sites and permissions | T1053, T1054, T1058, T1059 | `session-card-model.test.ts` (sitesOf), `session-card.test.tsx` (rows, marks, manage per site, withdraw) | V1-V4 |
| FR-549, FR-550 activity rows, merging | T1053, T1054, T1060, T1061 | `session-card-model.test.ts` (rowsOf: pairs, plan fold, tones, no scheme) | V1-V4 |
| FR-551 footer | T1061 | `session-card.test.tsx`, `side-panel-sessions-024.test.tsx` | V1-V4 |
| FR-552 - FR-554 look | T1063 | `panel-a11y.test.tsx` (`--line-soft` both themes, contrast), `connections-t608.test.tsx` | V1 (judged against prototype E), V2-V4 |
| FR-555, FR-556 words | T1062, T1063 | `tests/contract/locales.contract.test.ts`, card tests | V2, V4 (en-US) |
| FR-557 panel only | all | no change under `packages/`, `service-worker/`, `content-runtime/` (git diff) | - |

## Success criteria

| Criterion | Evidence | Result |
|---|---|---|
| SC-244 same frames | `session-list.test.tsx`, `session-card.test.tsx` frame assertions | Pass |
| SC-239 - SC-243 | fixture captures V1-V4 (acceptance review), live zh-TW run | Pass on captures and live zh-TW; live en-US leg blocked by the harness locale switch (see change log) |

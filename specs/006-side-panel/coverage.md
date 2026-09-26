# Feature 006 — acceptance coverage

The panel is not a tool, so the paid probe does not apply. Evidence per requirement: unit
(`extension-ui` project), the packaged attach family on the owner's Chrome 152, the accessibility test,
and the owner-reviewed screenshots (S2).

## Requirement → evidence

| Requirement | Claim (short) | Attach e2e | Unit / contract | Notes |
| --- | --- | --- | --- | --- |
| FR-081 | Four compositions derived from the projection only | `agent-panel-states` (not-paired → paired → two sessions) | `agent-shell.test.tsx` (`deriveComposition`) | R-125 |
| FR-082 | Not-connected page: heading, sentence, retry, technical details | `agent-panel-states` §not-paired; every `agent-*` spec clicks retry when shown | `agent-shell.test.tsx`, `NotConnected` literal keys | `recordPath` populated since 2026-09-14 (optional `relay-started.recordPath`, B15) |
| FR-083 | Paired-idle: status row + site list, no tab list | `agent-panel-states` §paired | `agent-shell.test.tsx`, `site-list.test.tsx` | site list also shown under session cards (B4) |
| FR-084 | Pairing card accept / ignore | `agent-pairing.spec.ts`, `agent-claim.spec.ts` (`acceptPairing`, `unpairAgent`) | `prompt-card.test.tsx`, `pairing-controller.test.ts` (`ignore` answers `declined`, next request asks afresh - amended 2026-09-24), `agent-panel-port.test.ts` (ignore sends a marked decline) | review fix 5; amended 2026-09-24 |
| FR-085 | Consent card once / always-on-site / refuse, arrival order | `agent-panel-states` (ask → prompt → allow once), `agent-actions.spec.ts` | `prompt-card.test.tsx` (arrival order), runtime prompts | review fix 4 |
| FR-086 | Site list switch 3 modes + revoke; permissive marked | `agent-panel-states` (set ask → prompts; revoke → row gone, default applies) | `site-list.test.tsx`, `site-mode-store` `clear()` | |
| FR-087 | Session cards; Stop → `owner-stopped`; Release → `not-yours`, still paired | `agent-panel-states` §two sessions | `agent-runtime-sessions.test.ts` (+ ungroup / indicator / attachments asserted), `agent-effects.test.ts` (ownership re-checked after a consent), `agent-wait.test.ts` (lease per poll), `mcp-server.test.ts` (host re-greets on `session-ended`), `session-card.test.tsx` (card named by the session's own `hello`, B16) | review fixes 1–3, 6, 7; B16 per-session name |
| FR-088 | Agent profile renders no archived component | every `agent-*` spec (no sign-in control) | `side-panel-app.test.tsx` | bundle still contains `AssistantApp` (static import) — nit, S2 may lazy-load |
| FR-089 | Name "Hallpass" / 瀏覽器代理橋接 | — | `release-build.contract.test.ts` (`_locales`), `write-manifest.ts` `catalogKeyFor` | |
| FR-090 | Narrow guard byte-identical | — | `narrow-manifest-guard.test.ts` | |
| FR-091 | Tokens once, light default, dark under the scheme | — | `panel-a11y.test.tsx` (tokens parsed from `tokens.css`), `agent.css` on tokens only | R-129 |
| FR-092 | Contrast ≥ 4.5:1 in both themes | — | `panel-a11y.test.tsx` (12 token pairs; lowest 4.87) | |
| FR-093 | Accessible names, keyboard, focus | — | `panel-a11y.test.tsx` (names, tab order, dialog focus) | |
| SC-050 | Screenshots owner-approved | `agent-panel-shots` (on request) | — | `screenshots/{idle,sessions}-{light,dark}.png`; **owner OK 2026-09-14** |

## Runs

| Date | What | Result |
| --- | --- | --- |
| 2026-09-13 | S1 unit / contract / typecheck / narrow guard / agent build | 1361 / 237 / clean / 1-1 / ok |
| 2026-09-13 | R1 review (code-reviewer) on the three owner commands | 1 must-fix + 4 should-fix + nits, all applied (tasks.md B8) |
| 2026-09-13/14 | Attach family zh-TW on Chrome 152 (17 agent-* specs) | 17 passed / 1 skipped (two test defects fixed on the way: a 4-char secret check colliding with a ref hash; a `wait forMs` over the 15 s bound) |
| 2026-09-14 | S2 unit / contract / narrow guard / attach family | 1373 / 237 / 1-1 / 17 passed 2 skipped |
| 2026-09-14 | Screenshots (real side panel, CDP) | 4 files, sent to the owner |
| 2026-09-14 | Owner review of the four screenshots | OK (SC-050 closed) |

# Spec 043 - coverage

## Requirement -> evidence

| Requirement | Success criterion | Evidence |
| --- | --- | --- |
| FR-620 hint on a terminal question with no *this session* | SC-280 | unit `packages/agent-host/tests/terminal-consent.test.ts` ("043 the hint on where to stop being asked"); worker flag `alwaysInBrowser` in `apps/extension/tests/prompts.test.ts` (T1201) |
| FR-621 no hint with *this session*, on diagnostics, transition, site-plan, unknown frame site | SC-280 | same describe, unchanged-message cases; contract `packages/contracts/src/agent-tools.test.ts` refuses `alwaysInBrowser` off `kind: "effect"` |
| FR-622 choices and answer rules unchanged | SC-281 | the 031 terminal-consent tests and the 017/031 gate tests pass unchanged apart from the extended message |
| FR-623 loopback is exactly `localhost`, `127.0.0.1`, `[::1]` | SC-283 | unit `packages/domain/src/loopback-site.test.ts` (look-alikes `app.localhost`, `localhost.`, `127.0.0.2`, `[::ffff:7f00:1]`, `localhost.example.com`, `127.0.0.1.nip.io` refused) |
| FR-624 *this session* offered on the loopback `evaluate` question | SC-282 | unit `prompts.test.ts` (choices `once, session, deny` on loopback, `once, deny` elsewhere), `prompt-card.test.tsx` (button on loopback only); packaged `agent-scripts-session-043` (card shows This session) |
| FR-625 the answer records a scripts grant for that session, agent and origin | SC-282 | unit `agent-diagnostics-gate.test.ts` (20 later scripts unasked), `session-grant-store.test.ts`; packaged `agent-scripts-session-043` (second `evaluate` unasked; a second session still asked) |
| FR-626 scripts and page-actions grants never admit each other | - | unit `session-grant-store.test.ts`, `agent-diagnostics-gate.test.ts` (FR-626 case), `site-mode-gate.test.ts` (flag ignored for every other tool), `agent-effects.test.ts`; packaged `agent-scripts-session-043` (a click still asked) |
| FR-627 a session answer off loopback is a once and records nothing | SC-283 | unit `agent-diagnostics-gate.test.ts` (FR-627 case, `agent.session-grant.not-applicable`), `prompts.test.ts` (client session answer refused off loopback) |
| FR-628 the session card shows the scripts grant as its own line | - | unit `session-card.test.tsx` (T1212); contract `tests/contract/prompt-waiting.contract.test.ts` (grants enum); packaged `agent-scripts-session-043` ("page scripts" line) |

## Live run (2026-11-23, test Chromium, private profile and bridge)

`tests/e2e/packaged/agent-scripts-session-043.spec.ts`, 1 passed, on `https://127.0.0.1:19443` at "ask". The packaged
fixtures are all loopback, so the "no *This session* off loopback" rule is pinned by unit tests only.

## Review (2026-11-23)

code-reviewer on the US2 diff: no Important finding. Follow-ups:

- N1 test gaps: the catch for a failed grant read (`agent.session-grant.read-failed`) and the runtime wiring of
  `scriptsGrants` have no unit test (the packaged run covers the wiring end to end). Fixed by #84: unit tests in
  `agent-diagnostics-gate.test.ts` (an unreadable grant asks and reports) and `agent-runtime-wiring.test.ts` (a
  This session answer admits the next `evaluate` through the runtime).
- N2 the grant read on the `evaluate` path is an unbounded `chrome.storage.session` wait, the same shape as its
  siblings.
- N3 the frame-decides branch of the offer is unreachable for `evaluate`; whoever adds a frame-targeted `evaluate`
  must make the gate and the recorder use the frame's site too.
- P1 (pre-existing) the site mode is read before the diagnostics question and used after it. Fixed by #87: an
  `evaluate` that asked the diagnostics question reads the site mode again once it is answered; unit
  `agent-diagnostics-gate.test.ts` (both directions of a mode change while the question stood, and one read when
  nothing is asked).
- Wording: the Recent activity row of an effect question says "Page actions" for every effect, `evaluate` included
  (`agent.activity.consentQuestion.effect`); it predates 043. Fixed by #88: an `evaluate` effect question's row
  says "Page scripts" (`question: "script"`); unit `prompts.test.ts`, `session-card.test.tsx`, contract
  `agent-tools.test.ts`; packaged `agent-scripts-session-043` reads both rows.

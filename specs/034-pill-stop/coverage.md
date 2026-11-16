# Coverage: spec 034

Unit and UI tests live in `apps/extension/tests/` unless a path says otherwise. The live suite is
`tests/e2e/packaged/agent-pill-stop.spec.ts` (T1017) in attached Playwright Chromium with a private
`LOCALAPPDATA`; "live N" is its scenario N.

## Requirements

| Requirement | Tasks | Tests | Live |
|---|---|---|---|
| FR-512 Stop on the pill | T1009, T1012, T1013, T1014 | `agent-indicator-sender.test.ts` (modes and words), `indicator.test.ts` (Stop drawn beside the existing control) | live 1, live 12 |
| FR-513 only the owner's press, only the tab's own session | T1008, T1011, T1013, T1014 | `agent-pill-press.test.ts` (wrong sender id, no tab, tab no session holds, extra fields refused), `indicator.test.ts` (untrusted click ignored) | live 5 |
| FR-514 Stop holds an outside session | T1008, T1010, T1011 | `agent-pill-press.test.ts` (hold set before the interrupt, consent card withdrawn, repeat Stop redraws), `agent-runtime-interrupt.test.ts` (a stop landing before the runner) | live 1, live 3 |
| FR-515 a held session's calls are refused | T1007, T1010 | `agent-runtime-hold.test.ts` (each tool family, re-check before dispatch), `agent-pill-press.test.ts` (upload-directory question answered `held`, also when Stop lands during its site lookup; batch steps), `packages/agent-host/tests/mcp-server.test.ts` (`held` → `owner-held`, single and batch step) | live 2 |
| FR-516 only that session | T1007, T1008 | `agent-runtime-hold.test.ts` (another session runs) | live 4 |
| FR-517 Resume from the pill or the card | T1008, T1011, T1015, T1016 | `agent-pill-press.test.ts` (Resume), `session-card-hold.test.tsx` (Resume button sends `ui.agent.session-resume`) | live 6 |
| FR-518 the hold lasts until the owner lifts it | T1005, T1006, T1010 | `hold-store.test.ts` (store, malformed records, `__proto__`), `agent-runtime-hold.test.ts` (load barrier, load retry, a retried load redraws the pills), `agent-pill-press.test.ts` (end paths and unpair clear the hold) | live 7, live 8, live 9 |
| FR-519 side-panel conversations | T1008, T1011 | `agent-pill-press.test.ts` (conversation Stop forwarded, no hold; a conversation that greets a restarted worker drops the hold; a known outside session that greets with a token keeps it) | live 12 (T1019) |
| FR-520 the stopped state is shown everywhere | T1009, T1012, T1015, T1016 | `agent-indicator-sender.test.ts` (held pill), `session-card-hold.test.tsx` (held line, Interrupt hidden, activity lines) | live 1, live 6, live 8 |
| FR-521 what the agent is told | T1002, T1003 | `tests/contract/agent-tools-014.contract.test.ts` (reason list, `owner-held` with `HELD_HINT` parses) | live 2 |
| FR-522 confirmation and the not-delivered message | T1011, T1013, T1014 | `agent-pill-press.test.ts` (reply once, accepted after a failure past the hold), `indicator.test.ts` (resend at 1 s, words at 2 s) | live 10 |
| FR-523 copy | T1004 | `tests/contract/locales.contract.test.ts` (parity) | live 1 (en-US), live 11 (zh-TW) |
| FR-524 one internal message shape each way | T1003, T1011, T1012, T1014 | `agent-pill-press.test.ts` (closed press shape), `indicator.test.ts` (words drawn as text) | - |
| FR-525 the agent-facing protocol | T1002, T1003 | `tests/contract/agent-tools-014.contract.test.ts` | review-arch-k |

## Success criteria

| Criterion | Evidence | Result |
|---|---|---|
| SC-225 stopped state within 1 s, 10 of 10; no page change after | live 1 repeated 10 times; unit pins for a stop before the runner and before a batch's first step | Pass: 10 of 10 (live 1 x10 on the final build; also 10 of 10 on each earlier build) |
| SC-226 every call that reaches the worker refused, each tool family, none reach a page | live 2; `agent-runtime-hold.test.ts` | Pass (en-US, zh-TW) |
| SC-227 a second session completes with no refused call | live 4 | Pass (en-US, zh-TW) |
| SC-228 held after a worker restart, 5 of 5 | live 7 repeated | Pass: 10 of 10 (live 7 x10) |
| SC-229 0 of 20 page-made clicks change state | live 5 (20 on Stop, 20 on Resume) | Pass (en-US, zh-TW) |
| SC-230 not-delivered message within 3 s, 5 of 5 | live 10 repeated | Pass: 10 of 10 (live 10 x10) |
| SC-231 owner's own run | T1023 | pass (owner, 2026-11-16) |

## Live results

2026-11-15, build of fdff726 (review round 4), attached Playwright Chromium with a private
`LOCALAPPDATA`, one profile per locale, the fake ACP agent for live 12.

| Run | Result |
|---|---|
| en-US, whole suite | 11 passed, 1 skipped (live 11 is zh-TW only) |
| en-US, live 1, 7 and 10 repeated 10 times each | 30 passed |
| zh-TW (`--lang=zh-TW`, `HALLPASS_LOCALE=zh-TW`), whole suite | 11 passed, 1 skipped (live 1 is en-US only; live 11 takes its place) |
| Earlier builds | the same suite passed on the round-1, round-2 and round-3 builds (en-US) |

The first zh-TW run failed live 12 only because the test looked for English words in the
conversation's notice; the helper now reads the locale's own words, and both locales pass. In zh-TW
the pill read 停止, then 已停止 with 繼續, and the card 已從頁面停止 with 繼續 (screenshots s11-zh-*).
Run directories are under `test-results/` (local, not published).

## Reviews

| Review | Result |
|---|---|
| code-reviewer, slices K + W (T1021) | Round 1: 3 Important (a conversation held before it re-greeted a restarted worker; upload-directory card for a held session; error-path pins), fixed in ca45330. Re-review: 1 Important (upload question checked the hold before an await), fixed in 33c4f7d. Re-review: 1 Important (the greeting guard read a field the greeting rewrites), fixed in round 3 (a1b693b) with the owner's OK. Re-review: 1 Important (a session whose first greeting carried a token could still lift its hold); the owner chose to decide from the press instead of greetings (round 4, fdff726). Re-review: 0 Important; 2 Nits (a sequence that needs `storage.session` reads to keep failing, recorded as a known limit in R-514; two new lines not pinned by a test, a follow-up). |
| architecture-reviewer, slice K (T1021) | Round 1: 1 Important (the upload card, same as above; the owner chose the `held` link decision). Re-review: 0 Important; nits applied to the docs and to round 2. |

## Follow-ups (not in this spec)

- One shared type module for the pill messages (architecture review round 1, N3).
- The side-panel card's Interrupt is lost when it lands in a batch's reads before the batch registers (pre-existing since 014).
- A Stop that lands inside a step's runner answers the step interrupted, but the runner may still finish (the existing interrupt design, 014 FR-182).
- An outside session that is not held yet can greet with a made-up side-panel token so that a pill Stop
  goes to the conversation path, interrupts nothing and sets no hold (a hand-written link client only;
  pre-existing routing by the greeting's kind, round-3 review P1).
- Pin the store write that turns a not-known hold into a known one, and the drop by a token greeting
  that arrives before the holds are loaded (round-4 review N2).
- The card's state line says "Idle" while held; the held line says "Stopped from the page" (owner's look, T1023).

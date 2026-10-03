# Coverage: Session Site Plan (017)

**Branch / worktree**: `worktree-relay-no-cross-browser-supersede` (`.claude/worktrees/relay-no-cross-browser-supersede`),
spec commit da3ef63 on top of the two-browser relay fix 8ff9ee8. Implementation commits 2f78a06, b73ce5c,
625d212, 498cb9d, 919d820, 3c70abc.

**Baseline (before 017 code)**: unit + extension-ui 1607 passed / 1 skipped; contract 255 passed / 3
skipped; snapshot 671 files, 0 forbidden paths, 0 pattern hits.

**At 3c70abc**: unit + extension-ui 1723 passed / 1 skipped; contract 269 passed / 3 skipped; snapshot
681 files, 0 / 0; packaged gate `agent-site-plan.spec.ts` 4 / 4 on Playwright Chromium 151 (attach,
`--no-sandbox`, private LOCALAPPDATA, Chromium host key pointed at the worktree host for the run and
restored). Regression: every `agent-*` gate 66 passed / 0 failed / 3 skipped by design (two runs: the first hit the 20-min global timeout after 50 passed, the remaining 16 passed in a second run).

**Reviews**: architecture review of S1 (no blocker; covered set trimmed to the approved FR-254, store
write failure reported, store queue, one site key, transitions independent — all applied); code review
of S2 + S3 (no blocker; M1 agent-bound admission, m1 unpair withdraws a pending card, coordinate-press
test — all applied).

## Requirement → evidence

| Req | Evidence | Result |
| --- | --- | --- |
| FR-249 tool, description | contract `agent-tools-017` (schema, descriptor, not a batch step); host `mcp-server.test.ts` "017 site plan" (listed) | pass |
| FR-250 validation names first bad entry | `agent-tools-site-plan.test.ts` (12-row table + first entry); gate test 4 (path origin refused, no card) | pass |
| FR-251 one card, session, list, purpose/steps, warning | `site-plan-card.test.tsx`; gate test 1 | pass |
| FR-252 approve (≥1 ticked) / decline answers | `site-plan-card.test.tsx`, `prompts.test.ts` "017", `agent-tools-site-plan.test.ts`; gate tests 1 and 4 | pass |
| FR-253 only the owner approves | contract command strictness; `agent-panel-port.test.ts` (outside-proposal / forged id grant nothing); `prompts.test.ts` subset | pass |
| FR-254 covered page actions admitted | `site-mode-gate.test.ts` "017" matrix; `agent-runtime-site-plan.test.ts` (click, coordinate press, dialog, batch); gate test 1 (ten actions, 0 cards — SC-121) | pass |
| FR-255 page JS and uploads still ask | gate matrix; runtime tests (evaluate, file_upload, upload_image); gate test 1 (evaluate) | pass (uploads: unit only) |
| FR-256 unlisted sites / other sessions unchanged | runtime tests; gate test 1 (unlisted 19445, second session) | pass |
| FR-257 / D-017-9 follow-a-plan covered, skip-checks unchanged | gate matrix; `agent-batch.test.ts` "017" | pass |
| FR-258 lifetime (session end, unpair incl. restart, interrupt keeps, never persisted) | `site-plan-store.test.ts`; runtime tests; gate test 3 (withdraw, interrupt, unpair, session end — SC-123) | pass (browser restart: by construction, storage.session) |
| FR-259 session card summary + withdraw | `session-card.test.tsx`; gate test 3 | pass |
| FR-260 replace on a second proposal | `agent-tools-site-plan.test.ts`, runtime test (replaced line) | pass |
| FR-261 pending proposal withdrawn at session end / unpair | runtime tests | pass |
| FR-262 transitions unchanged | runtime tests (covered→unlisted, approved→approved); gate test 2 | pass |
| FR-263 activity lines | contract (activity kind); runtime tests; gate test 1 (approved line) | pass |
| FR-264 en-US / zh-TW, a11y, light/dark | locale contract; `site-plan-card.test.tsx` (keyboard, CSS tokens) | pass |
| FR-265 old extension → unavailable | host test (worker without `site-plan`) | pass |
| SC-121 1 card instead of 10 | gate test 1 | pass |
| SC-122 4 still ask | gate test 1 (evaluate, unlisted, second session); uploads by unit tests | 3/4 in gate + unit |
| SC-123 ends after session end / unpair / withdraw / browser restart | gate test 3 (3 of 4); browser restart by construction | 3/4 in gate |
| SC-124 full list before approve, unticked never approved | gate test 1; card tests | pass |
| SC-125 no agent argument approves | contract + panel-port + prompts tests | pass |
| SC-126 paid probe S17 | `probe:004 --slice S17` on branded Chrome 154.0.8037.92, `claude` 2.1.287 (report 004-2026-10-02T17-34-58Z): first call `propose_sites` with the three origins, owner approved once (approved 3, leftOut 0), then form_input / type on two sites ran with no card. First run timed out (owner away, no-answer) | pass |

## Follow-ups (not in scope, recorded)

- ~~Session card and the "already approved" marks read the stored plan without the agent check (admission is agent-bound).~~ Fixed 2026-10-03 (`planOf` in the runtime; `agent-runtime-site-plan.test.ts` "re-announced by another agent").
- `propose_sites` could be answered `blocked-by-dialog` if a host sent it with a tabId while a dialog is open (`DIALOG_PASS_THROUGH`). Kept as recorded: the host never sends this tool with a tabId.
- ~~Tick state on the card resets if an earlier question takes the top slot and hands it back.~~ Fixed 2026-10-03 (state held by `PromptCard`; `prompt-card.test.tsx` "keeps the unticked sites").
- ~~IDN origins show as punycode on the card.~~ Fixed 2026-10-03: Unicode with the ASCII host beside it on every panel surface (`display-origin.ts`, code review applied; spec change log).
- `computer` screenshot / wait actions are admitted under a plan (reads). Kept: reads never needed a card.
- An orphaned plan of an old session id after a worker restart stays until unpair or browser restart (unreachable). Kept as recorded.
- `docs/zh-TW/qa-guide.html` still describes 0.9.0 (needs screenshots). With the next release.
- ~~Probe S17: the agent's coordinate click on example.com's heading (no ref, guessed at 400,150) answered `target-not-located`; unrelated to the plan (no card was raised), but the agent could not finish step 3 without a screenshot.~~ Fixed 2026-10-03: the answer now carries a hint to take a screenshot or use a ref (`agent-effects.test.ts` "target-not-located hint").

### Two-browser stand-by (relay fix on this branch), 2026-10-03

- Stand-by churn: the worker's reopen backs off 5 → 10 → 20 s while standing by (owner chose worker backoff over a resident stand-by host); takeover after the serving browser closes takes up to ~20 s.
- Stand-by survives a worker eviction (`agentBridgeStandby` in `storage.session`, bounded by the retry alarm period plus the cap).
- The owning relay repairs `bridge-owner.json` on its record poll (closes the read-then-rm window); the poll stops once the relay leaves.
- Contract: the built panel projection accepts `bridge: "standby"`.
- Open: a host that greets and drops within the 3 s hold on every cycle keeps the panel on stand-by (pre-existing hold-through-drop rule). Full multi-browser selection (per-browser id and name, agent-side choice) goes to spec 018.

## Owner run (T492), 2026-10-03

- Branded Chrome 154.0.8037.92, private profile + private LOCALAPPDATA, host key pointed at this branch: `agent-site-plan.spec.ts` 4/4 (first run 3/1: the fixture's launcher page closed under `openSidePanel` in test 1; re-run green, no product assertion failed).
- Probe S17: pass (see SC-126).

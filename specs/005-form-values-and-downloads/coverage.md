# Feature 005 — acceptance coverage

Which scenario of the acceptance probe (`tests/acceptance/probe-004/scenarios/`, reused unchanged
except for the two new slice names S7/S8) closes which requirement, in the same form as
`specs/004-reference-parity-bridge/coverage.md`. A requirement whose only evidence is a fixture or a
unit test is named as such rather than counted as covered by the probe. Probe reports are attached
under `tests/acceptance/probe-004/reports/` at T187.

**Baseline source, every scenario: `browser-tree`** (unchanged from 004, R-118).

## Requirement → scenario

| Requirement | Claim (short) | Probe scenario(s) | Success criterion | Also proven by |
| --- | --- | --- | --- | --- |
| FR-072 | Every text entry, select and toggle node carries its current state (`value` / `checked`) on `read_page` and `find` | `s7-form-values` (typed name, clicked size + topping, second read) | SC-039 | `agent-form-values` (fixture: text, email, select, multiple select, textarea, checkboxes, radios; `find "email"`), `field-state.test.ts`, `collector-field-state.test.ts`, `agent-reads-field-state.test.ts` |
| FR-073 | A password/hidden input or a secret-autocomplete field is `redacted: true` with no `value`; empty carries neither | **not a probe scenario** — httpbin's form has no such field | SC-040 | `agent-form-values` (filled password + `cc-number` redacted, filled email carried), `field-state.test.ts` (token table), `agent-read-tools.contract.test.ts` (value beside redacted refused) |
| FR-074 | `value` is cut at the label bound with `valueTruncated: true`; textarea line breaks kept | **not a probe scenario** | — | `field-state.test.ts`, `agent-reads-field-state.test.ts` (cut value survives the frame merge), `agent-form-values` (two-line textarea) |
| FR-075 | Archived remote path unchanged: shape, consent, narrow manifest (the shared content bundle does change; the branch is agent-only) | **not a probe scenario** — `narrow-manifest-guard.test.ts` (byte comparison) | SC-041 | `collector-field-state.test.ts` (a `reviewed` read carries none of the four), the unchanged 001/002 suites |
| FR-076 | The agent build observes downloads through two listeners and never starts, opens, shows, accepts, pauses, resumes, cancels, removes or erases one | **not a probe scenario** — a source-level claim | — | `download-observer.test.ts` (reads `chrome-adapters/downloads.ts` and the worker tree: only `onCreated`/`onChanged` are named), `release-build.contract.test.ts` (`downloads` on the agent profile only), `narrow-manifest-guard.test.ts` |
| FR-077 | A download is attributed to every session holding ≥ 1 tab when it began (`session` / `shared`); none when nobody holds one | `s8-download` (a held tab navigates to the zip; the record is the session's) | SC-042, SC-043 (first half: `shared` is a unit claim, no two-caller probe) | `download-observer.test.ts` (one holder, two holders → `shared`, none → dropped), `agent-tab-manager.test.ts` (`sessionsHoldingAnyTab` from the leases), `agent-runtime-wiring.test.ts` (a download before the lease is not listed; one after it is) |
| FR-078 | `wait` `download-complete` (no `ref`) ends on the newest attributed download's terminal state with `download {id, filename, url, state}`; a completion before the wait is answered once, never twice; `bound-reached` otherwise | `s8-download` (wait answers `complete` with the saved path) | SC-042 | `agent-wait.test.ts` (fast completion answered once, second wait `bound-reached`, canceled answered as its state, owner Stop, foreign tab refused), `download-observer.test.ts` (watermark), `agent-downloads.contract.test.ts` (ref refused, result shape), `agent-downloads` e2e (a real file's path exists on disk; second wait `bound-reached`) |
| FR-079 | `downloads_context` lists the session's records newest first, ≤ 20, with the browser's own fields, and needs no tab | `s8-download` (listed exactly once) | SC-042 | `agent-downloads.test.ts` (runner: the session's ring only, no lease), `download-observer.test.ts` (bound 20, newest first, `onChanged` updates name/state/bytes), `agent-downloads.contract.test.ts` (record shape, bound), `mcp-server.test.ts` (offered as the 29th tool) |
| FR-080 | Records live in session storage with the session and are discarded when it ends; they carry nothing from any page | **not a probe scenario** | SC-043 (second half) | `download-observer.test.ts` (`discard` drops one session's ring only), `agent-tab-manager.test.ts` (`onSessionEnded`), `agent-runtime-wiring.test.ts` (nothing of the ring is left after the session's stop), `agent-downloads` e2e (a successor session lists nothing) |

## Runs

| Date (UTC) | Slice | Report | Verdict | Notes |
| --- | --- | --- | --- | --- |
| 2026-09-13T12:16:43Z | S7 (`s7-form-values`) | `tests/acceptance/probe-004/reports/004-2026-09-13T12-16-43Z.md` | **done 1/1** — `values-read` | Owner's branded Chrome 152, attach mode, `claude -p`; typed name, clicked size + topping, `read_page` carried the value and the two `checked: true`. SC-039 closed. |
| 2026-09-13T12:17:30Z | S8 (`s8-download`) | `tests/acceptance/probe-004/reports/004-2026-09-13T12-17-30Z.md` | not-done 0/1 (`file-missing`) — **mechanism proven, two defects measured** | The download happened and was reported: `wait download-complete` answered in 1 ms with `state: complete`, `downloads_context` listed it once, `attribution: session`, path `C:Users<user>DownloadsHello-World-master.zip` — confirmed on disk by the orchestrator (351 bytes, 20:17 local). Verdict failed because (a) `navigate` to a URL the browser downloads answered `navigation-timeout` (a download never commits), and (b) the caller's sandbox cannot see the download folder, so it reported `fileExists: false`. Both fixed after this run (tasks.md B19): navigate answers ok + `download` when its URL became a download; the harness checks existence itself. Re-run below. |
| 2026-09-13T12:38:11Z | S8 (`s8-download`) re-run | `tests/acceptance/probe-004/reports/004-2026-09-13T12-38-11Z.md` | **done 1/1** — `download-reported; file exists` | After B19: `navigate` answered ok with `download`, `wait download-complete` complete, listed once, and the harness confirmed the saved path on disk (fresh file, 351 bytes). SC-042 closed. |

**Preconditions for a re-run** (unchanged from 004): the dedicated Chrome on 9222, no foreign `mcp-server.js`, the fixture server on 19443 started by *this* checkout (a server from an older checkout serves an older page list — measured 2026-09-13, `fixture.not-found`), and the probe launched detached (runbook).

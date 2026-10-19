# Coverage: 019 side-panel agent

## Baseline (main 36c9c39 + 019 docs, 2026-10-19)

| Suite | Result |
| --- | --- |
| typecheck | pass |
| unit + extension-ui | 147 files, 1988 passed, 1 skipped |
| contract | 32 files, 292 passed, 3 skipped (after T517's notices update) |
| snapshot:check | see the S0 commit |

## Requirement → task → evidence

Filled as tasks close. Status: — open, ✓ passing evidence named.

| Requirement | Tasks | Evidence | Status |
| --- | --- | --- | --- |
| FR-282 – FR-284 tabs, pinned cards, count | T543, T544, T549 | `side-panel-tabs.test.tsx`, `agent-shell.test.tsx`; gate T549 | ✓ |
| FR-285 – FR-288 conversation, header, actions, all panels | T537, T545–T547, T549 | `conversation-view.test.tsx`, `conversation-relay.test.ts`, `agent-panel-port.test.ts`, `broker-conversation-stream.test.ts`; gate T549, T564 (reopen reattaches) | ✓ |
| FR-289 strict on new/resume | T535, T539 | `broker-conversation-modes.test.ts` | ✓ |
| FR-290 – FR-291 cards, per-conversation rule | T536, T539 | `broker-conversation-permissions.test.ts`; `conversation-view.test.tsx` (no per-conversation answer for read/search/think, T572) | ✓ |
| FR-292 two modes only | T519, T535, T545 | `agent-conversation-019.contract.test.ts`, `broker-conversation-modes.test.ts` | ✓ |
| FR-293 Codex note | T545, T573 | `conversation-view.test.tsx` (wording after D-019-13) | ✓ |
| FR-294 card never expires into approval | T536, T541 | `broker-conversation-permissions.test.ts`; T541 measurement | ✓ |
| FR-295 panel close keeps agent | T522, T547, T564 | `broker-lifetime.test.ts` case (c); gate T564 | ✓ |
| FR-296 no process survives | T522, T524, T528, T571 | `broker-lifetime.test.ts`, `broker-job.test.ts`; T571 10/10 on Chromium and 10/10 on branded Chrome 155 | ✓ |
| FR-297 idle 10 min | T538 | `broker-conversation-lifecycle.test.ts` | ✓ |
| FR-298 crash | T538 | `broker-conversation-lifecycle.test.ts` | ✓ |
| FR-299 – FR-302 install, consent, version, no credentials | T530–T534, T548 | `broker-agents.test.ts`, `broker-install.test.ts`, `broker-redact.test.ts`, `first-use-card.test.tsx` | ✓ |
| FR-303 folders, scratch | T561, T562 | `broker-folders.test.ts`, `conversation-list.test.tsx`; T562 on branded Chrome 155: the dialog opened from the panel is the top of the window order, above Chrome (topmost owner) | ✓ |
| FR-304 index | T559, T560 | `broker-index.test.ts`, `conversation-list.test.tsx` | ✓ |
| FR-305 browser connection, duplicate tools | T550–T553, T565–T567 | `panel-sessions.test.ts`, `broker-browser-token.test.ts`, `mcp-server-panel.test.ts`, `broker-mcp-entry.test.ts`; T567 measured with real agents (8a06e7f, R-322) | ✓ |
| FR-306 start tab | T554 | `panel-sessions.test.ts` | ✓ |
| FR-307 same site rules | T550, T557 | `panel-sessions.test.ts`; gate T557 | ✓ |
| FR-308 changedBy | T556 | `site-mode-store.test.ts`, `site-list.test.tsx` | ✓ |
| FR-309 withdrawal | T555, T557 | `panel-sessions.test.ts`, `panel-session-ui.test.tsx`; gate T557 | ✓ |
| FR-310 no regression | T570 | full suites at 76a9153; gate 82/0/11 on Chromium; branded Chrome 155 66/0/3 | ✓ |
| FR-311 cap of three | T538 | `broker-conversation-lifecycle.test.ts` | ✓ |
| SC-134, SC-135, SC-137, SC-139 | T573 | branded Chrome 155 with real agents (below, `docs/reference-probe-019.md`): SC-134 5.3 s / 10.2 s; SC-135 Claude 10/10, Codex 10/10 after the shim (D-019-13); SC-137 history shown for both; SC-139 103 s / 71 s | ✓ |
| SC-138 | T570 | gate unchanged on Chromium and branded Chrome 155 | ✓ |
| SC-136 | T528, T571 | 10/10 on Chromium; 10/10 on branded Chrome 155 (below) | ✓ |
| SC-140 | T519, T535, T545 | `agent-conversation-019.contract.test.ts`, `broker-conversation-modes.test.ts` (two modes only, FR-292); T573 no full-access mode offered | ✓ |

## Regression and cleanup on Playwright Chromium (T570, T571 at 76a9153, 2026-10-19)

Attach mode, a fresh browser per file, private `LOCALAPPDATA`, the fake ACP agent; the Chromium host
key temporarily pointed at this checkout's host (owner-approved) and restored byte-identical after.

- **T570**: all 38 `agent-*` files — 82 passed, 0 failed, 11 skipped by design (multi-browser needs two
  browsers; screenshot specs). Two test changes, both because 019 moved things on purpose, not because
  behaviour regressed: `openSidePanel` now lands on Connections & sites (the panel opens on
  Conversation, FR-282), and `agent-panel-states` counts the not-paired page beside the panel consent
  switch (FR-309, shown before any external pairing). Its first run failed on the old count; the rerun
  passed. SC-138 says "unchanged", so these two edits are named here.
- **T571**: 10/10 trials (5 `Browser.close`, 5 `taskkill /F` of the main process), two streaming
  conversations each, 5 broker-tree processes: zero left every time, at 15.7–16.8 s (the broker's
  15 s redial window, R-312; kept for 0.13.0 by the owner).
- Branded Chrome runs of both go with T573.

## Branded Chrome 155 with real agents (T570, T573, 2026-10-19/20)

Owner-launched branded Chrome, private profile and `LOCALAPPDATA`, the shipped 0.13.0 package.

- **T570**: 36 spec files attached, 66 passed, 0 failed, 3 skipped by design; SC-138 pass.
- **T573**: quickstart §4 with Claude Code and Codex 0.163.0. It found three defects, each fixed
  test-first and re-checked live: the first-use Download hang (1a3dc21), Codex strict writing in its
  folder without a card (shim 3718cb8 + ea7c010, D-019-13; 10/10 asked after), and a resumed
  conversation without its history (2159884; shown for both agents after). Report:
  `docs/reference-probe-019.md`.
- **T571** (2026-10-20, shipped 0.13.0 extension, private profile and `LOCALAPPDATA`, fake ACP agent):
  10/10 trials (5 `Browser.close`, 5 `taskkill /F` of the main process), two streaming conversations
  each, 5 broker-tree processes, zero left every time at 15.8–17.1 s. One planned close trial never
  reached measurement (extension load, then tab list timed out at setup) and was run again. The
  attached `agent-conversation` spec failed once on its harness's worker socket
  (`cdp-worker-socket-failed`) and passed 9/9 on the next start.

## T529 security review of S2 (2026-10-19)

Verdict: pass, no must-fix. Admission, secret containment, process tree, adoption and worker isolation
hold. Follow-ups: F1 a ghost adoption (reused pid, broker already shutting down, crash without
sidecar removal) leaves a run without a broker — fail closed but silent; fixed in S4 by a forced spawn
when no broker greets within 5 s of adoption. F2 sidecar read-then-remove race — accepted. F3 the
relay does not notice a broker that dies mid-run — handled with F1 in S4. F4 assert the broker's
command line and environment carry no secret. F5 `host/broker.js` and koffi in the package — S9.

## T558 security review of S6 (2026-10-19)

Verdict at 640ce36: pass, no must-fix. Admission is worker-side only (live token in memory, agent id
`panel:<the token's conversation>`, the worker's own consent record); a `panel:` id never pairs
externally and a token greeting is never downgraded; token frames are accepted only from the attested
broker session; no token reaches storage, `bridge.json`, the index or a diagnostics ring.
Should-fix, all applied before the gate commit: S1 withdrawing consent makes the broker revoke every
live run's token and a re-grant does not re-mint for a live run (only a new agent process gets a
token); S2 the broker's consent record is per browser (`conversation-consent\<browserId>.json`; the old
shared file reads as unknown and is left untouched); S4 `conversation-relay` no longer hands
`conversation-browser-token` frames to the injectable `deliver` hook. S3 (the token may appear on the
agent's own command line or logs, beyond the mcp-server env) is to be measured and written into R-321
in S8/S9. Accepted: the one-bit `token-unknown` diagnostic, the card-less start-tab claim (FR-306),
no author for an ended session (R-328), withdrawal order, re-grant without a start tab after a relay
restart, dropped shutdown revokes (the worker revokes on the broker's session end). Follow-up: a
resume through send/open does not check the broker's consent (the worker still refuses).

## Packaged gate 019 (T549, T557, T564, 2026-10-19)

`tests/e2e/packaged/agent-conversation.spec.ts` on Playwright Chromium (attach mode, private
`LOCALAPPDATA`, fake ACP agent through `HALLPASS_BROKER_TEST_AGENT`): 9/9 in two consecutive runs
(T549 4/4, T557 1/1, T564 4/4). It found that Stop left no word in the conversation; the broker now
ends a stopped turn with a `turn-stopped` notice (English broker text, like `turn-failed`). Not
automated here: the download-size first-use card (the test agent reports both agents ready), the
US4.3 "reconnecting" notice, and the T562 dialog z-order (owner check).

## S2 measurements (T528, 2026-10-19)

`packages/agent-host/tests/broker-lifetime.test.ts` against the built relay and broker, run 10 times in
a row on the development machine (Windows 11, Node 24): **10/10 runs, 50/50 tests passed**. Each run
starts the relay with a fake native port; the relay starts the broker; the broker (inside its
kill-on-close job) starts the fake ACP agent as `cmd.exe /c node …` with one child and one detached
grandchild, so every tree is 5 pids: broker → cmd.exe → agent → {child, detached grandchild}. The
parent chain (agent's parent = cmd.exe, cmd.exe's parent = broker) is asserted from Win32_Process.

| Case | Before | After |
| --- | --- | --- |
| (a) ack | no broker | 1 broker, sidecar `{pid, browserRunId, secretSha256, startedAt}`; greeting admitted, secret not forwarded, no 43-char run in either log |
| (b) hard kill of the broker | 5 pids alive | 0 of 5 within 2 s (the detached grandchild included) |
| (c) relay stdin closed, new relay of the same run | 5 pids | the same 5 pids alive, sidecar unchanged, one agent start in total; the broker greets the new relay |
| (d) relay stdin closed, no new relay | 5 pids | broker still alive at +3 s; 0 of 5 after the 15 s window (≥ 14 s, < 25 s); sidecar removed |
| (e) new relay of another run | 5 pids (old run) | old tree 0 of 5; new run's broker owns the sidecar and is alive |

After the 10 runs (and after the full `packages/agent-host` suite), a Win32_Process scan found no
`broker.js`, fake-agent or grandchild process left. Not measured here: the manual Chrome close and
`taskkill /F` of chrome.exe with the built host (main session).

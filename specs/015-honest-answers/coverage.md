# Coverage: Honest Answers (feature 015, Hallpass 0.8.0)

**Branch** `feature-015-honest-answers` (worktree `.claude/worktrees/fix-attention-and-indicator`,
from 334841e = 0.7.0 + follow-ups). Written for T427/T429 on 2026-09-27 at HEAD after 302ea94.
Browser for every gate: Playwright Chromium 151.0.7922.34 in attach mode (port 9222, private
profile and LOCALAPPDATA), `HALLPASS_LOCALE=en-US`.

## Slices

| Slice | Tasks | Commits | Review |
| --- | --- | --- | --- |
| Contracts | T396–T397 | b271527 | — |
| S2 every download once | T405, T415–T418 | c95a701, d5599d0 | — (not R1) |
| S3 uploads inside a batch (R2) | T409–T414 | e2551aa, c9dd000, 32eb6ad | code-reviewer PASS-with-findings (F1–F5 resolved with tests), re-review PASS |
| S4 pairing withdrawal | T419–T423 | b1c3a7f, c9dd000, 37168d1, 32eb6ad | code-reviewer PASS (withdraw-unsent log fixed) |
| S1 binding + press outcomes | T399–T408 | 2253fa0, e400639, d5599d0 | — |
| S0 / T402 the hang | T398, T402 | 7a81c0a, 3ec98aa, 0fc5f27, 302ea94 | code-reviewer PASS-with-findings (F1 fixed; F2–F4 follow-ups) |
| S5 close-out | T424–T429 | e6c8b6b, this commit | — |

## Findings recorded while building

- **Version skew (S4)**: a 0.7.0 worker parses `pair-request` strictly, so a host that always sent
  `requestId` left a not-yet-reloaded extension with no pairing card (8/8 prompt timeouts, live).
  The host now sends `requestId` only after the worker advertises `pair-withdraw`; proven live with
  the new host against the pre-015 extension bundle (1/1 paired and pressed).
- **The false `stale` / 10 s hang (R-197)**: first recorded as a harness artifact, withdrawn the
  same day. Reproduced with no Playwright connection and then with no extension at all: Chromium
  151 blocks a renderer on the first opener-keeping `window.open` pressed through CDP after the
  tab's cross-origin round trip. The product now bounds every `Input.*` dispatch at 10 s and answers
  `failed / page-not-responding`, with a hint that the input may have taken effect (review F1).
- **Review follow-ups not taken in 015** (T402 review): F2 keyboard dispatch is not raced with a JS
  dialog (a keydown that opens `alert` answers page-not-responding, the retry then answers the
  dialog); F3 a hung `mousePressed` leaves no `mouseReleased` (deliberate, unpinned by a test); F4
  the bound is per dispatch, not per call. S4 review: `reopenSession` leaves an old pairing timer
  (harmless, pre-existing).

## Final verification (T429)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` (unit + extension-ui) | 126 files passed, 1 skipped; 1507 tests passed, 1 skipped |
| `npm run test:contract` | 29 files, 249 / 249 |
| `npm run snapshot:check` | 632 files, 0 forbidden paths, 0 pattern hits (62 allowed) |
| `npm run package` (T427) | `release/hallpass-0.8.0.zip`, 715 086 bytes |
| every `agent-*` gate, one run (`npm run test:e2e:agent`) | 57 passed, 1 failed, 2 skipped, 3 did not run — the run reached the configured 20-minute global bound before the last three window-restore tests |
| re-runs | `agent-dialogs` "unsaved work" alone 3 / 3 and the whole file 4 / 4 (the suite failure is order-dependent: the browser raised no beforeunload in that position); `agent-panel-multi` + `agent-window-restore` 5 / 5 |

New 015 gates, each green in the final run: `agent-press-outcomes` (eight variants × click / computer
/ batch, plus the busy-page deadline case), `agent-false-stale` (20 rounds, SC-110),
`agent-downloads` two-download case (SC-111), `agent-batch-upload` 3 / 3 (SC-112),
`agent-pairing-withdraw` 2 / 2 (SC-113).

## Branded Chrome (T426, 2026-09-27)

The owner's Chrome had updated itself to **154.0.8037.57** by the time of the run, so this is the
branded-browser evidence (private profile, extension loaded unpacked by the owner, runner attached).

| Run | Result |
| --- | --- |
| `agent-press-outcomes`, `agent-batch-upload`, `agent-downloads`, `agent-pairing-withdraw`, `agent-false-stale` | 10 / 10 passed (3.5 min) |
| R-197 check, one raw CDP client, window.open after a cross-origin round trip | no block: control 73 ms, three round-trip runs 73–79 ms, page answering after each |

The R-197 check ran after the gates in the same browser; on Chromium 151 the block fired only on the
first such press per browser, so "not seen on 154" is the honest reading, not "fixed in 154". The
10 s bound stays either way.

## Not done here (owner)

- Edge run (`edge-015.ps1`, job tmp folder).
- Public 0.8.0 release (merge, host reinstall and extension reload done by the owner 2026-09-27).

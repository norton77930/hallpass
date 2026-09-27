# Coverage: A Readable Panel (feature 016, Hallpass 0.9.0)

**Branch** `feature-016-readable-panel` (worktree `.claude/worktrees/fix-attention-and-indicator`,
from `main` 5f8f27c = 0.8.0 as released). Baseline at 5f8f27c: unit 1507 (+1 skipped), contract 249,
snapshot 633 files 0/0.

Numbers per slice and the final verification are added as they land.

## S4 robustness (T447–T450)

- T447/T448 (FR-242): keyboard `type` / `key` and the focusing click raced with dialogs; RED → GREEN.
- T449 (FR-243): a held `mousePressed` answered late sends no `mouseReleased` — passed first time
  (behaviour already true; doc sentence added to `dispatchInput`).
- T450 (FR-244, R-210): **covered by D-011-7** — worker (presence lost at 30 s → bound 120 s from the
  raise) and host (ticks re-arm from `requestedAt`, panel-not-seen sentence) tests passed first time;
  no code change.

## Slices

| Slice | Tasks | Commits | Review |
| --- | --- | --- | --- |
| Contracts + worker identity/state | T431–T432, T435–T436 | f8749c0 | code-reviewer (with S3) |
| Host session label | T433–T434 | a84522e | code-reviewer (with S3) |
| Panel | T437–T440, T445–T446 | 73f1b4d, 1ec5d87 (card squeeze fix) | — (UI: screenshots) |
| Tab-group presenter | T441–T443 | 07387ed | code-reviewer PASS-with-findings; fixes 4210f3a |
| Robustness | T447–T450 | b67b738, f8749c0 | — |
| Gates | T451–T453 | e165515, d247cab, c43354e, 9bacd20 | — |
| Close-out | T454–T458 | 6191be3, 36385da, f832711 | — |

## Findings recorded while building

- **Cards squeezed to 0 px** (found only on the real-panel screenshots, T452): `overflow: hidden`
  on a flex item removes its content-based minimum height; with a question card and the site list in
  the shell's column both session cards rendered 0 px tall. `flex-shrink: 0` + a CSS assertion.
  Every DOM-level test had been green.
- **B2 / B5 were already true in 0.8.0** (R-209, R-210): pinned by tests, no behaviour change.
- **Review (T444)**: withdrawal of a group whose session holds none of its tabs (the next adopt opens
  a new group); roots request bounded at 5 s; next file root tried; ordering guard tests.
- **Unit teardown noise** (f832711): the longer tab-manager queue armed the reconcile alarm after a
  test's `chrome` stub was gone (9 unhandled rejections); read through `globalThis.chrome`.
- **Two gate races surfaced by 016's longer queue** (test-side, product behaviour correct):
  upload-directory took an outgoing card for the next one (c43354e); dialogs read the notice once
  before the projection push (9bacd20; measured 4–107 ms).
- **Owner decision (confirmed 2026-09-27, option A)**: while a session waits on a consent card, the
  card offers no "interrupt this step" (FR-233); the 014 gate path refuses the card instead.
- **Owner-check fixes before release (2026-09-27)**: a card without a folder no longer repeats the
  start time in its subtitle (FR-228); the upload-directories section says what it is for and that it
  is empty, with the list file as a quiet last line (FR-248). Tests in `session-card.test.tsx` and
  `site-list.test.tsx`.

## Final verification (T457)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | 128 files passed, 1 skipped; 1585 passed, 1 skipped; exit 0, no unhandled errors |
| `npm run test:contract` | 30 files, 256 / 256 |
| `npm run snapshot:check` | 654 files, 0 forbidden, 0 pattern hits |
| `npm run package` | `release/hallpass-0.9.0.zip`, 724 251 bytes |
| `agent-panel-016` gate | green |
| panel screenshots | `docs/media/016-panel-{zh-TW,en-US}-{light,dark}.png` |
| every `agent-*` gate, one run (Chromium 151 attach, after c43354e and 9bacd20) | **62 passed, 2 skipped (by design), 0 failed** (17.9 min) |

## Branded Chrome close-out (2026-09-27)

| Check | Result |
| --- | --- |
| every `agent-*` gate on branded Chrome 154.0.8037.57 (attach) | **62 passed, 2 skipped (by design), 0 failed** - 52 in the first run, which hit the 20-min global bound; the 10 not reached (`agent-upload-image` last test, `agent-upload`, `agent-viewport`, `agent-window-restore`) re-run separately, 10/10 |
| panel screenshots zh-TW / en-US, light / dark, plus the lower half (`016-panel-*-sites.png`) | captured on Chrome 154, owner approved |
| unit / contract / snapshot after the owner-check fixes | 1587 passed + 1 skipped / 256 / 656 files 0/0 |

Harness note: a debug Chrome started from the owner's own PowerShell window could not start the
native host (the `.cmd` ran, `node` never did; PATH, PATHEXT and SystemRoot restored made no
difference). Started through the session's `!` it worked at once. Root cause not found; it concerns
only how the test browser is launched.

## Owner checks (not done here)

- ~~Approve the four panel screenshots before the public 0.9.0 release.~~ Approved 2026-09-27.
- ~~Run the full gates on the current branded Chrome (the Chrome owner script from 015, pointed at this
  worktree).~~ Done 2026-09-27 on Chrome 154 (above).
- Confirm on your own Claude Code sessions that a card shows the project folder (R-203 depends on the
  client reporting roots or starting the server in the project directory).
- ~~Decide whether "interrupt this step" should also be offered while a consent card is waiting.~~
  Decided 2026-09-27: no (option A).

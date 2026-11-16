# Coverage: spec 035

Unit and UI tests live in `apps/extension/tests/` unless a path says otherwise. The live suite is
`tests/e2e/packaged/agent-pill-move.spec.ts` (T1047) in attached Playwright Chromium with a private
`LOCALAPPDATA`; "live N" is quickstart scenario N.

## Requirements

| Requirement | Tasks | Tests | Live |
|---|---|---|---|
| FR-526 two pill places | T1028, T1033, T1034 | `indicator.test.ts` (T1028 guard, T1033 top/bottom 8 px right 8 px) | live 1, live 2 |
| FR-527 the move control | T1025, T1029, T1030, T1033, T1034 | `agent-pill-move.test.ts` (T1025 words, T1029 every indicator message carries the edge and words), `indicator.test.ts` (T1033 control names the other edge, R-531 order) | live 1 |
| FR-528 the owner's edge is remembered for the browser | T1026, T1027, T1029-T1032 | `pill-edge-store.test.ts` (default, foreign value, read back, serialised writes, fresh instance), `agent-pill-move.test.ts` (T1029 first message waits for the load; T1031 move press stores `to` and redraws every held tab) | live 2, live 3 |
| FR-529 stepping aside | T1035-T1042 | `indicator.test.ts` (T1035 `placeFor`: owner overlap, 8 px margin, box overlap, both edges; T1036 place on the page), `cursor.test.ts` (T1037 box validator; 035/T1039 place applied before the glide and the arrival reply), `pointer-delivery.test.ts` (T1041 element tools send the target box, `computer` and drag end send none) | live 5, live 7, live 8 |
| FR-530 going back | T1036, T1039, T1040 | `indicator.test.ts` (T1036 a clear point returns to the owner's edge), `cursor.test.ts` (035/T1039 hide and rest return) | live 6 |
| FR-531 the open control | T1025, T1045, T1046 | `indicator.test.ts` (T1045 drawn beside back-to-tab, one send per trusted press) | live 9, live 10 |
| FR-532 the open happens at once | T1043, T1044 | `agent-pill-move.test.ts` (T1043 `sidePanel.open` issued before the listener returns and before any microtask), `action-entry.test.ts` | live 9 |
| FR-533 only the owner's press | T1031, T1033, T1043, T1045 | `agent-pill-move.test.ts` (T1031/T1043 bad `to`, extra field, foreign sender, no tab refused), `indicator.test.ts` (untrusted clicks send nothing) | live 4, live 11 |
| FR-534 when the panel does not open | T1043, T1045, T1046 | `agent-pill-move.test.ts` (T1043 `{opened:false}` on rejection), `indicator.test.ts` (T1045 `panelUnopened` on false, rejection or 2 s silence; never resent) | - |
| FR-535 captures and 034 | T1047 | `cursor.test.ts` (033/T996 marks hidden for a capture; edge-independent); 034 at the bottom has no unit pin, the live runs carry it | live 12, live 13 |
| FR-536 copy | T1025 | `agent-pill-move.test.ts` (T1025 words in both locales), `tests/contract/locales.contract.test.ts` (parity) | live (en-US and zh-TW runs) |
| FR-537 internal messages only | T1031, T1043 | `agent-pill-move.test.ts` (closed press shapes, listener returns `true`), `indicator.test.ts` (words drawn as text) | - |

## Success criteria

| Criterion | Evidence | Result |
|---|---|---|
| SC-232 every pill at the new edge within 1 s, 10 of 10 | live 1 | Pass: live 1 in both locales; 10 of 10 repeated (zh-TW) |
| SC-233 edge kept after a browser restart, 3 of 3 | live 3 covers a worker restart; a browser restart is the owner's run (T1051) | Worker restart: pass (both locales). Browser restart: owner |
| SC-234 20 agent clicks under the pill reach the page, 0 press a pill control | live 5 (20 ref clicks), live 8 (`computer` click) | Pass (both locales): 20 of 20 reached the button with the pill at the bottom, 0 pill presses |
| SC-235 back at the owner's edge after the next clear step, 10 of 10 | live 6 | Pass: 10 of 10 repeated (zh-TW), and once in en-US |
| SC-236 side panel opens within 1 s, 10 of 10, both locales | live 9 | Pass: 10 of 10 in en-US and 10 of 10 in zh-TW |
| SC-237 0 of 20 page-made clicks move, store or open | live 4, live 11 | Pass (both locales): 20 page-made clicks on each control, nothing moved, stored or opened |
| SC-238 owner's own run | T1051 | pass (owner, 2026-11-16) |

## Live results

2026-11-15, build of 3a0835e, attached Playwright Chromium 151 with a private `LOCALAPPDATA` and
`--no-sandbox`, one profile per locale. The suite has the 13 quickstart scenarios plus 9b (the
not-opened words after an extension reload) and 12b (034's not-delivered words at the bottom).

| Run | Result |
|---|---|
| en-US, `agent-pill-move.spec.ts` + `agent-pill-stop.spec.ts` | 25 passed, 2 skipped (034 live 11 is zh-TW only; 034 live 12 needs a configured side-panel conversation) |
| zh-TW (`--lang=zh-TW`, `HALLPASS_LOCALE=zh-TW`), the same two specs | 25 passed, 2 skipped (034 live 1 is en-US only; 034 live 12 as above) |
| zh-TW, live 1, 6 and 9 repeated 10 times each | 30 passed |
| en-US, live 9 repeated 10 times | 10 passed |

The first en-US run failed live 5-8 in setup: the test set the site's mode before the session had a tab
on the site, so the settings page had no row for it. The test now opens the session's tab first, as
`agent-actions.spec.ts` does; nothing in the extension changed. Each run saves a screenshot per state
(s01 top and bottom, s05 stepped aside, s06 back at the top, s07 tall target, s09b not opened, s12 held
and resumed at the bottom, s12b not delivered, s13 shown after a capture); s01, s05, s09b and s12 were
looked at in en-US and s01, s09b and s12 in zh-TW: the controls read Stop, Back to the agent's tab, Open
side panel, Move to bottom / Move to top, and 停止, 回到代理程式的分頁, 打開側邊欄, 移到下方 / 移到上方. Run
directories are under `test-results/` (local, not published).

## Reviews

None pre-selected (plan.md): no risk row fires. The pill's controls are checked live, the worker's
trust checks are pinned by unit tests.

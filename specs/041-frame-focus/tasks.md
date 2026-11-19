# Tasks: 041 focus check before keys

- [x] ~~T1113 [FR-578] RED unit test for the frame walk~~ withdrawn (D-041-1)
- [x] ~~T1114 [FR-578, FR-580] Frame walk in the focus confirmer~~ withdrawn (D-041-1)
- [x] ~~T1115 [FR-579] Unit test: a top-document target never runs the walk~~ withdrawn with the walk
- [x] T1116 [SC-263] Packaged spec `agent-frame-focus-041`: overlay scenario in an out-of-process frame and a same-site frame (passes on 0.26.2 too; a pin)
- [x] T1117 [SC-264] Packaged: no-overlay scenario verified
- [x] T1118 [FR-581, SC-265] Fixture with an editable body in an out-of-process frame; packaged type at a point verified; window-behind measured and recorded
- [x] T1121 [FR-582, FR-585, SC-268] RED unit tests: `type` with a target and an unknown check refuses `focus-unconfirmed` with no key; a hanging ask ends the check within the budget; rewrite the 039 test "does not type at all when the focus check could not run" so it asserts no key was sent
- [x] T1122 [FR-583, FR-584, SC-268] RED unit tests: `key` with a target checks before the key (miss -> `focus-lost`, unknown -> `focus-unconfirmed`, no key either way); unknown after the key -> `focus-unconfirmed`; `key` with no target -> `verified`
- [x] T1123 [FR-586, SC-268] RED unit test: a target the frame registry cannot resolve answers unknown, not a miss
- [x] T1124 [FR-582..586] Implementation: verdict `focus-unconfirmed`, time-bounded check, the check before `key`, unresolvable target unknown
- [x] T1125 [FR-587] Verdict in the closed schema, tool descriptions and docs that list verdicts
- [x] T1126 [SC-267] Packaged US3: fixture whose focusing click removes the frame (or replaces its document) and focuses a top-document input; `type` and `key` refused with nothing delivered; RED on 0.26.2 measured
- [x] T1119 [SC-266] Machine suite and the 040 + 039 + 038 packaged set
- [x] T1120 Change logs (039 follow-ups A, B, C; 004 T128 key verdict) and CHANGELOG at release

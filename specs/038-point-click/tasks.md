# Tasks: Clicks Land on What a Person Points At (038)

- [x] T1077 [AB] RED: collector unit test - a collection rooted at a ref minted for a `span` inside `li[role=menuitemradio]` (and for an `aria-hidden` element) contains that ref; a `div[role=option]` gets role `option` and its text as label; `li[role=menuitemradio]` gets role `menuitemradio` (FR-562, FR-565, FR-566)
- [x] T1078 [AB] RED: reads unit test - `filter: "interactive"` keeps `menuitemradio`, `menuitemcheckbox`, `treeitem` (FR-567)
- [x] T1079 [AB] GREEN: `snapshotDocument` adds the root; `collectPage` keeps the root's handle; `WALK_SELECTORS["all-controls"]` + name-from-content roles; `INTERACTIVE_ROLES` (R-544, R-546); update count-pinning tests with the reason
- [x] T1080 [AB] Fixtures `/popover-038` (menu: `button` opens `ul[role=menu]` of `li[role=menuitemradio]` > `div` > `span` labels "7 days", "Custom", "No expiration", choice recorded on `document.body.dataset.chosen`; a `div[role=listbox]` of `div[role=option]` "Issues", "Contents") and `/cover-038` (a 600x300 `div` recording its own clicks with a `button` covering its centre recording its own; page taller than the viewport)
- [x] T1081 [C] RED: effects unit test - a point target is delivered at the named point (not the located box centre), its locate is called with `scroll: false`, `confirmPoint` gets the named point; a ref target is unchanged (centre, `scroll: true`); drag endpoints and a keyboard point target likewise (FR-563, FR-564)
- [x] T1082 [C] GREEN: `deliverPointer` / `deliverKeyboard` point delivery (R-545)
- [x] T1083 [AB] Packaged spec `tests/e2e/packaged/agent-point-click-038.spec.ts`: SC-248, SC-249, SC-250; plus SC-252 as a test that runs only with `HALLPASS_LIVE_GITHUB=1` (public repo page, branch menu item by coordinates)
- [x] T1084 Machine verification on the merged branch: typecheck, npm test, build, test:contract, snapshot:check
- [x] T1085 Packaged gate: agent-point-click-038 + agent-actions, agent-pointer-033, agent-refs, agent-reads, agent-frames, agent-frame-consent, agent-press-outcomes, agent-input, agent-computer (SC-248..251); SC-252 with `HALLPASS_LIVE_GITHUB=1`
- [x] T1086 code-reviewer on the merged diff (R1: frame landing and point delivery)
- [x] T1087 Change logs: 003 (FR-040 walk), 004 (T128 point delivery) cite 038
- [x] T1088 CHANGELOG entries at release (owner's OK)

# Tasks: 039 point follow-ups

- [x] T1089 [FD] RED: content-runtime unit test - resolve-active-element with targetHandle resolves for the element, an ancestor (incl. across a shadow root), the label's control; misses for an unrelated field (FR-568)
- [x] T1090 [FD] RED: effects unit test - type/key at a point: focus on the editing host passes; unrelated focus refuses before keys; hint names a different receiving field (FR-568, FR-569)
- [x] T1091 [FD] RED: effects unit test - drag: two points in one element delivered; points < 1 px apart refused; same ref refused; plan step rules (FR-570)
- [x] T1092 [FD] GREEN: contracts + content runtime + content broker + effects (R-547, R-548)
- [x] T1093 [FD] Fixtures `editor-039` (contenteditable with nested spans; a `label for` + input; a point whose click focuses an unrelated input) and `drag-039` (canvas recording down/up points on `window.__drag039`)
- [x] T1094 [FD] Packaged spec `agent-type-drag-039.spec.ts`: SC-253, SC-254, SC-255
- [x] T1095 [L] RED: collector unit test - the root's link flag for a span inside `a[href]`, inside `[role=link]`, across a shadow root; not for an `a` without href (FR-571)
- [x] T1096 [L] RED: effects unit test - the locate sets `link` from the flag (FR-571)
- [x] T1097 [L] GREEN: contracts + collector + effects (R-549); fixture `link-039`; packaged `agent-link-039.spec.ts` (SC-256)
- [x] T1098 Machine suite on the merged branch; packaged gate 039 + 038 set (SC-257); RED on 0.26.0 production files
- [x] T1099 code-reviewer on the merged diff (R1: focus check before typing, drag refusal)
- [x] T1100 Change logs: 004 (T159 focus check), 015 (link flag), 003/038 (drag same-endpoints); CHANGELOG at release

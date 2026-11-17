# Tasks: A Session Card That Reads at a Glance (036)

**Input**: `specs/036-session-card-layout/` (spec, plan, research R-533..541, data-model, contracts, quickstart)

Every behaviour change comes with the focused failing test that would have caught its absence
(project rule; overrides the template's "tests optional").

## Phase 1: Setup

- [x] T1052 Worktree prep: `npm ci`; `npx tsc -b`; confirm `npm test` baseline count on d747ed4 (main)

## Phase 2: Foundational - the card model (blocks US1-US3)

- [x] T1053 [P] RED: `apps/extension/tests/session-card-model.test.ts` - sitesOf order/dedupe/no scheme/port/held-host-without-origin (R-534, FR-545, FR-546); rowsOf hold-resume pairs (1 and k), site-plan + consent fold within 2 s, other kinds pass through with tone (R-535, FR-549, FR-550); needsOwner, primaryAction, groupSessions order, isOpen + transitions (R-536, R-537, FR-538..540)
- [x] T1054 GREEN: `apps/extension/src/side-panel/agent/session-card-model.ts` per data-model.md

## Phase 3: US1 - which session needs the owner (P1)

- [x] T1055 [US1] RED: shell tests - two groups with "Idle (n)" heading; waiting/working/held open, idle folded, lone session open; owner toggle sticks and is cleared on needsOwner false→true (FR-538..540, FR-543)
- [x] T1056 [US1] RED: header primary action - Answer focuses `#agent-consent-card` and sends nothing; Resume sends `ui.agent.session-resume`; Interrupt keeps 014 FR-178 (nothing-to-interrupt line) (FR-542, SC-244)
- [x] T1057 [US1] GREEN: `SessionCard.tsx` header (bar, title, state line, primary action, open/fold button with `aria-expanded`, `data-open`); `AgentShell.tsx` grouping + fold state (R-537); `PromptCard.tsx` focus target (R-538)

## Phase 4: US2 - sites and permissions (P1)

- [x] T1058 [US2] RED: card tests - one row per site, marks, grants as "✓ kind" + place, manage per site sends `ui.agent.open-settings` with that origin, Withdraw on the section title sends today's frame, section absent with nothing (FR-545..548)
- [x] T1059 [US2] GREEN: "Sites and permissions" section; remove the old grants list, the single manage link and the site-plan block; `session-icons.tsx` (R-540)

## Phase 5: US3 - recent activity (P2)

- [x] T1060 [US3] RED: card tests - newest 3 rows with HH:mm, "Show all n"/"Show less", merged rows, no "https://" in any row, consent place shown (FR-549, FR-550)
- [x] T1061 [US3] GREEN: "Recent activity" section from rowsOf; footer (Take back tabs left, End session right as danger text, FR-551); last line "{time} · Technical details" (FR-544)

## Phase 6: US4 - look and words (P2)

- [x] T1062 [US4] RED: locale contract/test - every new key in both locales; zh-TW contains no 「主人」 in `agent.activity.*` (FR-555, FR-556); panel-a11y requires `--line-soft` in both themes (R-539)
- [x] T1063 [US4] GREEN: locale keys + key registry; `tokens.css` `--line-soft`; `agent.css` card styles per E (FR-552..554); remove unused old keys and styles
- [x] T1064 [US4] Fixture capture page `apps/extension/tests/visual/session-cards.{html,tsx}` (real `SessionCard` list via the same grouping/fold code as the shell, the prototype's six-session fixture, locale + scheme from the query) and `apps/extension/tests/visual/capture-session-cards.mjs`; capture V1-V4 (quickstart 3)

## Phase 7: Polish and cross-cutting

- [x] T1065 Update existing extension-ui tests that pinned the old card (FR-232 order, grant lines, site-plan block, held line) to the new structure; no deleted assertion without a replacing one
- [x] T1066 Packaged suites: update selectors/text in `tests/e2e/packaged/*.spec.ts` that read the old card (slice E); `agent-panel-shots.spec.ts` asserts the open waiting card with Answer and the folded idle card
- [x] T1067 Machine verification (quickstart 1)
- [ ] T1068 Live gate L1 (quickstart 4)
- [x] T1069 Spec bookkeeping: 016 change log notes FR-232 superseded by 036 FR-551; 008/017/024/031 change logs note their card text moved (036); coverage file `specs/036-session-card-layout/coverage.md`

## Dependencies

T1052 → T1053/T1054 → (T1055-T1057) → (T1058-T1059) → (T1060-T1061) → (T1062-T1064) → T1065 → T1066 → T1067 → T1068 → T1069.
US1-US3 touch the same `SessionCard.tsx`, so they run in one writer (slice U = T1053-T1065).

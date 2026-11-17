# Implementation Plan: A Session Card That Reads at a Glance

**Branch**: `spec-036-session-card` (from `main` d747ed4) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/036-session-card-layout/spec.md`, approved by the owner on
2026-11-17 including D-036-1..6. Design reference: prototype E on branch `prototype/session-card-ui`
(adf5dfb), `apps/extension/src/side-panel/agent/prototype-session-card/variant-e.tsx` and its capture
`shots/v-E.png`. The prototype is a picture to match, not code to merge (R-533).

## Summary

The panel alone changes. A new pure module turns one session's picture into the card's parts - its
site rows (R-534), its activity rows with Stop/Resume and site-plan merging (R-535), and whether it needs
the owner - and orders sessions into the two groups (R-536). `SessionCard` is rebuilt as a header (colour
bar, title, state line, one primary action) and a body (recording, "Sites and permissions", "Recent
activity", footer, quiet last line). The shell keeps each card's open/fold choice for the panel document's
life (R-537) and gives Answer a way to bring the consent card into view (R-538). Styling follows E on the
existing tokens plus one hairline token (R-539); icons are drawn in-house (R-540). Locale keys are added
and the zh-TW owner sentences move to the second person (R-541). No frame, field or worker code changes.

## Technical Context

**Language/Version**: TypeScript, React 19 (side panel)

**Primary Dependencies**: none added

**Storage**: none (fold choices live in the panel document's memory)

**Testing**: vitest `unit` (pure module) and `extension-ui` (jsdom card/shell); a fixture capture page
for the visual gates; the packaged `agent-panel-shots.spec.ts` in attach mode for the live gate

**Target Platform**: the side panel at 320-480 px wide, light and dark, en-US and zh-TW

**Project Type**: browser extension + stdio MCP server (npm workspaces); only `apps/extension/src/side-panel`
and its locales change

**Performance Goals**: none beyond today (the card renders from the same picture)

**Constraints**: clean room; no literal colours in components (006 FR-091); 4.5:1 text contrast in both
themes (006 FR-092); every visible string from the locale tables; every control sends exactly the frame it
sends today (SC-244)

**Scale/Scope**: up to ~10 live sessions, 20 activity items and 32 grants per session

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass. Every behaviour traces to D-036-n and FR-538..557 |
| II. Clean room | Pass. The reference was looked at for overall feel only (warm neutrals, hairlines, restrained colour); E keeps Hallpass's own tokens, words and icons; nothing was copied |
| III. Traceability | Pass. R-533..541 cite FRs; tasks cite R and FR ids |
| IV. Explicit uncertainty | Pass. No open question; the prototype F palette is recorded as a later spec |
| V. Least privilege | Pass. No permission change |
| VI. Consent and privacy | Pass. The card shows the same facts as before, fewer times; no new data |
| VII. Testable | Pass. Pure rules unit-tested; card and shell in jsdom; look judged on captures |
| VIII. MV3 | Pass |
| IX. Requirements before architecture | Pass |
| X. Dependencies | Pass. None added; icons are in-house SVG |
| XI. Failure behaviour | Pass. Unknown kinds, missing origins, stale waiting, long names are specified |
| XII. Spec before implementation | Pass |

Re-check after design: unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/036-session-card-layout/
├── spec.md
├── plan.md              # this file
├── research.md          # R-533..R-541
├── data-model.md        # the card model's shapes and rules
├── quickstart.md        # how each gate is run
├── contracts/session-card-ui.md   # what each control sends (unchanged frames) and the DOM hooks tests use
└── checklists/requirements.md
```

### Source Code (touched areas)

```text
apps/extension/src/side-panel/agent/session-card-model.ts   # new: sitesOf, rowsOf, needsOwner, groupSessions, isOpen
apps/extension/src/side-panel/agent/SessionCard.tsx         # rebuilt header/body (keeps activityText export)
apps/extension/src/side-panel/agent/session-icons.tsx       # new: in-house line icons
apps/extension/src/side-panel/agent/AgentShell.tsx          # grouping, fold state, Answer -> consent card focus
apps/extension/src/side-panel/agent/PromptCard.tsx          # a focus target (tabIndex -1 + id) only
apps/extension/src/side-panel/agent/agent.css               # card styles (E)
apps/extension/src/side-panel/agent/tokens.css              # --line-soft, both themes
apps/extension/src/side-panel/agent-panel-keys.ts           # new keys registered
apps/extension/src/locales/en-US.ts, zh-TW.ts               # FR-556 copy; zh-TW second person (FR-555)
apps/extension/tests/session-card-model.test.ts             # new
apps/extension/tests/session-card*.test.tsx, side-panel-sessions-024.test.tsx, panel-a11y.test.tsx, agent-shell*.test.tsx  # updated
apps/extension/tests/visual/session-cards.html + .tsx + capture script   # fixture capture page (not a build input)
tests/e2e/packaged/*.spec.ts                                 # selectors/text that named the old card (local-only suites)
```

## Slices and order

| Slice | Stories / FR | Risk | Owns | Depends on |
|---|---|---|---|---|
| U - card, model and shell | US1-US4; FR-538..557 | none (UI, live-verifiable; frames pinned by SC-244 tests) | everything above under `apps/extension` | data-model.md, contracts (fixed) |
| E - packaged specs | keep local suites in step | none | `tests/e2e/packaged/*.spec.ts` that read the old card | U merged |
| L - live | quickstart 4 | none | `agent-panel-shots.spec.ts` run, captures | U, E |

One writer at a time: U and E touch the same visible strings, and E needs U's final DOM hooks. U goes to
`implementer-sonnet` (method settled by the prototype; exact copy in the spec). E is a mechanical
selector update (`mech-executor` with the list from `grep`), unless U's report shows it is two files or
fewer, then main does it. L is main's (attach-mode browser on 9222, unattended recipe).

## Complexity Tracking

None.

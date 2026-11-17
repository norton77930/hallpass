# Feature Specification: Warm Paper Palette for the Whole Panel

**Feature Branch**: `spec-037-warm-palette`
**Created**: 2026-11-17
**Status**: Approved by the owner 2026-11-17
**Input**: The owner's choice of palette F on the 036 prototype ("先E, 但F先記錄下來 排到下次"), the scope answers
of 2026-11-17 (Q1 A whole side panel, Q2 A dark warm too, Q3 A accent stays indigo) and the owner's "可以" on the
light and dark captures of branch `prototype/warm-palette` (875e99c).

## Decisions

- **D-037-1 - warm paper palette, whole panel.** The side panel (conversation, sessions, consent card, status
  row, tabs, composer) and the settings page move from 020's cool "indigo" ground to a warm paper ground in light
  and a warm charcoal ground in dark. Supersedes the ground and neutral part of 020 D-020-2.
- **D-037-2 - accent stays indigo.** One indigo accent keeps carrying the selected state, the primary action and
  the focus ring, slightly deepened in light. No brand colour of another product is used (clean room).
- **D-037-3 - cards share the ground.** Cards keep the ground colour and are told apart by their edge and faint
  shadow, as on the approved captures; no separate "paper" card surface.
- **D-037-4 - session colours unchanged.** The `--group-*` colours keep matching Chrome's tab groups.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The panel feels calm and warm (Priority: P1)

The owner opens the side panel in light or dark and sees a warm paper (or warm charcoal) ground, the same
indigo actions, and text as readable as before.

**Acceptance Scenarios**:

1. **Given** the browser in light mode, **When** the owner opens the panel, **Then** every surface uses the light
   column of the palette table (FR-558) and every text/surface pair reads at 4.5:1 or more.
2. **Given** dark mode, **Then** the same holds for the dark column.
3. **Given** the owner pinned light or dark on the settings page (024 D-024-20), **When** the panel or the
   settings page is open, **Then** it shows exactly the same palette as the browser-scheme case.

### Edge Cases

- A colour mix (shadows, rings, attention border) follows the palette because it mixes tokens.
- The narrow build (`side-panel/styles.css`) is not the agent build and does not change (006 FR-090).

## Requirements *(mandatory)*

- **FR-558 - the palette**: the panel's colour tokens take these values (light / dark):

| Token | Light | Dark |
|---|---|---|
| `--bg` | #f9f7f2 | #1b1916 |
| `--surface` | #f2efe7 | #23211d |
| `--surface-2` | #ebe7dd | #2c2925 |
| `--code` | #efebe1 | #25231f |
| `--line` | #e4dfd3 | #3a362f |
| `--line-strong` | #d6cfc0 | #463f37 |
| `--line-soft` | #ece8dd | #2f2c27 |
| `--text` | #1e1d1a | #efebe3 |
| `--text-2` | #4d4940 | #c4bdb0 |
| `--text-3` | #686356 | #a39b8d |
| `--accent` | #3a3e9e | #a4a6f2 |
| `--accent-text` | #ffffff | #14152e |
| `--accent-soft` | #e9e8f4 | #2c2b45 |
| `--accent-line` | #c9c8e6 | #4d4c86 |
| `--ok` | #2c7443 | #7fcf96 |
| `--warn` | #95560f | #eeb466 |
| `--warn-soft` | #f7ecd8 | #3a2c17 |
| `--danger` | #a33128 | #f19a8f |
| `--danger-soft` | #f8e6e2 | #3b201c |
| `--focus` | #3a3e9e | #a4a6f2 |

- **FR-559 - one palette, three places**: the browser-scheme palette (`tokens.css`), the panel's pinned
  themes (`appearance.css`) and the settings page's pinned themes (`settings.css`) carry the same value for
  every colour token, including `--line-soft` and the `--group-*` colours.
- **FR-560 - contrast**: every text/surface pair checked by 006 FR-092 stays at 4.5:1 or more in both themes.
- **FR-561 - nothing else changes**: no layout, wording, size, spacing or behaviour changes; `--group-*` values
  are unchanged.

## Success Criteria *(mandatory)*

- **SC-245**: the panel captured in light and dark matches the captures the owner approved (prototype
  875e99c) in colour; no surface keeps the old cool grey.
- **SC-246**: the contrast check passes in both themes, tightest pair at least 4.5:1.
- **SC-247**: a pinned theme and the browser-scheme theme show the same values (FR-559), checked by a test.

## Assumptions

- The approved captures are the reference; light `--text-3` is #686356 (the prototype's first value #6e695e
  was 4.42:1 on `--surface-2`).

## Non-goals

- A separate card surface ("paper" lift), a new accent hue, the narrow build, layout or copy changes.

## Change log

- **2026-11-17**: first draft from D-037-1..4; approved by the owner the same day.

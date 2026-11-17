# Implementation Plan: Warm Paper Palette (037)

**Branch**: `spec-037-warm-palette` (from main b2c81a5) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

## Summary

Token values only. `tokens.css` (browser scheme), `appearance.css` (panel pinned themes) and `settings.css`
(settings page pinned themes) take the FR-558 table. A new test pins that the three agree (FR-559) and that the
values are the spec's; the existing panel-a11y test keeps contrast (FR-560). The prototype's preview page
(`apps/extension/tests/visual/panel-preview.*`) is kept as a capture tool.

## Technical Context

TypeScript/React side panel; CSS custom properties; vitest `extension-ui`; Playwright capture scripts. No
dependency, contract, worker or layout change.

## Constitution Check

| Principle | Status |
|---|---|
| I. Requirements are the source of truth | Pass: FR-558..561 from D-037-1..4 |
| II. Clean room | Pass: own values; indigo accent; no other product's colours |
| III. Traceability | Pass: R-542..543, T1070..1076 |
| IV-XII | Pass: no permission, data, MV3, dependency or behaviour change |

## Research

- **R-542 - three copies of one palette** (FR-559). The pinned themes repeat the palette on purpose (024
  D-024-20); 036 added `--line-soft` to `appearance.css` but not to `settings.css`. Decision: a test parses
  the three files and requires every colour token of `tokens.css` in each pinned block with the same value,
  so drift fails the build.
- **R-543 - capture** (SC-245). The 036 fixture page and the prototype's `panel-preview` page (real
  `AgentShell` on a stub port) are captured in light and dark and compared with the approved prototype shots.

## Slices

One slice, main session (values fixed by the approved prototype; three CSS files and one test).

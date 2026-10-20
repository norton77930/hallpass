# Implementation Plan: A Side-Panel Conversation That Reads Like an Agent (020)

**Branch**: `feature-020-chat-ui` (from `main` after 0.13.1) · **Spec**: `specs/020-chat-ui/spec.md`
**Target**: 0.14.0 · **Status**: draft under the owner's delegation of 2026-10-20

## Summary

Presentation-only rework of the Conversation tab (D-020-1..9) plus a new token set for the whole
panel (D-020-2). No contract, broker or worker behaviour changes except one small worker read for the
"agent used last" default (kept in the panel's existing local preferences). One new dependency pair:
`react-markdown` + `remark-gfm` (D-020-10, owner approved in G7).

## Technical Context

- **Language / runtime**: TypeScript, React 19.2 in the side panel (agent build only), Vite 8.
- **New dependencies**: `react-markdown` and `remark-gfm`, exact pins in `apps/extension/package.json`;
  no `rehype-raw` (raw HTML stays text, FR-316). Bundle growth measured in T584 (R-332).
- **Storage**: `chrome.storage.local` for the last-used agent (panel preference, same place as the
  remembered tab, 019 FR-284). Nothing else stored.
- **Testing**: vitest `extension-ui` (jsdom) for components; `tests/panel-a11y.test.tsx` already
  checks every text/surface token pair at 4.5:1 by reading `tokens.css` as text — the new tokens keep
  its format (one 6-digit hex per line). Packaged gate: `agent-conversation` specs get selector
  updates only (SC-146). Branded Chrome screenshots for SC-147.
- **Constraints**: clean room (no other product's colours, fonts, token names, class lists);
  narrow-build `styles.css` untouched; en-US + zh-TW strings through `agent-panel-keys.ts`.

## Constitution Check

- Spec-driven: spec 020 + this plan + tasks; IDs continue (FR-312.., SC-141.., R-332.., T583..).
- Test first: every behaviour slice starts with its failing component test.
- Clean room: the reference was observed by screenshot only; notes in own words, kept private.
- Public snapshot: no local paths in tracked files.
- New dependency: owner approved (G7). PASS.

## Research items (Phase 0)

- **R-332** Markdown rendering: `react-markdown` with `remark-gfm`, `skipHtml` on, `urlTransform`
  default (blocks `javascript:`), custom `a` (new tab, `rel="noopener noreferrer"`), custom `img`
  rendered as a link (no remote load, FR-316), tables wrapped in a scroll box. Measure bundle size of
  the side-panel chunk before/after; CSP of extension pages needs no change (no eval).
- **R-333** Streaming Markdown: re-render the growing text each chunk (throttled by the existing 50 ms
  frame cap); an unclosed fence renders as a code block to the end — acceptable, no jump above the
  reading position because the list keeps bottom anchoring only when already at the bottom.
- **R-334** Turn grouping for the action log: a turn = events between an owner message and the next;
  the live line is the newest running action; failed/refused actions are listed after the collapsed
  group (FR-318). Pure function in `conversation-log.ts`, unit-tested.
- **R-335** Last-used agent: written when a conversation starts; read on tab open; falls back per
  FR-313 using the agent states the panel already receives.

## Project structure (changes)

```
apps/extension/src/side-panel/agent/
  tokens.css                      new palette (light + dark), same variable names where possible
  agent.css                       conversation layout rules
  conversation/
    ConversationTab.tsx           composer-first flow (S2)
    Composer.tsx          (new)   message box + agent / folder / mode chips + send/stop
    AgentMenu.tsx         (new)   agent list with states (FR-313)
    ModeMenu.tsx          (new)   replaces ModeSwitch.tsx (FR-320)
    Reply.tsx             (new)   Markdown reply + Copy (FR-316, FR-317)
    TurnActions.tsx       (new)   live line / "N steps" / visible failures; replaces ActionList.tsx
    PermissionCard.tsx            pinned above the composer (FR-319)
    ConversationDrawer.tsx (new)  replaces ConversationList.tsx view (FR-321)
    ConversationHeader.tsx        list + new buttons, title, agent · folder subtitle
    conversation-log.ts           turn grouping (R-334)
apps/extension/src/side-panel/agent-panel-keys.ts   new strings (en-US, zh-TW)
apps/extension/tests/*.test.tsx                     one focused test per behaviour
tests/e2e/packaged/agent-conversation*.spec.ts      selector updates only
```

## Slices

| Slice | Content | Depends on | Evidence |
|---|---|---|---|
| S0 | Spec/plan/tasks committed; dependency pins; bundle-size baseline | 0.13.1 merged | build + contract |
| S1 | Tokens (light/dark) for the whole panel; a11y contrast test green | S0 | panel-a11y test |
| S2 | Composer-first: Composer, AgentMenu, defaults, first-use-on-send with held message | S1 | component tests (US1) |
| S3 | Reply Markdown + Copy, hostile-sample test (SC-142) | S0 | component tests (US2) |
| S4 | Turn action log (R-334) | S1 | unit + component tests (US3) |
| S5 | Permission card pinned, ModeMenu, Stop-only while waiting | S2 | component tests (US4) |
| S6 | Header + drawer, grouping and search | S1 | component tests (US5) |
| S7 | zh-TW strings, keyboard / screen-reader pass, Connections & sites on new tokens | S2–S6 | a11y tests |
| S8 | Packaged gate selector updates; branded Chrome run + screenshots; owner look approval; 0.14.0 | all | gate + SC-147 |

S3 ∥ S2; S4 ∥ S6 after S1; S5 after S2 (same files). Reviews: none required by risk (UI behaviour
closes with live verification), except S3's sanitisation, which gets a code review (R1: untrusted
content rendering).

## Risks

- Bundle growth of the side-panel chunk (R-332): if over ~150 KB gzip, reconsider `remark-gfm`.
- Gate selectors: the packaged suites click today's agent buttons; S8 updates selectors only.
- The palette is provisional until the owner chooses (mockup rows A/B); tokens keep a single swap
  point so the change is one file.

# Plan: 043 page scripts on a local dev site

**Branch**: `worktree-spec-evaluate-consent` | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)
| **Research**: [research.md](research.md) | **Contract**: [contracts/prompt-raised-043.md](contracts/prompt-raised-043.md)

## Summary

US1 adds a text hint to the terminal question that offers no *this session* (R-580, R-581). US2 offers
*this session* for page JavaScript on the three loopback hosts, held as a separate `scripts` session grant
(R-582..R-585).

## Technical context

TypeScript, Node >= 24, npm workspaces; vitest projects `unit`, `extension-ui`, `contract`. No new
dependency. Storage is the existing `chrome.storage.session` record of session grants.

## Constitution check

- V Least privilege: no permission added; US2 narrows to three exact hosts and one session. Pass.
- VI Consent: US1 adds no choice; US2 adds a session-bounded grant the owner gives explicitly, never from a
  site plan or a remembered mode. Pass.
- VII Observable: every FR has an acceptance scenario and a unit or contract pin. Pass.
- XII Spec before implementation: spec approved by the owner 2026-11-23. Pass.

## Seams

- **US1**: `packages/contracts/src/agent-tools.ts` `promptRaisedFrameSchema` (:3596-3631);
  `apps/extension/src/service-worker/agent-tools/prompts.ts` `ask` raised frame (:703-722);
  `packages/agent-host/src/terminal-consent.ts` `messageOf` (:75-84).
- **US2**: new `packages/domain` loopback helper (+ export); `session-grant-store.ts` kind (:33, :109-118);
  `agent-tools/page-action-grants.ts` (`scriptsGrantsFrom`); `agent-runtime.ts` wiring (:1120-1163, :3589-3634);
  `agent-tools/gate.ts` `GateInput` / `decideGate`; `agent-tools/diagnostics.ts` evaluate effect path
  (:552-594); `agent-tools/prompts.ts` `clientChoicesFor` (:506-518); contracts grants enum (:4281-4291);
  `side-panel/agent/PromptCard.tsx` (:504-505, :589-591); `side-panel/agent-panel-keys.ts` (:67-71);
  locales en-US / zh-TW.

## Slices

- **Slice A - US1** (implementer-sonnet): T1200..T1203. Touches contracts, prompts.ts, terminal-consent.ts.
- **Slice B - US2** (implementer, effort high: changes how consent admits): T1204..T1214. Starts after
  slice A, because both touch `agent-tools.ts` (contracts) and `prompts.ts`.
- One worktree, one writer at a time.

## Risk and evidence

- US1: no risk trigger (text only). Unit tests on the message; contract test on the field.
- US2: R2 (REVIEW.md: "a change to how consent, a grant or a permission rule decides"; `gate.ts` and
  `page-action-grants.ts` are listed). `code-reviewer` on the finished slice B diff.
- Live: the panel card's *This session* on a loopback page and the session card's scripts line, through the
  `verify-hallpass` skill, after slice B.
- Final verification: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:contract`,
  `npm run snapshot:check` on the combined state.

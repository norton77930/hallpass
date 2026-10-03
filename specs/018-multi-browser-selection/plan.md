# Implementation Plan: Several Browsers, One Bridge (018)

**Branch**: `next-round-followups` | **Date**: 2026-10-03 | **Spec**: [spec.md](spec.md) (draft)
**Status**: Draft for the owner's review — the spec is not approved; no slice starts before the owner
answers the questions below (R2 spec gate, D-018-9).

## Summary

Every browser keeps its own relay and its own record file; an agent's session resolves which browser
it uses in the mcp-server before anything runs, and dials only that browser's relay (R-266, R-270). The
browser's identity and name live in the extension per profile (R-268); the remembered choice is a host
file keyed by agent (R-271). Three host-answered tools let the agent list, select, or ask the owner to
choose in the browsers (R-273). Stand-by is retired (R-274). Link protocol stays 2 (R-267).

## Technical Context

TypeScript, Node ≥ 24, MV3 extension, React side panel; contracts are closed schemas in
`packages/contracts`. Windows 11 only. Tests: vitest unit/extension-ui/contract, relay process tests,
packaged gate in attach mode (today one CDP endpoint — S8 adds two), one paid probe.

## Constitution check

- Spec-driven: spec 018 (draft), research R-266..R-275, tasks T493+.
- Test first: every slice starts with its failing test (CLAUDE.md).
- Clean room: reference behaviour is described in evidence 004 §3h; nothing is copied.
- Public snapshot: no reference identifiers or local paths in `specs/`.
- Consent model: grants stay per browser (FR-275); routing is an authorization boundary → architecture
  review on this plan before code, security-focused code review of S4, final code review before 0.11.0.

## Components

| Party | Change |
| --- | --- |
| contracts | per-browser record schema; optional identity fields on `relay-ack`; frames `browser-name`, `browser-peers`, `browser-choice-request/result/withdraw`; optional `hello.intent`; refusals `browser-not-chosen`, `browser-disconnected` with the browser list and bilingual hints; tools `list_browsers`, `select_browser`, `request_browser_choice`; prompt kind `browser-choice`; choice-file schema; remove `relay-standby` |
| domain | `defaultBrowserNames` (R-269) |
| relay (`native-host.ts`, `bridge-link.ts`, `relay-ownership.ts`) | per-browser record writer + dead-pid sweep; per-browser supersede; legacy `bridge.json` owner; `browser-peers` from the existing 1 s poll; `browser-name` rewrite |
| mcp-server (`mcp-server.ts` + new `browser-directory.ts`, `browser-choice-store.ts`, `resolve-browser.ts`) | resolve before pairing/dial; link map by browser; per-browser pairing; tab-id provenance; host-answered tools; choice coordinator |
| worker (`agent-bridge.ts`, new `browser-identity.ts`, `agent-runtime.ts`) | identity on the ack; rename command; peers; choice card controller; stand-by removed |
| panel | "This browser: <name> [Rename]", "N other browsers connected", choice card; en-US + zh-TW |

## Slices

| Slice | Scope | Depends on | Evidence | Risk / review |
| --- | --- | --- | --- | --- |
| S0 | this plan, research, data-model + contracts docs, tasks; **architecture review** | — | review | before code |
| S1 | contracts + `defaultBrowserNames` + host paths | S0 + owner answers | schema unit + contract (protocol still 2, no new required field on old frames) | low |
| S2 | relay: per-browser records, supersede per browser, legacy record owner, peers, rename | S1 | relay process tests with two relays and fake native ports: both serve, closing one leaves the other, same-browser replacement still exits, one legacy owner, a protocol-2 server still attaches | medium |
| S3 | extension identity + naming + panel rename/peers row | S1 | identity store unit; panel jsdom | low |
| S4a | pure `resolveBrowser` (table incl. pinned-absent rows, R-278) + directory reader (incl. the legacy `bridge.json` entry, R-277) + choice store (one file per agent) + `list_browsers` / `select_browser` wired to a record source for the existing single dial (no multi-link yet) | S1, S2 | exhaustive resolver table; directory reader with stale/temp/legacy files | medium |
| S4b | **R2 core**: per-browser link / pairing / features / run state, resolve at initialize + every dial + `placeCall`, pin at first forwarded call, switch-drain-close, `stop`/timeout routed to the link that carried the call, tab-id provenance, screenshot cache clear | S4a | a refusal sends 0 frames; switch drains the old link; foreign tab id refused; a worker recycle of the pinned browser does not refuse | high — security-focused code review |
| S5 | in-browser choice: coordinator, card controller, PromptCard | S3, S4 | coordinator unit (first confirm wins, withdraw, 2 min, legacy skipped); panel | medium |
| S6 | retire stand-by (R-274) | S2, S3 | removed behaviour; panel tests | low |
| S7 | uploads per browser **or** spec amendment (R-275, owner Q4) | S4 | — | — |
| S8 | gate: two CDP endpoints (two private profiles, one shared private LOCALAPPDATA); `agent-multi-browser.spec.ts` for SC-127..132 | S4–S6 | gate | — |
| S9 | probe S18 (SC-133); 0.11.0; README/docs; final code review | S8 | probe | final review |

Parallel: S2 ∥ S3 (disjoint files); S6 ∥ S5 once S2 and S3 are in.

## Owner questions (spec gate)

From the spec:
1. D-018-5: remember the choice per agent across sessions (proposed) or per session only? (per session
   only drops the choice file; S4 shrinks.)
2. D-018-6: in-browser choice in 018 (proposed) or later? (later drops S5 and three frames; additive
   later, no protocol bump.)
3. D-018-2: default name = browser kind, numbered (proposed), or neutral "Browser N"? (only
   `defaultBrowserNames` changes.)

Found while planning:
4. R-275: upload directories are machine-wide today. Key them per browser (S7) or amend FR-275 to say
   the directory list belongs to the machine user? Proposed: amend FR-275 (the list is the owner's
   file-system boundary, not a browser grant; each upload still asks in its own browser).
5. R-271: "per agent" is per machine user today (one `agent-id` file), so Claude Code and Codex share
   the remembered choice. Accept (proposed), or key the choice by agent + client name?
6. R-278 (reframed after review M4): a session is pinned at its **first forwarded call**, not at start —
   so an agent that initialised with only A connected, then sees B appear before its first call, is
   asked like any other. Proposed; the alternative pins at start (start order decides, which the spec's
   "Why" rejects).

From the architecture review:
7. A **fresh** session whose remembered browser A is offline while exactly one other browser B is
   connected: use B (FR-271 as written) or refuse and ask (treat A as the choice, FR-277)? Proposed:
   refuse and ask — the remembered choice says the owner wanted A. (Within a session an absent pinned
   browser is always refused, R-278.)
8. **The real boundary**: `select_browser` is the agent's claim that the owner said which. Once the
   agent is paired in both browsers, it can move itself between them with no owner action. Is pairing
   in B enough consent for a self-selected switch (proposed: yes, pairing is already the per-browser
   consent and every site still asks under its own mode), or must a switch to a browser this session
   has not used go through the owner (a card in B, or `request_browser_choice`)?

Review changes applied: R-276 (collision keyed on the run), R-277 (legacy record during upgrade),
R-278 (when the browser is resolved), R-279 (smaller items); S4 split into S4a/S4b.

## Verification (planned)

typecheck, unit + extension-ui, build, contract, snapshot; relay process tests; packaged gate with
two browsers on Playwright Chromium (two private profiles) and one run on the owner's branded Chrome +
Edge; paid probe S18; reviews as listed.

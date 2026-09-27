# Implementation Plan: A Readable Panel — Sessions You Can Tell Apart, Words That Mean What They Say

**Branch**: `016-readable-panel` (git: `feature-016-readable-panel`) | **Date**: 2026-09-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification; [research.md](./research.md) R-203 – R-210; the owner-approved
mockup (private design canvas "Hallpass 面板改版示意"); the worker, host, panel and contracts sources
at 5f8f27c (0.8.0).

## Summary

Presentation work, one additive frame, three small robustness items. **Identity** (R-203 – R-205):
the host derives a project label (MCP roots, else its working directory; last segment only) and sends
it on a new `session-label` frame; the worker's persisted session record gains a write-once start
time, a session colour from a fixed rotation, and the label; the projection exposes them and a third
state, `idle`. **Panel** (R-206): status row with the session count, paired agents in the menu,
cards titled by project with a colour stripe, three states with "last action", buttons shown only when
they act, site rows without repeated text. **Tab strip** (R-207): a group presenter titles each
session's group `Hallpass` with ⌛ / 🔔 prefixes from a new in-flight change signal and the prompt
state, with a 1 s idle debounce; stale cleanup recognises old and new titles. **Robustness**
(R-208 – R-210): keyboard dispatch raced with dialogs; the no-release behaviour pinned by a test; the
pairing-wait extension measured first (it appears implemented by D-011-7). **Close-out**: 0.9.0,
screenshots for the owner, docs; no release before the owner approves.

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (host, contracts), MV3 extension (worker, panel React);
Vitest (unit, extension-ui, contract); Playwright for the packaged gate.

**Primary Dependencies**: none new. `chrome.tabGroups` (existing permission), MCP SDK (roots request
is part of the SDK already in use).

**Storage**: `chrome.storage.session` (session record fields, colour counter) — additive.

**Testing**: unit + extension-ui (panel components), contract (frame schema, projection schema,
strings), packaged attach gates on Chromium 151 (panel states, tab-group titles/colours, keyboard
dialog), panel screenshot spec (zh-TW / en-US × light / dark).

**Target Platform**: Chrome / Chromium MV3 on Windows (as 0.8.0).

**Project Type**: browser extension + local MCP host (monorepo: apps/extension, packages/agent-host,
packages/contracts).

**Performance Goals**: no added latency on tool calls; group retitles only on state change (at most
one write per transition, idle debounce 1 s).

**Constraints**: link protocol stays 2 (strict frames: new type only); no new permissions; label never
logged (constitution VI); public docs carry no reference identifiers (clean room, II).

**Scale/Scope**: ~5 panel components, 1 frame, 1 presenter, 3 robustness items, docs.

## Constitution Check

| Principle | Status |
| --- | --- |
| I Requirements are the source of truth | Spec FR-223 – FR-247 from owner decisions D-016-1 … 10 |
| II Clean room | Reference read for behaviour only; no identifiers in specs/public docs |
| III Traceability | Spec traceability table; tasks cite FRs |
| IV Explicit uncertainty | R-203 (client cwd/roots) and R-210 (B5 already implemented) stated with the check that settles them |
| V Least privilege | No new permission; `tabGroups` already granted |
| VI Privacy / data minimisation | Label = last path segment only, never logged; start time local-only |
| VII Observable & testable | Every FR has a unit, contract or gate test (tasks) |
| VIII MV3 baseline | unchanged |
| IX Requirements before architecture | Mockup and spec approved before this plan |
| X Dependency discipline | No new dependency |
| XI Defined failure behaviour | Old host/worker combinations defined (contracts/session-label.md) |
| XII Specification before implementation | This plan follows the committed spec |

Post-design re-check: unchanged — no violation.

## Project Structure

### Documentation (this feature)

```text
specs/016-readable-panel/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── contracts/ session-label.md, panel.md, tab-group.md
├── checklists/requirements.md
└── tasks.md (next step)
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts        session-label frame; session view fields; "idle" state
packages/agent-host/src/mcp-server.ts        label derivation + send after hello-ack
packages/agent-host/src/bridge-link.ts       (send hook after greeting, if needed)
apps/extension/src/service-worker/
  agent-bridge.ts                            decode session-label → runtime
  agent-tab-manager.ts                       session record: firstSeenAt, colourIndex, label
  agent-runtime.ts                           projection fields, idle state, presenter wiring
  agent-tools/stop.ts                        onChange for in-flight counts
  agent-tools/effects.ts                     keyboard dispatch raced with dialogs (R-208)
  agent-tools/input.ts                       doc sentence (R-209)
  group-presenter.ts (new)                   title/prefix/colour per session state
chrome-adapters/tab-groups.ts                title constants, colour list, stale title set
apps/extension/src/side-panel/agent/
  AgentShell.tsx, StatusRow.tsx, SessionCard.tsx, SiteList.tsx, tokens.css, agent.css
apps/extension/src/locales/{zh-TW,en-US}.ts
tests: apps/extension/tests/*, packages/agent-host/tests/mcp-server.test.ts,
       tests/contract/agent-tools-016.contract.test.ts (new),
       tests/e2e/packaged/agent-panel-016.spec.ts (new), agent-panel-shots.spec.ts (updated)
```

## Slice ordering

| Slice | Content | Depends on | Writer |
| --- | --- | --- | --- |
| S1 | contracts (frame, view fields, idle) + host label + worker record/projection | — | implementer |
| S2 | panel: status row, cards, site rows, strings, tokens | S1 contracts | implementer |
| S3 | tab-group presenter, stop onChange, stale titles, colours | S1 record (colour) | implementer-high |
| S4 | R-208 keyboard dialog race; R-209 test; R-210 measurement | — | implementer |
| S5 | gates, screenshots, docs, 0.9.0, coverage | S1–S4 | main |

S1 contracts land first (small, committed), then S2 and S3 run in parallel (disjoint files: panel vs
worker presenter/tab manager; the runtime file is S3's, S2 only reads the projection); S4 runs
beside S1 (effects/input/prompt tests only). Review: code-reviewer after S3 (lifecycle/consistency:
debounce timers, restart persistence, stale cleanup) — R1. S1's frame is a compatibility boundary
(R1): reviewed together with S3.

## Completion Contract

- **Scope**: FR-223 – FR-247; non-goals as spec "Out of Scope".
- **Claims → evidence**: panel text/state/buttons (extension-ui unit + gate + screenshots); label
  frame compat (contract + host tests + an old-worker decode test); tab-group titles/colours (unit +
  gate); keyboard dialog (unit + gate); no-release (unit); B5 (unit; code only if red); version/docs
  (contract pins, snapshot).
- **Assurance roles**: code-reviewer on S1+S3 (compatibility and lifecycle).
- **Final verification (one)**: `npm run typecheck && npm test && npm run test:contract && npm run
  snapshot:check`, then every `agent-*` gate on Chromium 151 attach, then the screenshot spec.

## Complexity Tracking

None. The only new module is the group presenter, which replaces nothing and exists because no
existing component observes the working/waiting transitions.

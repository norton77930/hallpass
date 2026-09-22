# Implementation Plan: First-Run Visibility

**Branch**: `011-first-run-visibility` (git: `feature-011-first-run-visibility`) | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification; [research.md](./research.md) R-160–R-165 (two of them measurements
made before this plan); `docs/design-notes.md` §8; the worker, host and contract
sources read on 2026-09-21.

## Summary

The measurements settled the shape. Chrome refuses a worker-initiated `sidePanel.open()` (R-160),
so the panel cannot be opened for the person; Claude Code's tool-call bound is hours, not 60 s
(R-161), so the call can be held for the two minutes the owner chose. Three slices. (1) **Wait and
tell**: the worker reads "is a panel connected" when a prompt or pairing is raised and fixes the
bound (25/45 s connected, 120 s not); every 5 s it sends a new `prompt-waiting` frame; the host's
router treats it as keep-alive for that call and the server turns it into an MCP progress
notification carrying the fixed bilingual sentence that tells the person to open the panel; the
`timed-out` outcome gains a `hint` with the same sentence (R-162, R-164). (2) **Badge**: a
`chrome.action` adapter and a derived attention state — pending question and no panel → `!` and a
title, cleared on answer / expiry / connect, re-derived on wake (R-163; the planned
`setPanelBehavior` was withdrawn at review, see R-160). (3) **Prove and document**: a packaged-gate spec for the closed-panel flow, the pointer
baseline assertion, the comparison page and design notes corrected, and — with the owner's
go-ahead, because it is paid — one `claude -p` probe with the panel closed.

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (host, contracts), MV3 extension (worker, panel);
Vitest; Playwright for the packaged gate.

**Primary Dependencies**: none added. `chrome.action` badge calls are covered by the existing
`action` manifest entry (R-160 measured them as working);
**no new manifest permission** (D-011-2).

**Storage**: none new. The badge is browser state; the attention state is derived, not stored.

**Testing**: unit (prompt controller bound selection, attention derivation, router keep-alive,
server progress mapping, contract schema), contract (link protocol schema, no new permission,
sentence source), packaged gate (Chromium, unattended attach recipe), one paid probe.

**Target Platform**: Windows 11, Chrome / Chromium 151+.

**Project Type**: browser extension + local host.

**Constraints**: link protocol gains one frame type — bump `AGENT_LINK_PROTOCOL`? No: the frame is
optional and a relay that does not know it drops it as unaddressed (agent-bridge default branch);
the host ignores unknown frame types today. Protocol number unchanged; recorded in contracts.

**Scale/Scope**: contracts (1 frame, 1 hint field, 2 sentences), worker (prompts, pairing, panel
port, runtime derivation, one adapter), host (router keep-alive, server progress + pairing bound,
comment fix), 1 gate spec, 3 documents, 1 probe.

## Constitution Check

| Principle | Status |
| --- | --- |
| I. PR as source of truth | PASS. PR-020 pairing; draft FR-017 (attention notification) taken in its in-product, zero-permission form. |
| II. Clean-room | PASS. The reference has no mechanism to copy (design notes §8); ours is designed from the measurements. No identifier in specs. |
| III. Traceability | PASS. FR-146..155 ↔ US1–US3 ↔ SC-078..084; tasks cite them. |
| IV. Explicit uncertainty | PASS. Two measurements recorded with versions; other MCP clients' bounds stated as an assumption checked by QA; D-011-5 owed. |
| V. Least privilege | PASS. No new permission; D-011-2 rejected the one mechanism that needed one. |
| VI. Privacy | PASS. FR-151: badge, title and sentences carry no page content or arguments. |
| VII. Observable | PASS. SC-078..084 are counts and timestamps. |
| VIII. MV3 | PASS. Worker recycling handled by re-derivation on wake. |
| IX. Requirements before architecture | PASS. |
| X. Dependency discipline | PASS. |
| XI. Defined failure | PASS. Timed-out keeps its outcome and gains a hint; a late Allow stays refused. |
| XII. Specification before implementation | PASS. |

## Project Structure

### Documentation (this feature)

```text
specs/011-first-run-visibility/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/prompt-waiting.md      # the frame, the hint, the sentences, the progress mapping
├── checklists/requirements.md
└── tasks.md                          # /speckit-tasks
docs/design-notes.md §8   # public summary of the private reference reading (which stays out of the snapshot)
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts        # prompt-waiting frame; `hint` on timed-out; ATTENTION_SENTENCES
apps/extension/src/
├── chrome-adapters/action-badge.ts          # NEW: setAttention(on) → badge text/colour/title; clear
├── service-worker/agent-panel-port.ts       # exposes `isConnected()` + onPresenceChange
├── service-worker/agent-tools/prompts.ts    # bound chosen at raise: 25 s | 120 s; onWaiting tick every 5 s
├── service-worker/pairing-controller.ts     # pending pairing visible; waiting tick
├── service-worker/agent-runtime.ts          # attention derivation; sends prompt-waiting; wake re-derive
└── service-worker/agent-bridge.ts           # sends the new frame type
packages/agent-host/src/
├── router.ts                                # keep-alive on prompt-waiting, cap 130 s
└── mcp-server.ts                            # progress with sentence; pairing bound adopts frame's boundMs; fix the 60 s comment
tests/e2e/packaged/agent-first-run.spec.ts   # NEW gate spec (closed panel → message, badge, open, answer)
tests/e2e/packaged/agent-input.spec.ts       # + pointer baseline assertion (or a new agent-pointer.spec.ts)
docs/design-notes.md · (comparison page artifact) · README "First use"   # FR-155, and the first-use note
```

**Structure Decision**: no new module beyond the badge adapter; the attention state is a small
derived function in the runtime next to the existing projection, because it depends on the same
two inputs (prompts, panel presence) the projection already watches.

## Slice ordering

| Slice | Content | Closes | Writer | Evidence |
| --- | --- | --- | --- | --- |
| **S1** | contracts (frame, hint, sentences); worker: panel presence, bound at raise, 5 s waiting tick, send frame; host: router keep-alive, server progress + pairing bound, comment fix; unit + contract tests (RED first on: bound selection, router keep-alive, server progress message) | FR-146, FR-148, FR-150, FR-151 | implementer (two briefs: worker / host+contracts) | unit + contract, then **code-reviewer** (cross-module protocol change, timer paths) |
| **S2** | badge adapter; attention derivation on prompt change / presence change / wake; unit (derivation table) | FR-147, FR-149 (pinned by test), FR-152 (closed) | implementer | unit |
| **S3** | gate spec `agent-first-run` (Chromium, panel closed → progress message text, badge read via worker, open panel page → card first, answer → call completes; and the 120 s expiry path with a shortened bound env); pointer baseline assertion; docs (design notes, comparison page row, README first-use line); `coverage.md`; **probe** `claude -p` with panel closed after the owner says go | FR-153, FR-155; SC-078..084 | implementer (gate spec), main session (docs, probe) | gate + probe |

S1 → S2 → S3. D-011-5 (pointer upgrade, FR-154) is not scheduled; if the owner chooses "upgrade"
it becomes S4 with its own brief and gate assertions.

## Complexity Tracking

No constitution violation.

# Implementation Plan: Reference Parity for the Local Agent Bridge

**Branch**: `004-reference-parity-bridge` | **Date**: 2026-09-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-reference-parity-bridge/spec.md`

## Summary

Make the local-agent caller of 003 behave, observably, like the two reference extensions at the ten
points where it does not, in the order the owner's first real run exposed them, and prove every item on
the owner's own Chrome 152 against real pages with the coding agent as the caller before calling it
done. Structurally the feature is: (1) an **inverted loopback link** — the relay Chrome spawns becomes
the one long-lived listener and every Claude Code session's mcp-server dials it, so N sessions share one
browser (R-111); (2) **tab leases** replacing the group-only ownership check, plus a claim tool and an
in-page indicator (R-117); (3) a **declared all-frames content script** in the agent build with a
persistent per-frame reference registry (R-114, R-115); (4) **browser-level input** through the
`debugger` permission 003 already holds, with coordinates as the effect address, which also makes
frames and the position tool fall out (R-113, R-120); (5) the **acceptance probe** that drives
`claude -p` against the owner's browser and writes the report the owner asked for (R-118). Everything
lives behind the `agent` profile; the narrow build stays byte-identical (R-121).

## Technical Context

**Language/Version**: TypeScript 5.9 on Node 24, strict, unchanged from 003.

**Primary Dependencies**: none added. `@modelcontextprotocol/sdk` 1.30 (003) gains use of progress
notifications (R-112). The probe uses the installed Claude Code CLI (`claude -p`) as a process, not a
library. No dependency enters `@hallpass/extension`.

**Storage**: `chrome.storage.session` gains `agentTabLeases` and per-session `mainTabId`/`lastHelloAt`;
the host data directory's `bridge.json` changes writer (relay) and shape (R-111). Nothing durable
changes: pairings and site modes are as in 003.

**Testing**: Vitest unit/contract for the relay multiplexer, dial loop, lease store, ref registry,
frame merge, coordinate translation, `computer` schema, report writer; the attach-mode packaged gate
for fixture journeys; the **acceptance probe** (`tests/acceptance/probe-004/`) for the binding evidence
(spec "Acceptance standard", SC-028).

**Target Platform**: Chrome MV3, Windows; the owner's branded Chrome 152 is the acceptance host
(D-003-4, D-004-6).

**Project Type**: browser extension + local host package in the existing workspace (003 layout).

**Performance Goals**: link recovery ≤ 10 s (FR-057); session release ≤ 15 s (FR-058); indicator
control ≤ 1 s (FR-062); first call of a concurrent session within the single-session bound (SC-029).
Read capacity 10,000 nodes / 50,000 chars per answer (FR-067).

**Constraints**: no new permission (V); `debugger` gains a second traced use (R-113); the always-present
content script exists only in the `agent` profile and reads nothing until asked; page data stays
on-device (003 FR-035); clean-room — behaviour from `docs/design-notes.md`, no
reference identifier in source or spec (II).

**Scale/Scope**: 7 slices S0–S6, 17 FRs, 11 SCs, 3 new tools (`tabs_claim`, `tabs_release`,
`computer`), 1 new content script, 1 relay rewrite, 1 probe.

No `NEEDS CLARIFICATION` remains: D-004-1–6 are recorded in the spec and R-111–R-121 resolve the
design unknowns.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1. Result: PASS.*

| Article | Assessment |
| --- | --- |
| **I. Product Requirements are the source of truth** | PASS. Each FR traces to PR-004/005/007/008/020; PR-020 was amended by the owner's decisions before this plan; reference behaviour became requirements only through D-004-1. |
| **II. Clean-room** | PASS. Every reference identifier is confined to `docs/design-notes.md` as an evidence pointer (grep-verified absent from `specs/004-*/spec.md`); research items describe independently designed mechanisms (inverted link, lease store, persistent registry, owner-offset translation) for observable outcomes. No reference code, asset or private protocol is used. |
| **III. Traceability** | PASS. Spec traceability table; evidence ids G1–G12/N1–N2 map to FRs; F-016 destination unchanged. |
| **IV. Explicit uncertainty** | PASS. G3 and G12 are recorded as not determinable and handled by spec-set bounds or 003 behaviour; R-118 names its one verification risk and its fallback. |
| **V. Least-privilege** | PASS. No new permission. The second use of `debugger` is traced (FR-064/065/069) and its user-visible notice is recorded (D-004-4). The content script is declared only in the `agent` profile's manifest and does nothing until a paired session asks. |
| **VI. Privacy, consent, data minimisation** | PASS. Listing the owner's tabs is an owner decision (D-004-3) and carries no page content; reads/effects still require a lease; diagnostics keep their separate grant (FR-071); nothing leaves the device. |
| **VII. Observable and testable** | PASS. SC-028 makes the owner's-browser acceptance run the evidence; each SC is a count or bound. |
| **VIII. Manifest V3 baseline** | PASS. Content scripts, `webNavigation`, `tabGroups`, `debugger` are MV3. |
| **IX. Requirements before architecture** | PASS. The spec chose no mechanism; this plan is the first artifact that does. |
| **X. Dependency discipline** | PASS. No new dependency; the CLI used by the probe is the owner's own agent. |
| **XI. Defined failure behaviour** | PASS. bridge-lost, held-by-session, not-yours, input-unavailable, not-readable frame, stale-reference, outside-viewport, pairing no-answer are all specified. |
| **XII. Specification before implementation** | PASS. Spec + checklist + this plan precede tasks and source. |

## Project Structure

### Documentation (this feature)

```text
specs/004-reference-parity-bridge/
├── plan.md              # This file
├── research.md          # R-111..R-121
├── data-model.md        # amended entities: BridgeRecord, AgentSession, TabLease, FrameNode, ElementReference, InputAttachment, AcceptanceRun
├── quickstart.md        # owner one-time setup, gate, and the acceptance probe
├── contracts/README.md  # link frames, tool surface deltas, content-script messages, probe schema
└── tasks.md             # /speckit-tasks output (not created here)
```

### Source Code (repository root)

```text
packages/agent-host/src/
├── native-host.ts            # CHANGED: the relay now listens (loopback), writes bridge.json, multiplexes N servers
├── relay-mux.ts              # NEW: sessionId/callId → connection routing, session-ended emission; pure, unit-tested
├── bridge-link.ts            # CHANGED: record written by the relay; server-side dial loop (5 s), token check
├── mcp-server.ts             # CHANGED: dials the relay; pairing at initialize + progress notifications (R-112)
└── install/                  # unchanged (manifest + registry)

packages/contracts/src/
└── agent-tools.ts            # CHANGED: link frames (hello/hello-ack/session-ended/relay-started), tabs_claim/tabs_release/computer,
                              #          read_page bounds/fields/frames, holder on tabs_context, new refusal reasons

apps/extension/src/
├── build-config.ts           # CHANGED: agent profile declares content_scripts (all_frames, document_start) — narrow untouched
├── service-worker/
│   ├── agent-runtime.ts      # CHANGED: many sessions; relay-started reconciliation; session-ended handling
│   ├── agent-tab-manager.ts  # CHANGED: lease store replaces group-only ownership; claim/release; mainTabId; focus-main
│   ├── agent-tools/
│   │   ├── input.ts          # NEW: debugger attachment per held tab; pointer/keyboard delivery; input-unavailable
│   │   ├── frames.ts         # NEW: getAllFrames enumeration, subtree merge, frame-owner offset cache
│   │   ├── refs.ts           # CHANGED: opaque f<frame>-<n> refs over persistent registries
│   │   ├── computer.ts       # NEW: position tool over input.ts
│   │   ├── diagnostics.ts    # CHANGED: shares the attachment; domain enabling stays under the grant
│   │   └── (read/find/text handlers CHANGED to use frames.ts and the new bounds/fields)
│   └── index-agent.ts        # CHANGED: wires the above (narrow index.ts untouched)
├── content-runtime/
│   ├── registry.ts           # NEW: persistent weak element registry with prune (R-115)
│   ├── collector.ts          # CHANGED: open shadow roots, viewport filter, href/type/placeholder/options, bounds
│   ├── indicator.ts          # NEW: in-page indicator + trusted focus-main control (agent build only)
│   └── cursor.ts             # NEW: phantom cursor overlay (top frame)
└── side-panel/               # CHANGED: several sessions listed; per-tab holder

tests/
├── e2e/packaged/agent-sessions|claim|frames|input|refs|computer.spec.ts   # NEW attach-mode journeys
├── e2e/fixtures/pages/                                                     # NEW: nested-iframe, hover-menu, combobox, canvas, shadow-dom fixtures
└── acceptance/probe-004/
    ├── run.ts                # NEW: environment check, scenario runner, concurrent sessions, report writer
    ├── scenarios/*.json      # prompt + json-schema per scenario, page, expected checks
    └── reports/              # 004-<timestamp>.md/.json outputs
```

**Structure Decision**: keep 003's package boundaries; change the two host processes in place (the
link inversion is internal to `@hallpass/agent-host`); add worker modules beside the existing `agent-tools/`
rather than forking them; put every page-side addition (registry, indicator, cursor, shadow/viewport
collection) in `content-runtime` behind the agent build's content-script entry so the narrow bundle is
unchanged; the probe lives under `tests/acceptance/` next to the owner runbooks it replaces.

## Slice ordering (the owner's order; each slice ends with its probe report)

| Slice | Delivers | Research | Closes |
| --- | --- | --- | --- |
| **S0** | probe skeleton: environment check, one `claude -p` scenario, report writer, concurrency runner; verifies whether the reference's tools are reachable from `-p` and records the baseline source | R-118 | US1, SC-028 (mechanism), SC-038 (guard wired in) |
| **S1** | inverted link: relay listens + writes record, multiplexer, server dial loop, `session-ended`/`relay-started`, worker multi-session + 15 s reconciliation, pairing per agentId | R-111 | US2, FR-055–058, SC-029, SC-030 |
| **S2** | pairing at initialize + progress + 45 s bound; lease store; `tabs_context` holders; `tabs_claim`/`tabs_release`; indicator + focus-main; side panel | R-112, R-117 | US3, FR-059–062, SC-031, SC-032 |
| **S3** | declared content script; frame enumeration + merge; `not-readable` frames; text/find across frames | R-114 (read half) | US4 read scenarios, FR-063 (reads) |
| **S4** | debugger attachment per held tab; pointer (move→press→release) and per-key keyboard delivery with insert fallback; phantom cursor; frame-owner offsets so frame refs act; `input-unavailable` | R-113, R-114 (act half), R-119 | US4 act scenarios, US5, FR-064, FR-065, SC-033, SC-034 |
| **S5** | persistent registries + opaque refs; bounds/fields/viewport filter/`max_chars`; open shadow roots | R-115, R-116 | US6, FR-066–068, SC-035, SC-036 |
| **S6** | `computer` tool | R-120 | US7, FR-069, SC-037 |

S3 before S4 on purpose: reading frames needs no debugger and proves the content-script/merge half on
its own; S4 then makes those refs act. If S0 finds the reference's tools unreachable from `-p`, the
browser-tree baseline (R-118 fallback) is used and the report says so — no slice waits on it.

## Complexity Tracking

No constitution violation requires justification. The link inversion is a change of direction inside
one package, not a new component; the content script is a manifest entry of the agent profile only.

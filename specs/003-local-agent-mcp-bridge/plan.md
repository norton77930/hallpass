# Implementation Plan: Local Agent MCP Bridge

**Branch**: `003-local-agent-mcp-bridge` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-local-agent-mcp-bridge/spec.md`

## Summary

Give a trusted local coding agent (Claude Code first) a tool surface over the owner's real Chrome, so
the browser can be driven for automated testing. A **native-messaging host** — a Node process Chrome
spawns — also speaks MCP over stdio to the agent; the extension's service worker connects to it with
`chrome.runtime.connectNative` and routes each tool call to the reusable content runtime and a new tab
manager. Consent moves from a per-action card to **pair once + a per-site mode** (`ask` /
`follow-a-plan` / `skip-checks`). The remote-service path of 001/002 stays compiling but is excluded
from the 003 build profile.

The plan front-loads the three real unknowns — Windows native messaging, MCP stdio with Claude Code,
and tab-group ownership plus `captureVisibleTab` — into Phase 1 so nothing downstream is designed on a
guess. Everything the content runtime already does (collect, target registry, action executors
including 002 gestures/keys/drag, description matcher, wait conditions) is reused unchanged; the new
code is the transport, the tab manager, the site-mode store, and the pairing UI.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node 24, strict, `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` workspace-wide. Unchanged.

**Primary Dependencies**: One new runtime dependency — `@modelcontextprotocol/sdk` — in the new host
package, justified by PR-020 (the agent contract is MCP; hand-rolling it would be more code and less
correct). Zod is already present for the closed schemas at the new trust boundary. `ws` is already in
the tree if a socket is ever needed, but the host↔agent link is stdio and the worker↔host link is
native messaging, so no socket is added. No dependency is added to `@hallpass/extension`.

**Storage**: `chrome.storage.local` for two new durable records — paired agents and per-site modes —
and `chrome.storage.session` for the live agent sessions and tab-group ownership. The 001 rule that
task state is transient is unchanged; pairing and site modes are deliberately durable because they are
the owner's standing decisions.

**Testing**: Vitest across the existing three projects (unit, contract, jsdom UI) for the host router,
site-mode store, tab manager and pairing reducer; Playwright packaged gate in **attach mode**
(`HALLPASS_CDP_ENDPOINT`) for the end-to-end agent journeys, plus a headless MCP client harness that speaks
to the host over stdio without a browser.

**Target Platform**: Chrome Manifest V3 on Windows first (native-messaging host registration is
per-OS). Branded Chrome 152 is the supported host (D-003-4).

**Project Type**: Browser extension + a new local native-messaging/MCP host, in the existing npm
workspace.

**Performance Goals**: SC-021 — the login-form fixture completes as one batch in under 10 seconds end
to end. No other latency budget.

**Constraints**: `<all_urls>` and the tool permissions are declared by a **new build profile**, never
by widening `narrow` (D-003-1, Constitution V). The remote-service path must keep compiling. Page
data stays on the device (FR-035).

**Scale/Scope**: One extension, one new host package, ~18 agent tools, 7 user stories, one new build
profile, two new durable stores.

No `NEEDS CLARIFICATION` remains in the spec: the four owner decisions are recorded, and R-101 through
R-110 in [research.md](./research.md) resolve the design unknowns.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1. Result: PASS.*

| Article | Assessment |
| --- | --- |
| **I. Product Requirements are the source of truth** | PASS. Every story traces to a PR; PR-020 was approved by the owner and written into the draft before this plan. No reference identifier, module, or protocol name enters a normative artifact. |
| **II. Clean-room** | PASS. The MCP tool *surface* (names, argument shapes) is a published protocol and the reference's tool docs are public description, reused as a requirement, not copied code. No reference source, minified bundle, private id, or internal transport is used. The native host and router are independently designed. |
| **III. Traceability** | PASS. The spec's traceability table maps every FR to a PR and a reference feature; F-016 moves to PR-020 with the destination recorded in `docs/`. |
| **IV. Explicit uncertainty** | PASS. The three genuine unknowns are Phase-1 research items (R-101 native messaging on Windows, R-102 MCP stdio with Claude Code, R-104 tab ownership + capture); each is resolved with a decision, not a guess, before any story is built. |
| **V. Least-privilege** | PASS by construction. `<all_urls>`, `nativeMessaging`, `tabs`, `tabGroups`, `debugger` (US6 only), `downloads`/file access (US7 only) live in a **new `agent` build profile**; `narrow` is untouched, so the shipping remote-service artifact gains nothing. Each permission traces to an FR (FR-045, FR-031, FR-044, FR-049, FR-051) and is unused before pairing (FR-054). |
| **VI. Privacy, consent, data minimisation** | PASS. The per-site mode is the consent model; data stays on-device (FR-035); the pairing prompt discloses the agent's own forwarding. Diagnostics (US6) sit behind a separate per-site grant. |
| **VII. Observable and testable** | PASS. Every tool answers with a defined outcome; SC-020–SC-027 are measurable; the attach-mode gate is the evidence path. |
| **VIII. Manifest V3 baseline** | PASS. Native messaging and `debugger` are MV3-supported; no deviation. |
| **IX. Requirements before architecture** | PASS. The spec states behaviour; this plan is the first artifact that chooses structure. |
| **X. Dependency discipline** | PASS. One dependency added (`@modelcontextprotocol/sdk`), traced to PR-020, its data/trust boundary disclosed in research R-102, confined to the new host package. |
| **XI. Defined failure behaviour** | PASS. Bridge-unavailable, not-paired, stale ref, busy tab, restricted page, denied mode, unanswered prompt, Stop, disconnect, modal dialog are all specified. |
| **XII. Specification before implementation** | PASS. Spec, checklist and this plan precede any source; the spec gate carried no `BLOCKS-PLANNING`. |

**Governance note, not a violation**: this feature broadens the permission surface. The Constitution
permits that when it traces to an approved capability (V) and the F-016 clause anticipated "a later
approved Product Requirement". PR-020 is that requirement. No constitution amendment is required; the
broadening is isolated to the new `agent` profile so the shipping `narrow` artifact is unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/003-local-agent-mcp-bridge/
├── plan.md              # This file
├── research.md          # Phase 0 output — R-101..R-110
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output — tool surface, native frame, site-mode
└── tasks.md             # /speckit-tasks output (not created here)
```

### Source Code (repository root)

```text
packages/agent-host/               # NEW package @hallpass/agent-host — the native-messaging + MCP host
├── src/
│   ├── mcp-server.ts              # McpServer, registerTool per tool, StdioServerTransport
│   ├── native-frame.ts           # length-prefixed native-messaging framing to/from the worker
│   ├── tool-registry.ts          # tool name → arg schema (Zod) → native request; pure, unit-tested
│   ├── router.ts                 # MCP call ⇄ native frame correlation, timeouts, one-in-flight/tab
│   └── install/                  # host manifest + Windows registry writer (HKCU), uninstall
├── tests/                        # unit tests for framing, registry, router (no browser)
└── package.json

apps/extension/src/
├── service-worker/
│   ├── agent-bridge.ts           # NEW connectNative port, frame parse, dispatch to handlers
│   ├── agent-tab-manager.ts      # NEW tab-group ownership, agent-tab marking, tab-context
│   ├── site-mode-store.ts        # NEW per-site mode + diagnostics grant, chrome.storage.local
│   ├── pairing-controller.ts     # NEW pairing request/accept/unpair, chrome.storage.local
│   ├── agent-tools/              # NEW one handler per tool, each calling existing runtime/adapters
│   └── (existing control-port.ts, content-broker.ts, page-ports.ts … unchanged, remote path)
├── side-panel/
│   └── (pairing + per-site mode + agent-activity views added; existing task views unchanged)
├── content-runtime/              # REUSED unchanged (collector, targets, actions, bootstrap)
├── chrome-adapters/              # REUSED; agent-tab-manager adds tabs/tabGroups/capture adapters
└── build-config.ts              # NEW "agent" profile added to BUILD_PROFILES + PROFILE_PERMISSIONS

packages/contracts/src/
└── agent-tools.ts                # NEW closed Zod schemas for the native frame + each tool's args/result

tests/
├── e2e/packaged/agent-*.spec.ts  # NEW attach-mode journeys, one per story
└── harness/mcp-client.ts         # NEW headless MCP-over-stdio client for host tests without a browser
```

**Structure Decision**: a new `@hallpass/agent-host` package holds everything that runs outside the browser
(native host + MCP server) so the extension keeps no Node-only code; the extension gains a parallel
`agent-*` set of service-worker modules beside the untouched remote-service modules; a new `agent`
build profile declares the wider permissions so `narrow` never sees them. The content runtime, domain
policies and contracts are imported, not forked.

## Phase ordering (front-loads the unknowns)

1. **Spine (US1 partial).** New `agent` build profile + manifest; native host skeleton with the
   Windows registry/host-manifest installer; `connectNative` bridge; one trivial tool (`tabs_context`)
   answered end to end from a headless MCP client, then from Claude Code. Resolves R-101, R-102, R-104.
2. **Pairing + site-mode (US1, US3 gate).** Pairing controller and UI; site-mode store and UI; the
   `ask`/`follow-a-plan`/`skip-checks` gate in the router. No effects yet beyond a gated no-op.
3. **Read + act (US2, US3).** Wire `read_page`, `get_page_text`, `find`, `screenshot` to the collector,
   target registry, resolver and `captureVisibleTab`; wire click/type/key/scroll/hover/double/drag/
   form_input to the existing executors under the site-mode gate. Resolves R-105 (capture), R-106 (refs).
4. **Tabs + batch + wait (US4, US5).** Tab manager (create/close/navigate/history/resize, group
   marking); `browser_batch` sequential runner; `wait` on the existing condition evaluator.
5. **Diagnostics + upload (US6, US7).** `debugger`-backed console/network/evaluate behind the per-site
   diagnostics grant; `file_upload` behind the owner-allowed-path rule.
6. **Gate coverage + docs.** One attach-mode packaged journey per story; quickstart; SC checks.

## Complexity Tracking

No constitution violation requires justification. The one added dependency and the wider permission
profile are both traced above and are not complexity exceptions.

# Implementation Plan: Settings Page

**Branch**: `worktree-feature-024-settings-page` (ships as 0.16.0) | **Date**: 2026-10-24 | **Spec**: [spec.md](spec.md)
**Input**: specs/024-settings-page/spec.md at 13a6ff2 (D-024-1..19, confirmed by the owner)

## Summary

A new extension page `settings.html` (the browser's extension options, opened in a tab) with four sections.
It talks to the service worker over its own port `hallpass-settings`, whose trust check and closed command
set are separate from the side panel's, so the page can manage standing permissions but never answers
consent cards or counts as a seen panel (R-373). Agent readiness is the broker's existing local check,
asked for explicitly, bounded at 5 s per program and kept (R-374). Installs gain an estimated percent and
time left from the installed package folders (R-376 addendum), Cancel that ends the process tree (R-377), and an
`interrupted` state left by a broker that died with the browser (R-378); install state, a lock and the last
test result are files shared by every browser's broker (R-375). Test is a one-prompt conversation outside
the pool in a throwaway folder (R-379). Enabled agents and the default are a worker-owned record per
browser that the composer's picker follows (R-380). The side panel's second tab becomes Sessions and loses
every standing-permission control (R-381).

## Technical Context

**Language/Version**: TypeScript (Node ≥ 24 host, Chrome MV3 extension), React for both extension pages
**Primary Dependencies**: existing only (zod contracts, ACP over stdio, React, Vite); no new dependency
**Storage**: `chrome.storage.local` keys `agentChoices`, `agentAppearance` (new), `agentPanelTab` (value
renamed); host files `agents\<agent>\install-state.json`, `install.lock`, `last-test.json`; throwaway
`agent-tests\<id>\` folders
**Testing**: vitest `unit` (broker, worker) + `extension-ui` (page and panel); contract project after
build; fake ACP agent scenarios plus a slow-install and a hung-version knob; packaged gate
`agent-settings-024.spec.ts` (quickstart.md L1–L14); one scratch measurement of install-tree growth
**Target Platform**: Windows 11, branded Chrome (Edge/Brave registration unchanged)
**Project Type**: browser extension + local host
**Performance Goals**: every agent's state within 5 s of opening the page (SC-177); progress updated
every 1 s; Test bounded at 90 s
**Constraints**: zero model calls outside Test; no key value shown, copied or kept; no user paths in
copies; no new permission (pinned list unchanged); en-US + zh-TW; 006/020 keyboard and screen-reader bar;
375 px usable; open conversations unchanged (FR-391)
**Scale/Scope**: four agents, one page per browser (two open copies stay in step), N browsers per computer

## Constitution Check

- I/III Spec-driven and traceable: spec 024 → R-372..R-387 → tasks from T737 → tests; every FR maps to a
  slice below. PASS.
- II Clean room: the readiness idea came from reading an MIT-licensed project's behaviour; nothing copied,
  the check is Hallpass's own existing code. PASS.
- IV Explicit uncertainty: two owner questions, now decided (below); one measurement before S1's progress
  work (R-376). Visible, not assumed silently. PASS.
- V Least privilege: no new permission; `options_ui` is not a permission; the page's command set is a
  closed subset (R-373). PASS.
- VI Privacy: the page shows no conversation contents; last output read only on request, scrubbed;
  key names only. PASS.
- VII Observable: each story has live gates in quickstart.md. PASS.
- XI Failure behaviour: helper missing/outdated, install failed/cancelled/interrupted, test failures,
  revoked site behind a link, two pages open — all specified. PASS.
- Project rules: test first per behaviour change; no absolute paths (`snapshot:check`); evidence in
  `.scratch/024`.
- **Risk: R2 — authorization.** A second extension document is trusted to change standing permissions
  (site modes up to Skip checks, revoke, unpair, the side-panel-agent switch) — R-373. The owner chose the
  path on 2026-10-24 (below). Also R1: process
  lifecycle (Cancel kill tree, TestRun teardown, interrupted detection), cross-process consistency (shared
  state files and lock between brokers), data conversion (`conversationLastAgent` → `agentChoices`, tab
  value rename). Reviews: `code-reviewer` after S1 and after S2, `architecture-reviewer` on S1+S2 (new port,
  new host commands, shared host files), `code-reviewer` on the combined diff before release.

## Owner decisions on the plan (2026-10-24)

- **Q-A (R-382)** — yes: one shared appearance choice, default System (D-024-20).
- **Q-B (R-383)** — Remove only; FR-385 amended (D-024-21).
- **R2 path** — implement in this lane: S2 with `implementer` at effort high, then `code-reviewer` and
  `architecture-reviewer` pass S1+S2 before merge.

## Project Structure

### Documentation (this feature)

```text
specs/024-settings-page/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md  tasks.md (next: /speckit-tasks)
├── contracts/frames.md
└── checklists/requirements.md
```

### Source Code (touched)

```text
packages/contracts/src/conversation.ts                 # check-agents, install-cancel, test, diagnostics-by-agent; overview fields (S1)
packages/contracts/src/settings.ts                     # NEW: settingsCommandSchema, settings projection, AgentChoices, AgentAppearance (S2)
packages/contracts/src/agent-tools.ts                  # panel projection: conversation.choices, session site (S2)
packages/agent-host/src/broker/agents.ts               # 5 s bound, readiness cache, setup steps, browserTools (S1)
packages/agent-host/src/broker/install.ts              # progress estimate, cancel, state file, lock, interrupted (S1)
packages/agent-host/src/broker/run-command.ts          # AbortSignal + tree kill (S1)
packages/agent-host/src/broker/agent-test.ts           # NEW: TestRun (S1)
packages/agent-host/src/broker/shared-agent-state.ts   # NEW: install-state / lock / last-test files, 1 s watch (S1)
packages/agent-host/src/broker/commands.ts             # new commands; diagnostics by agent (S1)
packages/agent-host/src/broker/conversation.ts         # diagnostics lookup by agent (S1)
tests/harness/fake-acp-agent.ts                        # slow install, hung --version, counting model calls (S1)
apps/extension/src/service-worker/settings-port.ts     # NEW: port, trust check, projection, command dispatch (S2)
apps/extension/src/service-worker/agent-choices.ts     # NEW: store, fallback, migration (S2)
apps/extension/src/service-worker/bootstrap.ts, shared-port.ts, agent-panel-port.ts  # accept the new port; panel unchanged (S2)
apps/extension/src/build-config.ts, scripts/write-manifest.ts, vite.config.ts        # settings.html + options_ui (S2)
apps/extension/src/settings/                           # NEW: page, sections, cards, moved components, settings.css (S3)
apps/extension/src/side-panel/agent/AgentShell.tsx     # Sessions tab, removals, empty state, open-settings (S4)
apps/extension/src/side-panel/agent/SessionCard.tsx    # permissions link (S4)
apps/extension/src/side-panel/agent/conversation/      # picker from choices; download prompts → link (S4)
apps/extension/src/locales/{en-US,zh-TW}.ts            # all new texts, written before S3/S4 start (S2 end)
tests/contract/locales.contract.test.ts                # scan src/settings (S3)
tests/e2e/fixtures/side-panel-driver.ts, settings-page-driver.ts (NEW), affected agent-*.spec.ts  # (S5)
tests/e2e/packaged/agent-settings-024.spec.ts          # NEW live gates (S5)
```

## Slices

| Slice | Content | Role | Depends on | Owns |
|---|---|---|---|---|
| S0 | Measurement: install-tree growth during `npm ci` for Codex and DeepSeek (R-376) | main | — | `.scratch/024` |
| S1 | Host: contracts in conversation.ts; check-agents with 5 s bound and cache; progress estimate (package folders, R-376 addendum), cancel, state/lock/last-test files, interrupted; TestRun; diagnostics by agent; fake-agent knobs | `implementer` effort high (process lifecycle, cross-process lock) | S0 | packages/contracts/src/conversation.ts, packages/agent-host, tests/harness |
| S2 | Worker: settings port + trust check + closed commands + projection; agentChoices store, fallback, migration; panel projection additions; settings.html entry + options_ui; then main writes all new locale keys | `implementer` effort high (authorization boundary; R2 path decided) | S1 contracts | packages/contracts/src/{settings,agent-tools}.ts, apps/extension/src/service-worker, build files |
| S3 | Settings page UI: four sections, cards, deep-link routes, toasts, moved components, appearance (D-024-20), 375 px, a11y, both languages and themes | `implementer-sonnet` | S2 | apps/extension/src/settings, locale contract scan |
| S4 | Side panel: Sessions tab and value rename, removals, permissions link, empty state, picker from choices, download prompts → settings link | `implementer-sonnet` | S2 | apps/extension/src/side-panel |
| S5 | Integration: machine checks; e2e driver + fixtures + affected specs; new gate spec L1–L14; screenshots vs prototype A; owner-machine Test on three real agents | main + `test-analyst` (gate run) + `acceptance-verifier` (screenshot judgement) | S1–S4 | tests/e2e, `.scratch/024` |

S3 and S4 run in parallel (disjoint folders; the locale files are written by main at the end of S2 and not
touched by either). Reviews: `code-reviewer` after S1 and after S2; `architecture-reviewer` on S1+S2;
`code-reviewer` on the combined diff.

## FR coverage

| FR | Slice | FR | Slice |
|---|---|---|---|
| FR-375 | S2, S3 | FR-387 | S1, S3 |
| FR-376, FR-377, FR-378 | S1, S3 | FR-388 | S1, S3 |
| FR-379 | S1, S3 | FR-389, FR-390 | S3 (D-024-20) |
| FR-380 | S1, S3 | FR-391 | S4, S5 |
| FR-381 | S1, S3 | FR-392, FR-393, FR-394 | S4 |
| FR-382, FR-383 | S2, S3 | FR-395 | S2, S3 |
| FR-384 | S2, S4 | FR-396 | S1, S2 |
| FR-385 (D-024-21), FR-386 | S2, S3 | FR-397 | S1 |

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Second port with its own trust check | the page changes permissions but must never stand in for a panel | relaxing the panel check gives every extension page panel authority |
| Shared state files + lock between brokers | readiness is per computer while brokers are per browser | broker-to-broker IPC is new transport for one page |
| Install-tree size estimate | FR-379 asks for percent and time left; npm reports none | a custom downloader re-implements npm's integrity checks |
| TestRun outside the pool | Test must not touch conversations or the running cap | a pool conversation shows in the list and can evict the owner's |

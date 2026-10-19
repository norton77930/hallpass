# Implementation Plan: A Conversation in the Side Panel with the Owner's Own Coding Agent (019)

**Branch**: `worktree-feature-019-side-panel-agent` | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md)
(approved 2026-10-18, D-019-1..11)
**Status**: Architecture review 2026-10-19: approve with changes — all 11 findings folded in (R-312
lifetime anchor + attested broker, R-321 panel identity + teardown + token hygiene, R-318 paged log,
R-316 any drift, R-319 lease, R-317/R-320 open points). Awaiting the owner's approval; no slice starts
before it.

## Summary

The relay that Chrome starts now also starts one **broker** per browser (R-312). The broker puts itself
in a Windows kill-on-close job before anything else (R-313, koffi), installs a pinned slim ACP adapter on
the owner's consent with `npm ci` against a lockfile Hallpass ships (R-314), runs the owner's installed
Claude Code or Codex through it, and talks to the worker over the existing loopback link as one more
session, so the relay keeps forwarding without policy. Conversations start strict, the broker enforces a
mode allow-list and owns "allow for this conversation" itself (R-316, R-317). Each conversation's agent
reaches the browser through Hallpass's own mcp-server, admitted by a per-conversation token the worker
issued instead of a pairing card, under the unchanged site gate (R-321). The panel gets two tabs with the
external consent cards above them (R-325). Hallpass stores an index, a folder list and scratch folders,
never content (R-319). Link protocol stays 2; the tool list is unchanged (R-323).

## Technical Context

**Language/Version**: TypeScript, Node ≥ 24 (host and broker), MV3 extension, React side panel.
**Primary Dependencies**: new — `@agentclientprotocol/sdk` (owner-approved 2026-10-18, broker's ACP
client), `koffi` (owner-approved 2026-10-18, job object, R-313). Downloaded at run time on consent, not
bundled — the two pinned adapters (R-314).
**Storage**: host files under `%LOCALAPPDATA%\hallpass` (`conversations.json`, `folders.json`,
`agents\`, `scratch\`, `broker.log`); `chrome.storage.local` keys `agentPanelConsent`, `agentPanelTab`,
optional fields on `agentSiteModes` (data-model).
**Testing**: vitest unit / extension-ui / contract; relay-process tests (`packages/agent-host/tests`);
a fake ACP agent (R-329); packaged gate in attach mode; release probe S19 with real agents (paid).
**Target Platform**: Windows 11, Chrome/Edge/Brave/Chromium as in 010/018.
**Performance Goals**: first words ≤ 10 s after send (SC-134); panel stream ≤ 1 frame / 50 ms per
conversation (R-318).
**Constraints**: no agent process survives the browser (SC-136); no full-access mode reachable
(SC-140); no regression of external agents (SC-138); no credentials handled (FR-302).
**Scale/Scope**: ≤ 3 running agents per browser, ≤ 50 index entries, ≤ 30 folders.

## Constitution Check

- **I/XII Spec before implementation**: spec 019 approved; this plan and the tasks need owner approval
  before S1.
- **II Clean room**: reference products were read for observable behaviour only; nothing in this plan
  names or reuses their identifiers or code. The adapters and the protocol are open-source dependencies,
  used as such.
- **IV Explicit uncertainty**: open items are named — R-317 option ids (confirmed in S4), R-320 dialog
  z-order (S7), R-322's Codex fallback name (only if an owner entry has a `url`).
- **V Least privilege**: no new extension permission. The panel agent gets no power an external agent
  lacks; its admission is narrower (a worker-issued token, withdrawable). Modes are allow-listed.
- **VI Privacy**: no content stored; the npm registry request is disclosed on the consent card; agent
  error text is redacted (R-326); the agent talks to its own vendor exactly as in the terminal.
- **X Dependency discipline**: two runtime dependencies, both owner-approved, each traced (SDK → FR-285;
  koffi → FR-296). The adapters are downloaded only on consent and pinned by integrity.
- **XI Failure behaviour**: every `ConversationError` code maps to a spec scenario (contract).
- **Project rule, test first**: each slice starts with its failing test (below).

**Gate**: passes. **Risk**: R2 (a new kind of agent admitted to the browser; file/command permission
handling; a native dependency; process lifetime). → architecture review of this plan before S1;
security-focused code review of S2 and S6; final code review before 0.13.0.

## Components

| Party | Change |
| --- | --- |
| contracts | `hello.role` + `brokerSecret`, `hello.panelToken`; frames `relay-gone`, `conversation-command/result/event/overview/page/browser-token`; panel commands `ui.conversation.*`; panel state `conversation`; site record `changedBy`/`changedAt`; `ConversationError` |
| relay (`native-host.ts`, new `broker-launch.ts`) | after ack: adopt the broker of the same browser run (sidecar) or spawn one with a stdin secret; send `relay-gone` on leave; admit `role: "broker"` only with the secret (admission, not routing: `relay-mux.ts` routing unchanged, greeting check extended) |
| broker (new: `broker.ts`, `broker/job.ts`, `broker/agents.ts`, `broker/install.ts`, `broker/conversation.ts`, `broker/index-store.ts`, `broker/folders.ts`, `broker/redact.ts`) | job, link dial, agent discovery, install, ACP client, modes, permission rules, event log, idle/cap, index, folders, dialog |
| mcp-server | read `HALLPASS_PANEL_TOKEN`, send it in `hello`, one instructions line |
| worker (`agent-bridge.ts`, `agent-runtime.ts`, new `conversation-relay.ts`, `panel-consent.ts`) | broker link, panel sessions via token, start tab, consent store, forward commands/events, site-mode `changedBy` in the six writers |
| panel (`AgentShell.tsx`, new `conversation/*`) | tab bar, Conversation tab (picker, header, messages, action list, cards, mode switch, list, folders), first-use card, consent switch, en-US + zh-TW |
| package | `broker.js` entry, koffi external, adapter lockfiles, install/uninstall lists |

## Slices

| Slice | Scope | Depends on | Evidence (first failing test) | Risk / review |
| --- | --- | --- | --- | --- |
| S0 | this plan, research, data-model, contracts, quickstart, tasks; **architecture review** | — | review | before code |
| S1 | contracts + fake ACP agent harness | S0 + owner | contract: frames refuse unknown fields, `set-mode` has no third value, protocol still 2, tools unchanged | low |
| S2 | relay spawns/adopts the broker; stdin secret + greeting admission; broker job (koffi), link dial, `relay-gone` redial window, shutdown | S1 | relay-process tests: a greeting with `role` and no/old secret is refused; kill only the relay → a new relay of the same run adopts and agents survive; no relay of that run within 15 s → 0 pids; hard-kill the broker → 0 pids incl. `cmd.exe` + detached grandchildren | high — security-focused review (lifetime + admission) |
| S3 | agent discovery + install (`npm ci` + lockfiles) + availability in snapshot | S2 | unit: missing / found / staging failure leaves nothing; integrity mismatch refused (tampered lock) | medium |
| S4 | conversation core: ACP client, strict on start/resume, allow-list + drift (any un-requested change), permission mapping + rules (`other` by tool name), paged event log, idle, cap, crash, lease; live measurements of R-317's open points and Codex in-folder edits | S2, S3 (fake agent) | unit against fake agent: an agent-initiated switch to an *allowed* mode is reset; a page never exceeds 256 KB; allow-conversation never sends "always"; cap evicts idle only | high |
| S5 | worker relay + panel: tabs, Conversation tab, cards, mode switch, first-use + consent card, remembered tab, count | S1, S4 | jsdom: external card visible on both tabs; no third mode rendered; packaged gate `agent-conversation.spec.ts` part 1 | medium |
| S6 | panel browser access: token, panel agent id `panel:<id>`, browser pinned by `HALLPASS_PANEL_BROWSER`, synthetic pair result, start tab, consent switch + unpair-shaped teardown on withdrawal, `changedBy` | S4, S5 | unit: unknown token is refused, never paired externally; a panel session ignores the owner's external pairing and the status-row unpair; withdrawal tears down groups/plans/debugger and refuses the next call; site record with `changedBy` round-trips; gate part 2 | high — security-focused review (admission) |
| S7 | index, folders, scratch, dialog, history UI, cannot-resume | S4, S5 | unit: 50 / 30-day pruning, corrupt file kept aside; gate part 3 | low |
| S8 | duplicate "hallpass" handling (R-322): same-name entry, Codex filter variable + explicit fields + `/rename` first, `url` fallback | S6 | fake-agent unit: entry fields complete; first Codex input is `/rename`; probe S19 checks the owner's `hallpass` is not started | medium |
| S9 | package + docs (README, operations guide, PRIVACY.md), version 0.13.0, regression gate, probe S19, **final code review** | all | quickstart §1–4 | final review |

Parallel: S3 ∥ S5's static UI work once S1 lands (disjoint files); S7 ∥ S6 after S5 (disjoint: host
files vs worker admission). Writers ≤ 2.

Estimate: 9.5–12 working days of agent time.

## Owner checkpoints

1. This plan (and its architecture review findings) → approve before S1.
2. After S4's measurement: if Codex's strict mode edits inside the folder without asking, SC-135 is
   restated for Codex as "outside the folder" (the panel already says so, FR-293) — or the owner picks
   another Codex strict setting if S4 finds one.
3. Paid probe S19 and the 0.13.0 release.

## Project Structure

```text
specs/019-side-panel-agent/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md
├── contracts/conversation-frames.md
├── checklists/requirements.md
└── tasks.md                      # next: /speckit-tasks

packages/agent-host/src/broker.ts, src/broker/*.ts, agents/<agent>/package(-lock).json
packages/contracts/src/agent-tools.ts (+ conversation.ts)
apps/extension/src/service-worker/conversation-relay.ts, panel-consent.ts
apps/extension/src/side-panel/agent/conversation/*
tests/harness/fake-acp-agent.ts
tests/e2e/packaged/agent-conversation.spec.ts
```

**Structure Decision**: existing workspaces only; the broker is a new entry of `packages/agent-host`
because it shares the link code and is bundled with the host.

## Complexity Tracking

| Addition | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| a fourth runtime process (broker) | agents must outlive the panel and die with the browser (D-019-4) | relay-hosted agents put policy in the forwarder (R-312) |
| native dependency koffi | FR-296 / SC-136 measured to need a kill-on-close job | PowerShell holder costs every Chrome start; `taskkill` misses crashes (R-313) |

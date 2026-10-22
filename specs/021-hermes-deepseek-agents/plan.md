# Implementation Plan: Hermes and DeepSeek in the Side-Panel Conversation

**Branch**: `feature-022-composer-attachments` (021 ships with 022 as 0.15.0) | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)
**Input**: specs/021-hermes-deepseek-agents/spec.md (D-021-1..15, confirmed by the owner)

## Summary

The broker's two-agent table becomes a table of agent descriptions with three ways to obtain the agent
(adapter over an installed CLI: Claude Code, Codex; installed ACP program: Hermes; fetched ACP package:
DeepSeek) and with each panel mode mapped to either an agent mode (`session/set_mode`) or launch settings
(environment and a Hallpass-owned settings layer). Hermes strict = Hermes `default` mode started with a
managed settings layer that switches its command, code-running, helper-agent and saved-logins tools off;
DeepSeek strict = its read-only sandbox, automatic = its folder sandbox, telemetry disabled. A mode change
for a launch-time mode restarts the agent and continues the session (Hermes: `session/load`; DeepSeek:
`session/resume`, no replay). A conversation that is still starting can be stopped. A permission card
whose request names only an action id takes its detail from the announced action; with nothing to show it
offers only Reject. The panel lists the two agents with their states, letters, texts and notes.

## Technical Context

**Language/Version**: TypeScript (Node >= 24 host; Chrome MV3 extension)
**Primary Dependencies**: existing only (zod contracts, @agentclientprotocol/sdk, React). The DeepSeek
agent package (`@deepseek-ai/dsh` 0.2.1-rc.2) is not a Hallpass dependency: it is fetched on first use into
the agent folder from a committed manifest and lockfile, like the two existing adapters. Hermes 0.22.2 is
installed by the owner.
**Storage**: `%LOCALAPPDATA%\hallpass\agents\deepseek\<version>\` (fetched package);
`%LOCALAPPDATA%\hallpass\agents\hermes\managed\<mode>\config.yaml` (written by the broker, fixed content).
Nothing of the owner's Hermes or DeepSeek settings is written.
**Testing**: vitest `unit` (contracts, broker, fake agent scenarios), `extension-ui` (panel), contract tests,
packaged conversation gate (fake agent scenarios `hermes` / `deepseek`), live runs of the real agents on the
owner's model (scratch ACP client and dev host), screenshots en/zh × light/dark.
**Target Platform**: Windows 11, Chrome / Edge / Brave.
**Performance Goals**: DeepSeek cold start up to ~6 min, Hermes first conversation up to ~4 min (measured
2026-10-21) — no broker timeout on start; the owner can stop it (SC-159: process gone within 5 s).
**Constraints**: clean room; strict must hold the asking bar (SC-155..157); no key handled (SC-161);
Claude/Codex unchanged (SC-162); host and extension are version-paired, so contract additions are safe.
**Scale/Scope**: 2 new agents, 4 agents total, cap of 3 live conversations unchanged.

## Constitution Check

- Spec-driven: spec 021, research R-345..R-356, tasks from T637. PASS.
- Test first: each behaviour task has a failing-test task before it; the agent mapping is tested through
  fake-agent scenarios that imitate each agent's measured messages. PASS.
- Clean room: behaviour from the agents' public protocol and own documentation, measured on our own client;
  no code copied from the agents or from other clients. PASS.
- Authority in the host: the mode → launch-settings mapping, the managed settings layer and the permission
  card rules live in the broker; the panel only shows them. PASS.
- Public snapshot: no absolute paths; the DeepSeek lockfile names registry URLs only. PASS (`snapshot:check`).
- Risk: **R1** — consent path (permission detail, reject-only, mode → launch settings) and process lifecycle
  (stop while starting, restart on mode change). Code review after S2 and on the combined diff. Not R2: no
  credential is handled (keys stay with the agents), no stored data migrates, contract changes are additive
  and version-paired.

## Project Structure

### Documentation (this feature)

```text
specs/021-hermes-deepseek-agents/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md  tasks.md
├── contracts/agents.md
└── checklists/requirements.md
```

### Source Code (touched)

```text
packages/contracts/src/conversation.ts           # CONVERSATION_AGENTS + hermes, deepseek; availability notes; card rejectOnly; codes start-cancelled, agent-model-unreachable
packages/agent-host/src/broker/agents.ts          # descriptor table (kind, discovery, version, launch per mode, accepts expectations, install timeout)
packages/agent-host/src/broker/agent-launch-settings.ts  # NEW: Hermes managed layer, DeepSeek env; pure, tested
packages/agent-host/src/broker/conversation.ts    # mode map per agent, launch-time modes restart, resume without load, stop while starting, permission detail join, reject-only, model-unreachable
packages/agent-host/src/broker/commands.ts        # availability notes (git), per-agent install timeout
packages/agent-host/src/broker/install.ts         # per-agent timeout
packages/agent-host/agents/deepseek/{package.json,package-lock.json}  # NEW: exact pin + integrity
scripts/package.ts, scripts/package/install.ps1   # ship the deepseek manifest
tests/harness/fake-acp-agent.ts                   # scenarios hermes, deepseek
apps/extension/src/side-panel/agent/conversation/ # AgentMenu, agent-mark, ModeMenu notes, starting + Stop, PermissionCard reject-only, no-replay notice
apps/extension/src/locales/{en-US,zh-TW}.ts       # names, states, notes, hints
```

## Slices

| Slice | Content | Role | Depends on | Owns |
|---|---|---|---|---|
| S1 | Contracts; descriptor table and the three kinds; Hermes discovery + exact version + Git note; DeepSeek manifest/lockfile, packaging, per-agent install timeout; launch settings (managed layer, env) as a pure module | `implementer` (effort high: consent-relevant launch settings) | — | packages/contracts, packages/agent-host/src/broker/{agents,agent-launch-settings,install,commands}.ts, packages/agent-host/agents/deepseek, scripts/package*, their tests |
| S2 | Broker runtime: mode map per agent, restart on launch-time mode change, resume without load, stop while starting, permission detail from the announced action + reject-only, model-unreachable code; fake-agent scenarios | `implementer` (effort high: consent path + process lifecycle) | S1 | packages/agent-host/src/broker/conversation.ts, tests/harness/fake-acp-agent.ts, broker tests |
| S3 | Panel: agent list entries, marks, states and notes, starting text + Stop, reject-only card, no-replay notice, mode-menu notes, en/zh, a11y | `implementer-sonnet` | S1 contracts | apps/extension/src/side-panel, apps/extension/src/locales, apps/extension/tests |
| S4 | Integration: build, contract, packaged gate with the new scenarios, live runs of the real agents through the dev host on the owner's model (owner installs the dev host with `!`), screenshots | main + `test-analyst` | S1–S3 | .scratch only |

S2 and S3 run in parallel after S1 (disjoint paths; neither builds — main runs `tsc -b` between waves).
Reviews: `code-reviewer` after S2 (consent path, lifecycle) and on the combined diff after S3.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Launch-time modes with restart | Hermes' tools and DeepSeek's sandbox are fixed when the agent starts | asking the agent to switch mode cannot turn Hermes' command tools off or change DeepSeek's sandbox |
| Managed settings layer for Hermes | strict must switch tools off without touching the owner's Hermes settings | a separate Hermes home would lose the owner's model and keys |
| Reject-only card | DeepSeek can ask without naming the action | an Allow on an action nobody can see breaks the asking promise |

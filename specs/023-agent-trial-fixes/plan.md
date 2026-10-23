# Implementation Plan: Fixes from the Owner's First Hermes Trial

**Branch**: `feature-022-composer-attachments` (023 ships as 0.15.2) | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)
**Input**: specs/023-agent-trial-fixes/spec.md (D-023-1..8, confirmed by the owner)

## Summary

Hermes' saved-logins tool is removed by switching off Hermes' whole `browser` tool group in the
Hallpass-owned settings layer (R-363), checked against the real Hermes' tool list (R-364); this slice can
ship alone. The service worker tells the broker when a conversation's browser server greets; Hermes runs
without that greeting within 10 s of session creation and DeepSeek always get a `browser-tools-missing`
notice with an agent-specific fix (R-365). For agents without page context the tab goes as a `.txt` file
beside attached files (R-366). The panel shows starting and waiting time and a server/VPN hint at 30 s
(R-370). A failed Hermes start or first turn checks, by name only, whether its key variable exists in the
owner's user settings but not in the browser's environment (R-369). Each agent run keeps its last 50
scrubbed output lines in memory, shown on request (R-367).

## Technical Context

**Language/Version**: TypeScript (Node ≥ 24 host, Chrome MV3 extension), React side panel
**Primary Dependencies**: existing only (zod contracts, ACP over stdio); no new dependency
**Storage**: none new (diagnostic lines in memory only; tab files in the existing attachments folder)
**Testing**: vitest `unit` + `extension-ui`; contract project after build; fake ACP agent scenarios; scratch
measurement on the owner's real Hermes 0.22.2
**Target Platform**: Windows 11, branded Chrome
**Project Type**: browser extension + local host
**Performance Goals**: waiting indicator within 2 s of sending (SC-164); browser-tools check ≤ 10 s after
session creation
**Constraints**: no key value read/kept/logged; owner's Hermes settings untouched; Claude/Codex unchanged
except waiting feedback and diagnostics; en-US + zh-TW; 006/020 keyboard and screen-reader bar
**Scale/Scope**: four agents; one notice per conversation

## Constitution Check

- Spec-driven: spec 023, research R-363..R-370, tasks from T702. PASS.
- Test first: each behaviour task has its failing test first; the saved-logins removal also has a real-agent
  measurement (FR-363). PASS.
- Clean room: Hermes behaviour read from its own source and measured on our client; nothing copied. PASS.
- Authority in the host: the settings layer, the browser-tools check, the key-name check and the scrubbing
  live in the broker; the worker only reports a greeting it already sees; the panel only shows. PASS.
- Public snapshot: no absolute paths; the measurement lives in `.scratch/023`. PASS (`snapshot:check`).
- Risk: **R1** — security setting (saved-logins tool), secret scrubbing of kept output, reading the user's
  environment names, process lifecycle (draining the agent's output). Code review after S2 and on the
  combined diff. Not R2: no key value is handled or passed, no credential path changes, no stored data
  migrates, contract changes are additive and version-paired.

## Project Structure

### Documentation (this feature)

```text
specs/023-agent-trial-fixes/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md  tasks.md
├── contracts/frames.md
└── checklists/requirements.md
```

### Source Code (touched)

```text
packages/agent-host/src/broker/agent-launch-settings.ts   # disabled groups: browser in place of browser_vault (S1)
packages/contracts/src/conversation.ts                    # browser-attached frame, notice codes, diagnostics request/reply (S2)
packages/agent-host/src/broker/conversation.ts            # tab file, browser check timer, key-name check, output ring (S2)
packages/agent-host/src/broker/attachments.ts             # tab text file placement (S2)
packages/agent-host/src/broker/agents.ts                  # descriptor: takesBrowserTools, checksBrowserTools (S2)
packages/agent-host/src/broker/user-environment.ts        # NEW: names under the user's environment settings; Hermes key-name reader (S2)
packages/agent-host/src/broker/redact.ts                  # reused; no change expected
tests/harness/fake-acp-agent.ts                           # scenarios: no browser greeting, stderr lines, auth failure (S2)
apps/extension/src/service-worker/agent-runtime.ts        # forward panel greeting as conversation-browser-attached (S3)
apps/extension/src/side-panel/agent/conversation/         # starting line all agents, waiting timer + hint, tab not greyed, notices, details lines (S3)
apps/extension/src/locales/{en-US,zh-TW}.ts               # texts (S3)
```

## Slices

| Slice | Content | Role | Depends on | Owns |
|---|---|---|---|---|
| S1 | Saved-logins removal: `browser` group in both modes, unit test pinning the text; scratch measurement on the owner's Hermes (R-364) | main (two-line change) + measurement | — | agent-launch-settings.ts + its test; .scratch/023 |
| S2 | Contracts (R-368); broker: tab file (R-366), browser-tools check + DeepSeek notice (R-365), key-name check (R-369), output ring + diagnostics reply (R-367); fake-agent scenarios | `implementer` (effort high: secret scrubbing, lifecycle) | S1 | packages/contracts, packages/agent-host (except S1 file), tests/harness |
| S3 | Worker greeting forward; panel: starting line for all agents, waiting timer + 30 s hint, tab enabled for no-context agents, two notices, diagnostics view; en/zh; a11y | `implementer-sonnet` | S2 contracts | apps/extension |
| S4 | Integration: typecheck, unit, build, contract, snapshot; live on the owner's Hermes: notice before the `mcp` component (dry-run then install, owner-approved D-023-4), tools after; saved-logins absent; tab file answer; screenshots | main + `test-analyst` | S1–S3 | .scratch/023 |

S1 first (may release as 0.15.2 alone if S2/S3 slip). S3 starts once S2's contract step is committed
(disjoint paths). Reviews: `code-reviewer` after S2 and on the combined diff.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Disabling Hermes' whole `browser` group | the only switch that removes the saved-logins tool everywhere | no per-tool switch exists in Hermes 0.22.2 |
| New worker → broker frame | only the worker sees the browser server's greeting | log scraping is version-specific and silent on the failure |
| Reading the user's environment names | the only way to tell "set after the browser started" from "never set" | asking the owner gives no answer they can act on |

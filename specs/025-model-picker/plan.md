# Implementation Plan: Side-Panel Model Picker

**Branch**: `feature-025-model-picker` | **Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/025-model-picker/spec.md` (D-025-1..12, FR-398..412, SC-178..183)

## Summary

The composer gets one more chip, after the mode chip: the model the agent runs on and, when it is not the
agent's default, the reasoning effort (layout A). The broker reads what each agent reports when a session
opens - the ACP session options (`configOptions`, categories `model` and `thought_level`) for Claude Code,
Codex and DeepSeek, the unstable `models` field for Hermes - normalises it into one **model offer**, keeps
the last offer and the owner's last choice per agent in a host file, and applies the choice after
`session/new` / `session/load` / `session/resume` and the mode confirmation, before the first prompt. A
change between turns goes through `session/set_config_option` (or `session/set_model` for Hermes); an
accepted one adds a `model` event line, a refused one a notice and nothing else. The conversation index
keeps each conversation's model and effort so a continued conversation is put back on them. 0.17.0 ships
the extension and the host together; #18, #19 and #20 ride along as their own small slices.

## Technical Context

**Language/Version**: TypeScript 5.x, Node >= 24 (host), Chrome MV3 (extension), React 18 (side panel)
**Primary Dependencies**: `@agentclientprotocol/sdk` 1.9.0 (already installed; no new dependency), zod
**Storage**: new host file `<data>\agent-models.json` (R-401); conversation index gains `model` (R-404)
**Testing**: vitest `unit` (broker with the fake ACP agent), `extension-ui` (jsdom), `contract`; packaged
gate `agent-conversation` spec with the fake agent; a free real-agent probe (no prompt) for the four agents
**Target Platform**: Windows 11, branded Chrome
**Project Type**: extension + local host (npm workspaces)
**Performance Goals**: no added model call (SC-182); the start-time switch is a local request, bounded by
the existing start bound
**Constraints**: closed (`strictObject`) schemas on every new shape; nothing of the offer leaves the
computer (FR-410); no write to any agent's own configuration (FR-402); no absolute paths in tracked files
**Scale/Scope**: 4 agents, lists up to ~20 models (Hermes 18 measured), effort lists up to ~6

No NEEDS CLARIFICATION remains: the four agents' shapes were measured on 2026-10-26 (D2 of the handoff,
issue #15), and the SDK question (does it pass `models` through?) is settled in R-399.

## Constitution Check

- I/III Spec-driven and traceable: spec 025 → R-398..R-410 → tasks from T797 → tests; every FR maps to a
  slice below. PASS.
- II Clean room: the picker follows the public ACP schema (session config options, `session/set_model`)
  and the owner's prototype; no other product's code or identifiers. PASS.
- IV Explicit uncertainty: Hermes' `models` field is unstable in ACP - kept behind its version pin and
  the parser drops what it does not recognise (R-400); the #19 zh-TW wording choice is an assumption the
  owner can overrule (R-409). PASS.
- V Least privilege: no new permission, no new port; one new panel command (`set-model`) and two optional
  fields on existing commands, all closed (R-402). PASS.
- VI Privacy: model names are the agent's own; the offer stays in the host data folder and goes only to
  that agent (FR-410); no key, no prompt, no model answer is involved. PASS.
- VII Observable: each story has live gates in quickstart.md; the start-time order is checked by the fake
  agent's recorded request order (SC-179). PASS.
- XI Failure behaviour: refused change, refused start-time switch, model no longer offered, agent ends
  mid-switch, no list yet, agent reports none, unreadable offer file - all specified (R-403, R-405,
  R-406). PASS.
- Project rules: test first per behaviour change; no absolute paths (`snapshot:check`); evidence in
  `.scratch/025`.
- **Risk: R2 - contract between host and extension.** New fields on the overview, view, index entry and
  start command, a new command and a new event kind; an older extension refuses the newer host's frames
  (strict schemas), so both upgrade together (D-025-8, owner-approved 0.17.0). The existing version
  pairing (`tool-offering.ts`) is a build-time pin checked by the contract tests, not a runtime refusal: a mismatched pair drops the newer frames (an empty list, no version message), which is why host and extension ship together. Also R1: lifecycle/consistency (the
  choice must survive start, mode reload, Hermes restart, idle stop, crash and resume - R-403) and data
  conversion (the four agents' shapes into one offer - R-400). Reviews: `code-reviewer` (Fable, high) on
  S2 and on the combined diff before release; `architecture-reviewer` on S1 + S2 (new host file, new
  frames). Path: the owner's 2026-10-26 "請依spec-kit流程完成開發" continues in this lane; merge and
  release stay the owner's.

## Project Structure

### Documentation (this feature)

```text
specs/025-model-picker/
├── spec.md
├── plan.md              # this file
├── research.md          # R-398..R-410
├── data-model.md
├── quickstart.md        # live gates
├── contracts/frames.md  # wire changes
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks, from T797
```

### Source Code (touched)

```text
packages/contracts/src/conversation.ts          # offer / choice / view / entry / START / SET_MODEL / model event / codes
packages/agent-host/src/broker/
├── model-offer.ts        # NEW: configOptions / models -> offer; choice resolution (pure)
├── model-store.ts        # NEW: <data>\agent-models.json (read, write, last choice)
├── conversation.ts       # apply after session open; set between turns; config_option_update; index model
└── commands.ts           # ui.conversation.set-model; start's model
tests/harness/fake-acp-agent.ts                  # FAKE_ACP_MODELS scenarios + recorded order
apps/extension/src/service-worker/conversation-relay.ts   # pass-through (schema only, if any)
apps/extension/src/side-panel/agent/conversation/
├── ModelMenu.tsx         # NEW: models then effort pills
├── ConversationTab.tsx   # the chip; start carries the choice; disabled while a turn runs
└── conversation-log.ts   # `model` event line, model notices
apps/extension/src/locales/{en-US,zh-TW}.ts
apps/extension/src/settings/*                    # #18 / #19 only
tests/e2e/packaged/agent-conversation.spec.ts    # model gates (fake agent)
tests/e2e/packaged/settings-024.spec.ts          # #20
```

## Slices

| Slice | Content | Role | Depends on | Owns |
|---|---|---|---|---|
| S1 | Contracts (R-402, contracts/frames.md) + `model-offer.ts` pure parser and choice resolution with unit tests over the four measured shapes | `implementer-sonnet` | - | `packages/contracts/src/conversation.ts`, contract tests, `broker/model-offer.ts` + test |
| S2 | Broker: `model-store.ts`, apply after open (start, resume, mode reload, Hermes restart), `set-model` between turns, `config_option_update`, refusal / fallback notices, index `model`, fake agent scenarios (R-401, R-403..R-406) | `implementer` effort high (lifecycle/consistency across start, reload, restart, resume) | S1 | `packages/agent-host/src/broker/*`, `packages/agent-host/tests/broker-*`, `tests/harness/fake-acp-agent.ts` |
| S3 | Panel: chip + `ModelMenu` (prototype A), start carries the choice, disabled state, `model` lines and notices, locales, a11y, 320 px; worker pass-through (R-407, R-408) | `implementer-sonnet` (mockup + spec fix what to build) | S1 | `apps/extension/src/side-panel/agent/**`, locales, `apps/extension/tests/**/*.tsx`, `service-worker/conversation-relay.ts` |
| S4 | #18 DeepSeek download size + #19 settings polish (R-409) | `implementer-sonnet` | - (disjoint files; locales shared with S3 → after S3) | `apps/extension/src/settings/*`, locales, settings tests |
| S5 | Gate: model scenarios in `agent-conversation` spec, screenshots; #20 measured then fixed (R-410) | main (live browser) | S2, S3, S4 | `tests/e2e/packaged/*` |

S2 and S3 run in parallel after S1 (disjoint files; S3 builds against S1's schemas, S2's frames follow the
same schemas). S4 waits for S3 because both touch the locale files.

## FR coverage

| FR | Where | Evidence |
|---|---|---|
| FR-398 chip + popup layout | S3 | extension-ui tests; gate screenshots |
| FR-399 model + effort only | S1 (parser keeps only `model` / `thought_level`), S3 | unit; extension-ui |
| FR-400 remembered list, "Default" with no list | S2 (store), S3 (chip) | broker unit; extension-ui |
| FR-401 start with last choice, before first message, no line | S2 | broker unit with recorded order (SC-179) |
| FR-402 no agent config writes | S2 | test: only `session/set_*` requests; SC-181 file compare in probe |
| FR-403 only between turns | S2 (`busy`), S3 (disabled chip) | broker unit; extension-ui |
| FR-404 one line per accepted change, effort fallback named | S2, S3 | broker unit; extension-ui |
| FR-405 refusal keeps model, agent text, no retry | S2, S3 | broker unit (request count) |
| FR-406 re-apply on continue; index keeps model | S2 | broker unit (idle stop, crash, list open) |
| FR-407 no longer offered → default + one notice | S2 | broker unit |
| FR-408 configOptions win; Hermes via models | S1, S2 | unit over measured shapes |
| FR-409 chip follows the agent, own change adds no line | S2, S3 | broker unit; extension-ui |
| FR-410 local only | S2 | store path test; `snapshot:check` |
| FR-411 en/zh-TW, a11y, 320 px | S3 | extension-ui; gate screenshots both themes and languages |
| FR-412 settings page unchanged; rest as 0.16.1 | all | full suites green; settings tests untouched by S1-S3 |

## Complexity Tracking

None. One new host file is the smallest place a per-computer list both browsers share can live (R-401).

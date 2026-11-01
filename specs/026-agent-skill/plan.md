# Implementation Plan: A Hallpass Skill for Outside Coding Agents

**Branch**: `feature-026-agent-skill` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/026-agent-skill/spec.md` (D-026-1, D-026-2 decided).

## Summary

Hallpass ships one skill (a `SKILL.md` with a name, a when-to-use line and short instructions) that tells
an outside coding agent how the browser tools fit together, how consent works and that a declined or
timed-out card is the owner's answer. The local host owns the text and the two user-level folders
(D-026-1); the settings page shows each folder's state and installs or updates on the owner's click
(D-026-2); the host's uninstall removes only unchanged copies. One new settings command, one optional
overview field, one optional settings-state field; no new permission.

## Technical Context

**Language/Version**: TypeScript, Node >= 24 (host), Chrome MV3 (extension), React (settings page)
**Primary Dependencies**: existing only - zod contracts, `node:crypto` (SHA-256), `node:fs/promises`
**Storage**: two files in the owner's home (`<claude config>\skills\hallpass\SKILL.md`,
`%USERPROFILE%\.agents\skills\hallpass\SKILL.md`); nothing in the extension's storage
**Testing**: vitest `unit` (host, contracts), `extension-ui` (settings page), `contract` (shipped text)
**Target Platform**: Windows 11 (host paths), as the rest of Hallpass
**Project Type**: browser extension + local host
**Performance Goals**: the state is two small file reads per overview; no measurable cost
**Constraints**: strict schemas (an undeclared field is refused), clean room, snapshot check (no owner path
in tracked files), host and extension upgrade together
**Scale/Scope**: 2 locations, 5 states, 1 command

## Constitution Check

| Principle | Result |
| --- | --- |
| I. Product requirements | PASS. Issue #16 and D-026-1/2, owner-confirmed. |
| II. Clean room | PASS. The skill text is written from Hallpass's own README behaviour; no other product's skill is read or adapted (R-412). |
| III. Traceability | PASS. FR-413..424 → R-411..416 → T829.. → tests named per FR. |
| IV. Explicit uncertainty | PASS. The folder Codex reads is recorded as checked on the owner's machine in quickstart step 5, not assumed beyond R-411. |
| V. Least privilege | PASS. No manifest change; the host writes two files only on a click. |
| VI. Privacy | PASS. Paths cross to the page with the profile said as `%USERPROFILE%` (R-414); nothing is sent off the computer. |
| VII. Observable | PASS. States and counts in SC-184..188. |
| VIII. MV3 | PASS. Unchanged. |
| IX. Requirements before architecture | PASS. Spec carries no architecture. |
| X. Dependencies | PASS. None added. |
| XI. Failure behaviour | PASS. FR-420 (atomic write, reason shown), unreadable state. |
| XII. Spec first | PASS. |

## Project Structure

### Documentation (this feature)

```text
specs/026-agent-skill/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md, tasks.md
├── contracts/frames.md
└── checklists/requirements.md
```

### Source Code (touched)

```text
skills/hallpass/SKILL.md                               # readable copy of the shipped text (R-413)
packages/contracts/src/conversation.ts                 # locations/states, overview `skills`, install-skill command
packages/contracts/src/settings.ts                     # settings state `skills`, command in the settings union
packages/agent-host/src/agent-skill.ts                 # text, shipped hashes, locations, state, install, removal
packages/agent-host/src/broker/commands.ts             # install-skill case; `skills` in the overview
packages/agent-host/src/broker.ts                      # wires the skill port into the handler
packages/agent-host/src/install/cli.ts                 # uninstall removes unchanged copies
apps/extension/src/service-worker/settings-port.ts     # forwards the command
apps/extension/src/service-worker/conversation-relay.ts# overview `skills` → settings state
apps/extension/src/settings/…                          # the "Skill for your agents" section
apps/extension/src/locales/{en-US,zh-TW}.ts, settings-keys.ts
```

**Structure Decision**: the host owns everything that touches files (the extension cannot write to the
owner's home); the page only shows states and sends one command, as the agent installs of 024 do.

## Slices

1. **S1 text + host module** (T829-T832): `agent-skill.ts`, `skills/hallpass/SKILL.md`, contract test.
2. **S2 contracts + broker** (T833-T835): schemas, command, overview field.
3. **S3 settings page** (T836-T838): worker forwarding, section, locales.
4. **S4 uninstall + docs** (T839-T841): cli.ts, README, coverage.

## Complexity Tracking

None: no principle is bent.

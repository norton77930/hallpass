# Implementation Plan: Attachments in the Side-Panel Conversation

**Branch**: `feature-022-composer-attachments` | **Date**: 2026-10-21 | **Spec**: [spec.md](spec.md)
**Input**: specs/022-composer-attachments/spec.md (D-022-1..9 decided by Claude under the owner's delegation)

## Summary

The composer gains a "+" menu, paste and drop. The panel prepares every attachment locally (images scaled and
re-encoded, files read, the tab captured through the worker) and transfers nothing until Send. On Send, after
the conversation exists (020 start-then-send), the panel streams each attachment to the broker as
`ui.conversation.attach` pieces of at most 512 KiB, each awaited through its command result, then sends
`ui.conversation.send` naming the attachment ids. The broker stages images and the tab text in memory and
files as hidden `.part` files inside `<folder>\hallpass-attachments\`, turns them into the prompt's content
blocks at send, and gives each file its final, never-overwriting name. The broker reads the agent's
`promptCapabilities` at `initialize` and reports them in the projection.

## Technical Context

**Language/Version**: TypeScript (Node >= 24 for the host; Chrome MV3 for the extension)
**Primary Dependencies**: existing only — zod contracts, @agentclientprotocol/sdk 1.9.0, React (panel). No new dependency (D-022-9).
**Storage**: files in the conversation folder only; staged data in broker memory; nothing in extension storage beyond the existing draft.
**Testing**: vitest projects `unit` (contracts, broker, worker) and `extension-ui` (panel); contract tests; packaged-gate shots via `.scratch/t602` runner.
**Target Platform**: Windows 11, Chrome / Edge / Brave.
**Project Type**: extension + local host (existing monorepo).
**Performance Goals**: SC-148 (image ready < 2 s), SC-150 (25 MB < 30 s).
**Constraints**: native frame ≤ 1 MiB both ways (`native-frame.ts`); one picture ≤ 700 000 base64 chars (adapters + existing bound); clean room.
**Scale/Scope**: ≤ 5 images + ≤ 5 files (≤ 25 MB total) + 1 tab per message.

## Constitution Check

- Spec-driven: spec 022, research R-336..R-344, tasks from T611. PASS.
- Test first: every behaviour task has a failing test task before it. PASS.
- Clean room: behaviour taken from observation of other panels (+ menu, paste, screenshot); no code, asset or wording copied. PASS.
- Authority lives in worker/host: limits, naming and path containment are enforced by the broker; the panel's checks are only for early, friendly refusals. PASS.
- Public snapshot: no absolute paths in tracked files. PASS (checked by `snapshot:check`).
- Risk: R1 (new link commands; writes into the user's folder). Code review after S1 and at the end; architecture review of the link protocol after S1. Not R2: no auth, no schema migration of stored data, no public API break (additive commands; host and extension are version-paired).

## Project Structure

### Documentation (this feature)

```text
specs/022-composer-attachments/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md  tasks.md
├── contracts/attachments.md
└── checklists/requirements.md
```

### Source Code (touched)

```text
packages/contracts/src/conversation.ts        # attach / attach-cancel / send.attachments / event + projection fields
packages/contracts/src/agent-tools.ts         # panel command `ui.tab.capture`, worker reply `tab-capture-result`
packages/agent-host/src/broker/attachments.ts # NEW: staging store, naming, containment, limits, cleanup
packages/agent-host/src/broker/conversation.ts# capabilities at initialize; prompt blocks; owner event attachments; replay images
packages/agent-host/src/broker/commands.ts    # route attach / attach-cancel
apps/extension/src/service-worker/tab-attach.ts        # NEW: screenshot / text / PDF of the viewed tab
apps/extension/src/service-worker/agent-panel-port.ts  # route `ui.tab.capture`
apps/extension/src/side-panel/agent/conversation/attachments/  # NEW: prepare (image scale, file read), transfer, chips, + menu
apps/extension/src/side-panel/agent/conversation/Composer.tsx, ConversationTab.tsx, message bubble
apps/extension/src/side-panel/agent/AgentShell.tsx     # request(command) -> Promise<result> for the transfer
apps/extension/src/side-panel/i18n (en-US, zh-TW strings)
```

## Slices

| Slice | Content | Role | Depends on | Owns |
|---|---|---|---|---|
| S1 | All contract changes; broker staging store, limits, naming, containment, cleanup, prompt blocks, capabilities, owner-event attachments, replayed images | `implementer` (effort high: writes into the user's folder, path containment, cleanup lifecycle) | — | packages/contracts, packages/agent-host |
| S2 | Worker `ui.tab.capture`: screenshot, page text, PDF fetch, restricted refusal | `implementer` | S1 contracts | apps/extension/src/service-worker, its tests |
| S3 | Panel: + menu, paste, drop, image preparation, file read, chips, transfer with awaited results, held message, attachment-only send, bubble, capability disabling, i18n, a11y | `implementer` | S1 contracts (S2 for the two tab entries' live behaviour, mocked in tests) | apps/extension/src/side-panel, apps/extension/tests/*.test.tsx |
| S4 | Integration: build, contract tests, packaged conversation gate, fake-agent shots light/dark × en/zh, owner-facing compare page | main + `test-analyst` | S1–S3 | .scratch only |

S2 and S3 run in parallel after S1 (disjoint paths; neither runs `tsc -b` on packages or the extension build — main does that between slices). Reviews: `architecture-reviewer` + `code-reviewer` after S1 (link protocol and folder writes), `code-reviewer` on the combined diff after S3.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Piecewise transfer (R-337) | files up to 25 MB, frame ≤ 1 MiB | raising the frame cap touches every link and the decoder's safety bound |
| Staged `.part` files | spec FR-332 (no partial file visible, nothing left on failure) | writing straight to the final name leaves partial files and needs the name before the bytes arrive |

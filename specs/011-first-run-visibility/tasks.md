---

description: "Task list for First-Run Visibility"
---

# Tasks: First-Run Visibility

**Input**: `/specs/011-first-run-visibility/spec.md`, `plan.md` (S1–S3), `research.md`
(R-160–R-165), `data-model.md`, `contracts/prompt-waiting.md`, `quickstart.md`.

**Tests**: TDD in S1/S2 (RED on bound selection, router keep-alive, server progress message,
attention derivation before the code); S3 closes on the packaged gate and one paid probe (owner's
go-ahead). `code-reviewer` after S1+S2 (cross-module protocol change, timer paths).

**Numbering** continues from 010 (T264–T281): this feature starts at **T282**.

## Standing rules (owner, 2026-09-18 — binding for every task)

1. **Two attempts, then stop.** A task that fails its second attempt is not tried a third time.
2. **Clean room.** The reference has nothing to copy here; no reference identifier in `specs/`
   or source.
3. **One writer at a time.** Brief 1 = contracts + host; brief 2 = worker + badge; brief 3 = gate
   spec; docs and the probe stay with the main session.
4. **No new permission; nothing private leaves.** `npm run snapshot:check` before the final commit.
5. **No paid run without the owner's go-ahead** (T299).

## Phase 1 — Setup

- [X] T282 Read `contracts/prompt-waiting.md`, `data-model.md`, `research.md` R-162–R-164 and the
  sources they name; confirm at HEAD: `ASK_TIMEOUT_MS = 25_000` (`agent-tools/prompts.ts`), the
  router backstop 30 s (`router.ts`), pairing 45 s + progress 5 s (`mcp-server.ts`), the `connected`
  set (`agent-panel-port.ts`), the stale "60 s" comment (`mcp-server.ts`).

## Phase 2 — Foundational: contracts (blocks US1–US2)

- [X] T283 RED: `tests/contract/` case — `agentLinkFrameSchema` accepts a `prompt-waiting` frame
  with and without `callId`, rejects an unknown `kind`; the `timed-out` outcome accepts an optional
  `hint`; `ATTENTION_SENTENCES` has `pairing` and `consent`, each two lines (English, zh-TW),
  containing "Alt+A" and no `{` placeholder.
- [X] T284 GREEN: `packages/contracts/src/agent-tools.ts` — add the frame to the link frame union,
  `hint?: string` (≤ 400 chars) to the two `timed-out` shapes, export `ATTENTION_SENTENCES` and a
  `PromptWaitingFrame` type; `AGENT_LINK_PROTOCOL` unchanged (record why in a comment: optional
  frame, unknown types are dropped).

## Phase 3 — US1 + US2 host half: keep the call alive and tell the agent (P1) — FR-146, FR-148, FR-150

- [X] T285 [US1] RED: `packages/agent-host` unit — router: a held call whose backstop would fire at
  30 s survives a `prompt-waiting {waitedMs: 5000, boundMs: 120000}` and fires at
  `boundMs - waitedMs + 10 s` from the frame; a frame for an unknown `callId` changes nothing; the
  cap at 130 s from the call's start holds whatever the frames say.
- [X] T286 [US1] GREEN: `packages/agent-host/src/router.ts` — `noteWaiting(frame)` re-arms the
  call's timer per contract; expose it to the server.
- [X] T287 [US1] RED: server unit — on a `prompt-waiting` for a held call the server emits
  `notifications/progress {progress: waitedMs, total: boundMs, message}` with the attention
  sentence when `panelConnected` is false and the neutral text when true; for `kind: "pairing"`
  with `panelConnected: false` the pairing bound becomes `max(45 s, boundMs)`; a `timed-out`
  answer that carries `hint` reaches the MCP text result as `{reason, hint}`.
- [X] T288 [US1] GREEN: `packages/agent-host/src/mcp-server.ts` — route `prompt-waiting` frames
  (they arrive on the session's socket like answers) to `router.noteWaiting` and to the progress
  emitter; pairing bound adoption in `awaitPairing`; replace the "MCP client's own 60 s request
  bound" comment with R-161's facts (28 h wall clock, 30 min stdio idle) and the reason the
  progress stays (message carrier); the pairing `timed-out` reason gains the `hint` when the last
  frame said the panel was closed.
- [X] T289 [US1] `packages/agent-host/src/relay-mux.ts` — confirm the new frame is forwarded
  unchanged by the existing "read two fields, rewrite none" path; add one unit case if the mux has
  a type allow-list.

## Phase 4 — US1 + US2 worker half: bound at raise, the ticks, the badge (P1) — FR-146..149, FR-151, FR-152

- [X] T290 [US2] RED: worker unit — `agent-tools/prompts.ts`: a prompt raised with
  `panelConnected: false` arms a 120 s timer, with `true` 25 s; while pending, `onWaiting` fires
  every 5 s with `{kind, waitedMs, boundMs, panelConnected}`; a panel connecting mid-wait does not
  re-arm; `pairing-controller.ts`: the same for a pending pairing (`boundMs` 120 s / 45 s, ticks).
- [X] T291 [US2] GREEN: prompts and pairing controllers take `panelPresence: () => boolean` and
  `onWaiting`; `agent-panel-port.ts` exposes `isConnected()` and `onPresenceChange(listener)`.
- [X] T292 [US2] RED: attention derivation unit — table: {pairing pending, prompt pending} ×
  {panel connected} → badge on/off; transitions on prompt end, pairing end, panel connect,
  disconnect, wake.
- [X] T293 [US2] GREEN: `apps/extension/src/chrome-adapters/action-badge.ts` (set / clear with the
  contract's text, colour, title) and `apps/extension/src/service-worker/agent-runtime.ts`:
  `deriveAttention()` called on every input change and once on wake; `prompt-waiting` frames sent
  through the bridge on each tick; ~~`setPanelBehavior({openPanelOnActionClick: true})` once at~~ (withdrawn at review L1) at
  start (`chrome-adapters/side-panel.ts`); the `timed-out` answers built by
  `effects/batch/dialogs/diagnostics` carry `hint` when the prompt was raised with the panel closed
  (one helper in `prompts.ts` returns the hint or `undefined`).
- [X] T294 [US2] `agent-bridge.ts`: send the new frame type (it is a link frame, not a control
  frame); unit case that the frame reaches `send` unchanged.
- [X] T295 Run `npm run typecheck`, `npm run test -- --maxWorkers=4`, `npm run test:contract`;
  `npm run build`; record numbers.

## Phase 5 — Review gate

- [X] T296 `code-reviewer` on S1+S2 (claim: a question raised with the panel closed is held for
  120 s across worker → relay → server without the host backstop, the client, or a recycled worker
  ending it early, and the badge never stays on after the question ends). Fix findings; two attempts.

## Phase 6 — US3 + proof + documents (P3) — FR-153, FR-155; SC-078..084

- [X] T297 [US3] Gate spec `tests/e2e/packaged/agent-first-run.spec.ts` per `quickstart.md` §2:
  closed-panel pairing (progress sentence within 5 s, badge `!` via worker evaluate, open the panel
  page → pairing card first, accept → call completes), closed-panel consent on an `ask` site (same
  four checks), expiry path with the closed-panel bound shortened by an env read at worker start
  for tests only (document the env in the spec file), badge cleared; pointer baseline: three clicks,
  pointer element present before each press (add to the same file or `agent-pointer.spec.ts`).
- [X] T298 Run the gate unattended (memory `unattended-attach-gate` recipe); record pass counts.
- [X] T299 **Owner go-ahead required**: one `claude -p --model sonnet` probe with the panel closed
  on the owner's Chrome (SC-078, SC-079); paste the agent's reply and timestamps into
  `coverage.md`.
- [X] T300 [P] Documents (FR-155): `docs/design-notes.md` (pointer paragraph; first-use note),
  README "First use" one line, the comparison page artifact rows (pointer ✓ 004; new row for the
  closed-panel case); `coverage.md`; memory `feature-011-progress`.
- [X] T301 Final verification (the one planned): `npm run test`, `npm run test:contract`,
  `npm run snapshot:check` green; commit on `feature-011-first-run-visibility`.

## Not scheduled

- FR-154 pointer upgrade (curved path + spring) — S4 only if D-011-5 = upgrade.

## Dependencies

T282 → T283/T284 → host (T285–T289) → worker (T290–T294) → T295 → T296 → T297/T298 → T299 →
T300 → T301. T300's document edits can start after T296.

## Implementation strategy

MVP = contracts + host + worker (through T295): the person is told and the call waits. The badge is
in the same worker brief because it shares the derivation inputs. Gate and probe close the claims.

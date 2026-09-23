# Contract: interrupt a step, keep the session (feature 014, S1)

Lives in `packages/contracts/src/agent-tools.ts` (reason, panel message, state field) and
`apps/extension/src/service-worker/{agent-tools/stop.ts, agent-runtime.ts}`; this file is the
readable statement the tests pin. Link protocol number unchanged; no host change.

## Panel → worker

```
ui.agent.session-interrupt { sessionId }
```

Effect: every call of that session in flight at that instant is ended (FR-179); the session,
its tabs, group marking, leases, debugger attachment, viewport emulation, recording, retained
screenshots, dialog state, window-restore record and site decisions are untouched. With nothing
in flight: no change; the panel shows a transient notice (FR-178). One activity line
`interrupt`.

## Worker → host (response frame, existing shape)

```
{ callId, outcome: "stopped", reason: "owner-interrupted",
  hint: "The owner interrupted this step. Nothing refused it; the session and its tabs are still held. Re-run it if still needed." }
```

or, when the call's operation marker shows the input had already been delivered:

```
  hint: "The owner interrupted this step after its input was delivered; it may have taken effect and was not verified. Read the page before re-running it." }
```

Answered by the worker within 1 s of the panel action (SC-100). A batch keeps the batch
convention (its own outcome is `ok` whenever it ran at all; each step's outcome is in the
results): the interrupted step carries `stopped / owner-interrupted` and the hint, the steps
not run carry `stopped / not-run`, and the result also lists `completed`, `interruptedAt`,
`notRun`; the stated plan is cleared. (S1 ruling 2026-09-22: the host reports a non-`ok`
call as outcome + reason alone, so a top-level `stopped` would lose the lists.) A call waiting on any card answers the same way, the card is withdrawn, no
decision is stored.

## Late results

A runner that completes after its call was answered: result discarded, `end()` still called,
diagnostic `agent.call.late-result { callId }` logged; never a second response frame.

## Panel state

`sessions[].inFlight: number` — the count of that session's calls the stop registry holds;
the 中斷 control is enabled iff `> 0`.

## Unchanged

`ui.agent.session-stop` and `stopSessionFromOwner` behave exactly as in 0.5.0 (FR-184): a stop
flags the session's calls and releases the session, and the host fails what it is holding as those
calls answer `stopped / owner-stopped`. (The host also acts on a `stop` control frame, but no
worker sends one — corrected S2 review, 2026-09-22.) An interrupt changes none of this.

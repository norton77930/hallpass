# Data Model: Stop the Agent from the Page

## Hold (worker, R-513)

| Field | Type | Rule |
|---|---|---|
| `sessionId` | string (key) | an outside session's id; never a panel session's (R-520) |
| `at` | ISO time | when the accepted Stop press was handled |
| `tabId` | integer | the tab the press came from (`sender.tab.id`); informational |
| `sessionKnown` | boolean | whether this worker had the session registered when the press was handled (review round 4); a record without it reads as `false` |

- Kept in a memory mirror and in `chrome.storage.session` under one key holding a map of holds.
- Created by an accepted Stop press (R-515); a second press on any tab of the same session keeps the
  first record.
- Deleted by an accepted Resume (page or panel), by `releaseSession` on every end path, by unpair, and
  for a hold with `sessionKnown: false` only, when the session's first greeting after the press carries
  a side-panel token (R-514). A plain first greeting sets `sessionKnown: true` instead. A first greeting
  that arrives before the holds are loaded is remembered and settles the hold when the load lands, so
  the decision always reads the stored record. Nothing else deletes it; there is no timeout.
- A record whose `sessionKnown` is present but not a boolean reads as no hold, like a malformed `at`.
- Loaded into the mirror at worker start; `handleToolCall`, the greeting and the upload-directory question
  wait for that load (R-513). A failed load is tried again by the next of them before it decides; while
  storage keeps failing, the call proceeds as not held with a diagnostic.

### Session states as the owner sees them

```text
           Stop (page, owner press)                 Resume (page or panel)
 working ───────────────────────────────▶ held ─────────────────────────────▶ working
    │                                       │
    │ End session / disconnect / unpair     │ End session / disconnect / unpair
    ▼                                       ▼
  ended  ◀──────────────────────────────────┘   (hold deleted with the session)
```

A panel session never enters `held`: Stop forwards the conversation's own Stop (R-520).

## Pill state (indicator message, R-518)

| Field | Present when | Meaning |
|---|---|---|
| `mode` | always with `show: true` | `working` (Stop shown), `held` (held label + Resume), `conversation` (Stop, never Resume) |
| `label` | as today | "An agent is working in this tab" (working, conversation) |
| `heldLabel` | `mode` = `held` | "Stopped" |
| `action` | as today | "back to the agent's tab" |
| `stop` | `mode` ≠ `held` | Stop control text |
| `resume` | `mode` = `held` | Resume control text |
| `stopUndelivered` | `mode` ≠ `held` | shown if a Stop press gets no reply in about 2 s |
| `resumeUndelivered` | `mode` = `held` | shown if a Resume press gets no reply in about 2 s |

All words are the worker's, in the owner's locale (FR-523), and drawn as text.

## Session view additions (panel, R-521)

| Field | Type | Rule |
|---|---|---|
| `heldAt` | ISO time, optional | set while the session is held; absent otherwise |

## Activity additions (panel, R-521)

| kind | outcome | When |
|---|---|---|
| `hold` | `held` | an accepted Stop press held the session |
| `resume` | `resumed` | the hold was lifted (page or panel) |

## Stop reason (agent-facing, R-516)

| Reason | Means | Hint |
|---|---|---|
| `owner-stopped` | the session ended (unchanged) | unchanged |
| `owner-interrupted` | this step ended; the next call may run (unchanged) | unchanged |
| `owner-held` | the owner stopped the session from a page; every call is refused until the owner resumes | `HELD_HINT` (FR-523) |

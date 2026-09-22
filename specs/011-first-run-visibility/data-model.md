# Data Model: First-Run Visibility

## Pending question (existing, extended)

| Field | Type | Notes |
| --- | --- | --- |
| kind | `pairing` \| `ask` \| `plan` \| `dialog` \| `diagnostics` | pairing lives in the pairing controller, the rest in the prompt controller |
| sessionId | string | whose question |
| callId | string? | absent for pairing (the server owns that call) |
| raisedAt | ms | |
| boundMs | 25 000 \| 45 000 \| 120 000 | **fixed at raise** from panel presence (R-163); never changes while the question lives |
| panelConnectedAtRaise | boolean | what chose the bound; repeated in every `prompt-waiting` frame |

Transitions: raised → answered / timed-out / stopped / released (unchanged); a `prompt-waiting`
tick every 5 s while raised, only when `panelConnectedAtRaise` is false; for a batch step the tick
names the batch call id.

## Panel presence (existing set, exposed)

`connected: Set<PanelPort>`; `isConnected() = size > 0`; `onPresenceChange(listener)` fires on
connect and disconnect.

## Attention state (new, derived — never stored)

```
attention = (pairing pending || prompt pending) && !panelPresence.isConnected()
```

Recomputed on: prompt raised / ended, pairing raised / ended, panel connect / disconnect, worker
wake. Effect: `attention ? badge("!", red, title) : badge cleared`.

## `prompt-waiting` frame (new, worker → host)

| Field | Type | Notes |
| --- | --- | --- |
| type | `"prompt-waiting"` | |
| sessionId | string | routed by the relay |
| callId | string? | the held call; absent for pairing |
| kind | see above | picks the sentence |
| panelConnected | boolean | picks attention vs neutral message |
| waitedMs | number | since raise |
| boundMs | number | the fixed bound |

Host effects: router re-arms the call's backstop to `boundMs - waitedMs + 10 000`, capped at
130 000 from the call's start; server emits `notifications/progress { progress: waitedMs, total:
boundMs, message }`; for pairing, `awaitPairing`'s bound becomes `max(own, boundMs)`.

## `timed-out` outcome (existing, extended)

`{ outcome: "timed-out", reason: "no-answer" | "not-paired: no answer", hint?: string }` — `hint`
present when the question was raised with the panel closed; it is the same sentence as the
progress message.

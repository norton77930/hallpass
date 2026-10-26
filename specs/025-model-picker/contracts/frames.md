# Contract changes: Side-Panel Model Picker (025)

Host and extension 0.17.0 together (D-025-8). Link protocol stays 2: no new frame type. Every change is a
new optional field, a new command, a new event kind or new codes; the extension's strict schemas refuse a
newer host's new fields, and the version pairing (`tool-offering.ts`) is a build-time pin (contract tests), not a runtime refusal: a mismatched pair drops the newer frames, so both ship as 0.17.0.

## Panel → worker → broker

### `ui.conversation.start` (extended)

```ts
payload: { agent, folder, mode?, model?: { model?: string, effort?: string } }   // refine: at least one present
```

`model` is the chip's choice (values from the offer), sent only when the owner picked something. Absent: the
broker uses the store's last choice, else the agent's own model. An effort alone is sent when the owner
picked only an effort and no model is known (no default in the offer, nothing remembered); the broker sends
only that effort, when it differs, before the first prompt, and records the store's choice as the agent's
reported model plus that effort. The store and the index entry keep `{ model: string, effort?: string }`.

### `ui.conversation.set-model` (new)

```ts
payload: { conversationId, model?: string, effort?: string }   // refine: at least one present
```

Results: `ok` once the agent accepted (the `model` event follows); errors:

| code | when |
|---|---|
| `busy` | a turn runs, a card waits, a mode reload is in flight, or four changes already wait behind a switch in flight (FR-403) |
| `agent-exited` | not running (the target is updated in the entry; applied when it continues), or the agent ended while the change waited behind a switch - see note |
| `model-unknown` (new) | the value is not in the conversation's live offer |
| `model-refused` (new) | the agent answered with an error; `detail` = its scrubbed text (FR-405). Also when it did not answer within the bound (below); `detail` = the timeout notice's text |

Every `session/set_config_option` and `session/set_model` the broker sends - for a `set-model` and at a
session opening (start, resume, mode reload, restart) - is bounded at `MODEL_SET_BOUND_MS` = 30 s (0.17.0,
owner 2026-10-26; under `HALLPASS_TEST_MODE=1`, `HALLPASS_BROKER_TEST_MODEL_SET_MS` shortens it, 1 s -
10 min). Past the bound the change is `model-refused` with the timeout notice, which names what the
agent reports as current when it is said: the conversation keeps that, entry and store are untouched,
the switch is released (the next queued change goes, messages are taken again) and an opening goes on
to its first prompt. At an opening the agent did not say no, so the entry keeps the choice it was asked
for (the entry's own, or a start's target) and the next opening asks again; the store's choice stays.
An exit before the bound still answers `agent-exited`. The late answer resolves nothing - no second
result, notice or `model` event. A late success means the agent did switch: it is followed as the
agent's own `config_option_update` is (R-406) - the session options it carries, or, without them
(`session/set_model` answers `{}`), the asked value - so the view and entry take it and the store's
choice stays. Only on the same run, and only when it is newer than the last word followed for that part:
each set request gets a per-part serial; an answer in time or late that is followed records its
serial, and the agent's own `config_option_update` or a session opening's answer counts as the newest
sent. So two changes that both time out on an agent that answers in order end on the second, and a
late answer never overwrites a newer change answered in time. Otherwise, and for a late error, it is
dropped.

A `set-model` that arrives while another of the same conversation is in flight (the popup sends a model
and then an effort back to back) is not refused: it waits behind it, up to four, and they go one at a
time in the order received. Each is judged when its turn comes, against what the agent then reports: a
part already current sends nothing, and a value no longer offered answers `model-unknown` (D-025-12).
Each has its own result and, when accepted, its own `model` event. If the agent ends meanwhile, every
waiting change answers `agent-exited` and none is sent; the one in flight answers as the exit finds it.
While a change is in flight or waiting, a message, a mode change, a restart, eviction and the idle stop
are refused or held as before.

Note: a stopped conversation's chip is not offered (the view has no live `models`), so `agent-exited` is a
race answer only.

## Broker → worker → panel

### Overview: `agents[].models` (new, optional)

```ts
models?: { offer: ModelOffer, choice?: ModelChoice }
```

### Views: `conversations[].models` / `.model` (new, optional)

```ts
models?: ModelOffer & { current: { model: string, effort?: string } }   // running, reported
model?: { model: string, effort?: string }                              // from the index entry
```

### Event `model` (new)

```ts
{ type: "model", model: string /* name */, effort?: string /* name */, effortChanged?: true }
```

One per accepted owner change (FR-404); `effortChanged` when a model change moved the effort (D-025-12).
Never at a start or re-apply (FR-401).

### Notices (new codes)

| code | text (broker, redacted) |
|---|---|
| `model-refused` | "<agent> kept <kept model>: it refused <asked model> (<agent's text>)." |
| `model-refused` (no answer within the bound) | "<agent> did not answer within <n> s, so the model is unchanged: it keeps <kept> and did not switch to <asked>." (<n> = the bound in whole seconds, 30) |
| `model-unavailable` | "<agent> no longer offers <remembered model>; the conversation uses <default> instead." |

Panel says both in the owner's language from fields it already has (names on the event's text are the
agent's own); the broker's text is the fallback, as for every notice.

### Error codes (new)

`model-unknown`, `model-refused` appended to `CONVERSATION_ERROR_CODES`.

## Host files

- New `<data>\agent-models.json` (data-model.md). Version 1.
- `conversations.json` entries gain optional `model` (version stays 1).

## Agent side (ACP, R-398/R-399)

| Request | When |
|---|---|
| `session/set_config_option { sessionId, configId, value }` | `source = "config"`, model then effort |
| `session/set_model { sessionId, modelId }` | `source = "models"` (Hermes) |

Nothing else is sent for the picker: no prompt, no slash command, no write to the agent's configuration.

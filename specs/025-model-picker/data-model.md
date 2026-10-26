# Data Model: Side-Panel Model Picker (025)

All shapes are closed (`strictObject`) in `packages/contracts/src/conversation.ts`. Bounds from R-400.

## ModelEntry

| Field | Type | Rule |
|---|---|---|
| `value` | string 1-512 | the agent's own value, opaque (R-398) |
| `name` | string 1-120 | the agent's name, clipped |
| `description` | string 1-300, optional | the agent's description, or the group's name (DeepSeek) |

## ModelOffer (`conversationModelOfferSchema`)

| Field | Type | Rule |
|---|---|---|
| `source` | `"config"` \| `"models"` | R-399 |
| `configIds` | `{ model: string, effort?: string }`, optional | present iff `source = "config"`; the option ids to set |
| `models` | ModelEntry[] 0-64 | empty = the agent reports none (no chip) |
| `efforts` | ModelEntry[] 0-16 | empty for `models` and for agents without `thought_level` |
| `defaultModel` | string, optional | an entry's `value` (`"default"` when listed) |
| `defaultEffort` | string, optional | same, for efforts |

Refine: `defaultModel` is one of `models[].value`, `defaultEffort` one of `efforts[].value`; `efforts`
empty when `source = "models"`.

## ModelChoice (`conversationModelChoiceSchema`)

`{ model: string 1-512, effort?: string 1-512 }` - values, not names. Used by the start command, the
store, the index entry and a stopped conversation's view.

## ConversationModelState (live, on the view)

`ModelOffer & { current: { model: string, effort?: string } }` - what the running agent last reported
(R-406).

## Host file `<data>\agent-models.json` (`agentModelsFileSchema`)

```
{ version: 1,
  agents: { [agent in CONVERSATION_AGENTS]?: { offer: ModelOffer, seenAt: iso, choice?: ModelChoice } } }
```

- Written by `model-store.ts` only, re-read before each write, temp + rename (R-401).
- `offer` replaced at each `session/new` of that agent; `choice` at a start with a choice and at each
  accepted change.
- Unreadable: kept aside as `agent-models.json.bad-<time>`, start empty, broker log line.

## Conversation index entry (019 data-model, extended)

| Field | Type | Rule |
|---|---|---|
| `model` | ModelChoice, optional | what the agent reported after the start / last change / last re-apply / its own change (R-404, R-406) |

## Availability entry (overview, extended)

| Field | Type | Rule |
|---|---|---|
| `models` | `{ offer: ModelOffer, choice?: ModelChoice }`, optional | from the store; absent = never seen (chip says "Default") |

## View (extended)

| Field | Type | Rule |
|---|---|---|
| `models` | ConversationModelState, optional | while the agent runs and has reported |
| `model` | ModelChoice, optional | from the index entry when not running |

## Conversation runtime state (broker, memory)

- `modelState: ConversationModelState | undefined` - replaced by each report.
- `modelTarget: ModelChoice | undefined` - what the next session opening applies (R-403); set from the
  start's choice / store / entry, updated by each accepted change.
- `switching: boolean` - a `set-model` in flight or queued behind one; `canSend`, `setMode`, `canRestart`,
  eviction and the idle stop refuse or wait meanwhile.
- `switchQueue` - the `set-model`s waiting behind the one in flight, oldest first, at most 4 (a fifth is
  refused `busy`); emptied with `agent-exited` when the run ends.
- Each set request (`session/set_config_option`, `session/set_model`) is bounded at `MODEL_SET_BOUND_MS`
  = 30 s (0.17.0; `HALLPASS_BROKER_TEST_MODEL_SET_MS` in test mode). Past it the part counts as refused
  with the timeout notice (naming what is current when it is said). Its late answer resolves nothing;
  a late success is followed as a `config_option_update` - its session options, or the asked value when
  it carries none (`session/set_model`) - on the same run, when its serial is above `modelSetFollowed`
  for that part; anything else is dropped.
- `modelSetSent` / `modelSetFollowed` (per part): the serial of the newest set request sent, and of the
  newest whose word was followed - an answer in time or late; a `config_option_update` or a session
  opening's answer sets both parts to the newest sent.
- `modelOpening.outcome` gains `timed-out`: the opening's set went unanswered. The entry keeps the
  choice it was asked for (the entry's, or a start's target), with the effort the agent reported when
  that choice names none, and the store's choice stays, so the next opening asks again.

## State transitions

```
open session (new | load | resume | reload | restart)
   -> mode set + confirmed (R-316)
   -> read offer; store.offer := offer (new only)
   -> target in offer?  no  -> notice model-unavailable; target := agent's current
                        yes -> send the differing parts (model, then effort)
                               refused -> notice model-refused; keep current
                               no answer within the bound -> timeout notice model-refused; keep current;
                                                             entry.model keeps the asked choice (next opening retries)
   -> entry.model := current (except after a timeout, above); idle
idle --set-model--> switching --accepted--> event model (+effortChanged); entry.model, store.choice := current; idle
                             --refused---> notice model-refused; result model-refused; idle
                             --no answer within the bound--> timeout notice model-refused; result model-refused;
                                                            current, entry, store kept; next queued or idle
                             --agent exit (before the bound)--> crashed (019 path); this and every queued set-model -> agent-exited
late success of a timed-out set --same run, serial > modelSetFollowed[part]--> as config_option_update
                                 below (its options, else the asked value); otherwise dropped
switching --set-model--> queued (<= 4, else refused busy); when the one in flight ends, the oldest queued
          is judged against the current report (parts already current send nothing; not offered ->
          model-unknown) and becomes the switch in flight; the queue empty -> idle
running | waiting-for-owner --set-model--> refused busy
any running state --config_option_update--> modelState := reported; entry.model := current (store.choice untouched)
```

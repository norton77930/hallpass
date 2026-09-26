# Contract: Pairing withdrawal (FR-216 – FR-219)

## Frames (link protocol stays 2)

```text
pair-request  host → worker   { type, agentId, displayName, origin, sessionId, requestId? }
pair-result   worker → host   { type, agentId, ..., requestId? }            // echoes the request
pair-withdraw host → worker   { type: "pair-withdraw", agentId, sessionId, requestId? }   // NEW
pair-result.features          + "pair-withdraw"   // worker advertises it; gates requestId (FR-219)
```

`requestId` on `pair-request` is sent only after a `pair-result` whose `features` include
`pair-withdraw`; before that the request is byte-for-byte the 0.7.0 frame.

## Host

- Mints `requestId` per pairing exchange, once the worker has advertised `pair-withdraw`.
- On its pairing bound expiring: answers the agent as today (`timed-out`), marks the exchange
  withdrawn, sends `pair-withdraw`.
- On session close: sends `pair-withdraw` for an open exchange before the session `stop`.
- A `pair-result` whose `requestId` names a withdrawn exchange: logged `agent.pair.late-ignored`,
  not applied. A `pair-result` without `requestId`: handled as in 0.7.0.

## Worker

- On `pair-withdraw`: `expireWaiting(agentId, sessionId)` — that session leaves the card's waiting
  list; with none left the card is dropped and attention clears; otherwise the waiting count drops.
- Echoes the `requestId` of the waiting session it answers.
- Keeps its own mirrored bound as the fallback for an old host.

## Compatibility

- Old worker: unknown `pair-withdraw` is dropped by the bridge's decoder; the card expires on the
  worker's own bound as in 0.7.0.
- Old host: never sends `pair-withdraw` or `requestId`; worker behaviour unchanged.
- New host + old worker: host sends no requestId until the worker advertises `pair-withdraw`; a
  0.7.0 worker's strict pair-request parse therefore never sees one. `pair-withdraw` is still sent
  (without `requestId`) and dropped; a late answer is handled as in 0.7.0.

## Tests

Host with a fake link: expire sends the frame; late mismatched result ignored; result without id
accepted. Worker: withdraw of the only session drops the card within one tick; of one of two keeps
it with count 1; unknown frame on an old decoder is ignored (decoder test). Gate: SC-113.

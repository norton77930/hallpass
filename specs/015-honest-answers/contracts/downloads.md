# Contract: Every finished download, once (FR-207 – FR-209)

`wait { condition: "download-complete" }` answers, for the calling session, the terminal download
(complete, interrupted/failed, cancelled) with the smallest finish time among those not yet answered
to that session; each download id is answered at most once per session. With none pending it polls
as today until its bound.

Ring shape in `storage.session["agentDownloads"]`: `{ items, answered: number[] }`; legacy
`waitWatermark` is migrated on read (terminal items with `endedAt ≤ waitWatermark` count as
answered) and not written again.

`downloads_context` output is unchanged.

Tests: two downloads finishing out of creation order answered in finish order; no repeat; failed
and cancelled answered with their state; session isolation; migration from a watermark-only ring;
eviction of an unanswered completion (not answered, no error).

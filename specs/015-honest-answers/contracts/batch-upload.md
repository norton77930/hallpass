# Contract: Uploads inside a batch (FR-210 – FR-215) — authorization boundary

## One check

`prepareUpload(callId, tool, args)` in the host is the only place that turns an agent-shaped
`file_upload` / `upload_image` into what may cross the link. It contains, in this order, what today
is inline in the host's call placement:

1. `file_upload`: the tool's own agent-facing input shape (the descriptor's `inputShape`, parsed as
   MCP parses a standalone call: a missing field is `invalid-arguments`, a stray key is dropped);
   `resolveUploadFiles(paths, config)`; on `outside-roots` the directory question
   (`askUploadConsent(callId, …)`) with once / always / deny / timed-out / interrupted / busy /
   link-lost / unavailable exactly as today; `always` writes only rememberable directories (never a
   disk or share root) and re-resolves; any remaining refusal as today; rewrite `paths → files`.
2. `upload_image`: schema check; `screenshots.take(imageId)` with `unknown-image-id` /
   `image-no-longer-available` refusals as today; rewrite to `{ target, file }`.

Returns `{ ok: true, args }` or `{ ok: false, response }` where `response` is the standalone answer.
A standalone call returns `response` as its answer, unchanged from 0.7.0.

## Batch pre-pass

For `browser_batch`, before the call is sent:

1. For each step in order whose `tool` is `file_upload` or `upload_image`: `prepareUpload(batchCallId,
   step.tool, step.args)`, awaited before the next (one question at a time).
2. First `{ ok: false }`: the batch answers that `response` with `reason` prefixed `step <n>: `
   (1-based) and nothing is sent to the worker.
3. `upload_image` refusal for an id the host has not issued adds to its hint: "A screenshot taken
   inside this batch can be uploaded in a later call."
4. After all steps: if the total `bytesBase64` length across rewritten steps exceeds
   `AGENT_UPLOAD_MAX_BASE64_CHARS`, the batch answers `{ outcome: "denied", reason:
   "batch-upload-too-large", hint: "Split the uploads across calls." }` and nothing is sent.
5. Otherwise the batch is sent with the rewritten steps; the worker needs no change (it parses each
   step with the standalone schemas).

Interrupt (中斷) and stop (停止) during a pre-pass question answer the batch exactly as a
standalone upload question (`owner-interrupted` with "nothing delivered"), and no step has run. Like
every pre-pass refusal the reason carries the step: `step 1: owner-interrupted`.

## Invariants (reviewed)

- No path string is sent to the worker for any step.
- No file outside the allowed directories is read without the owner's once/always for its directory.
- A disk or share root is never written to the allowed list.
- An owner's `always` for a step's directory is written when they answer and stays written even
  when the batch is then refused (a later step, or `batch-upload-too-large`): it is their decision
  about a directory, not about this batch.
- There is no second resolver: a contract test fails if the batch path does not go through
  `prepareUpload`.
- The batchable-tools list keeps both tools; 013's "listed but unusable" note is closed.

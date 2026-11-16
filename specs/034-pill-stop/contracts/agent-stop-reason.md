# Contract: Stop Reason `owner-held` (agent-facing)

The one change an agent can see (FR-525, D-034-9, R-516).

## Shape

A call refused while its session is held answers, through the host's usual error reply:

```json
{
  "outcome": "stopped",
  "reason": "owner-held",
  "hint": "The owner pressed Stop on the page, so nothing was done. Stop and tell your user; the owner can resume from the page or the side panel."
}
```

- `AGENT_STOP_REASONS` = `["owner-stopped", "owner-interrupted", "owner-held"]`.
- The hint text is a constant beside the interrupt hints and is the only prose the agent receives for it.
- No tool, no input field, no other output field, and no existing reason changes. The host passes the
  worker's answer to a call through unchanged; the host and extension versions stay pinned to each other.
- One link change (review round 1, owner's choice 2026-11-15): the upload-directory question the host asks
  before a `file_upload` call (or a `browser_batch` `file_upload` step) with a path outside `uploadRoots` gains the decision
  `held` in `upload-consent-result`. The worker gives it at once for a held session, with no card; the
  host turns it into the answer above, reads no file and writes no root. For a `browser_batch` step the
  step's reason reads `step <n>: owner-held` with the same hint. An older host does not know `held` and
  refuses the frame at its closed schema, so its question goes unanswered until the host's own bound
  (about 125 s) and the call answers `upload-not-answered`; such a mix is outside the pinned pairing.

## Which calls get it

Every call of a held session that reaches the worker, whatever the tool, from the moment the hold is set
until it is lifted, including the upload-directory question asked before an upload. Calls already in
flight when Stop is pressed answer `owner-interrupted` as today (R-515).

Known limits (not refused with `owner-held`): the tools the host answers itself without the worker
(`list_browsers`, `select_browser`, `request_browser_choice`), and every refusal the host gives before
the call is sent (argument refusals, an upload path the host's policy refuses, no browser linked); a
`file_upload` whose path is inside `uploadRoots` raises no question, so the host reads the file before
the worker refuses the call; and a session that switches to another browser with `select_browser`, whose
worker holds nothing for it (a hold belongs to one browser, as a new session is not held either).

## Tests that pin it

- `tests/contract/agent-tools-014.contract.test.ts` (T350): the exact list, and that each reason parses as
  an agent native response.
- A worker unit test: a held session's call of each tool family answers exactly this shape.

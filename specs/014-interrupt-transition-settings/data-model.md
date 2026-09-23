# Data Model: Interrupt a Step, Confirm a Site Transition, Ask Before Uploading From a New Directory

## Stop flag (worker memory, `agent-tools/stop.ts`)

| Field | Type | Notes |
| --- | --- | --- |
| `callId` | string | map key; batch steps are `callId#n` |
| `sessionId` | string | scope of `stopSession` / `interruptSession` |
| `stopped` | boolean | set once; never cleared |
| `reason` | `"owner-stopped" \| "owner-interrupted"` | present when `stopped`; what the runner answers |

**Lifecycle**: `begin` on dispatch → `stopSession` / `interruptSession` / `stop(callId)` flags →
`end` on the runner's completion (late completions after an interrupt still `end`, after their
result was discarded and logged).

## Interrupt answer (response frame, unchanged shape)

`{ callId, outcome: "stopped", reason: "owner-interrupted", hint }` where `hint` is one of two
fixed sentences: *nothing was done* (no operation marker for the call) or *may have taken effect,
not verified* (marker present). A batch's `result` additionally carries `completed`, `interruptedAt`
(step index) and `notRun` as today's partial-batch shape does.

## TabTransitionState (worker, `chrome.storage.session`, key `agentTransitions:<sessionId>:<tabId>`)

| Field | Type | Notes |
| --- | --- | --- |
| `known` | origin[] | every origin the session has been on for this tab; seeded on claim/create |
| `lastKnown` | origin | the origin the session last treated as current |
| `pending` | `{ from: origin, to: origin, since: epoch ms }`? | set by rule (f); `to` replaced by a later change, `from` kept |
| `expectedNavigate` | origin? | set by `navigate` before it moves, cleared when it answers (rule e) |

**Dropped** with the tab lease (release, session end) and with the browser (session storage).

**Layout (S2, 2026-09-22)**: one key per storage area holding a map rather than a key per record -
`agentTransitions` holds `{ "<sessionId>:<tabId>": TabTransitionState }` and
`agentTransitionsAllowed` holds `{ "<sessionId>": string[] }`, both in `chrome.storage.session`.
It is the shape `window-restore.ts` and `site-mode-store.ts` already use here, and it is what lets
a tab's state be dropped by tab id alone: the lease that ends names the tab and not the session.
The persisted `agentTransitionAllowances` key in `chrome.storage.local` is exactly as specified
below, because the panel and the gate read it.

## SessionTransitionAllowances (worker memory + `chrome.storage.session`, key `agentTransitionsAllowed:<sessionId>`)

`string[]` of `"<from>→<to>"`; grown by 繼續 and by 一律允許; dropped with the session.

## TransitionAllowance (persisted, `chrome.storage.local["agentTransitionAllowances"]`)

| Field | Type | Notes |
| --- | --- | --- |
| `from` | origin | ordered pair; `B→A` is a different record |
| `to` | origin | |
| `allowedAt` | ISO string | when 一律允許 was pressed |
| `lastUsedAt` | ISO string | touched by rule (d) each time it exempts a transition |

Validation: both are origins as `siteOfUrl` produces them (`scheme://host[:port]`), never a URL
with a path. Removed by `ui.agent.transition-clear {from, to}`.

## Transition rules (in order; the first that matches decides)

| # | Condition | Effect |
| --- | --- | --- |
| a | `to` is loopback (`localhost`, `127.0.0.0/8`, `[::1]`) and the test switch is unset | add to `known`, set `lastKnown`, no pending |
| b | `to` ∈ `known` | as (a), and clear any `pending` |
| c | `siteModes.get(to).mode !== "ask"` | as (a) |
| d | `"from→to"` allowed for the session, or persisted | as (a); touch `lastUsedAt` when persisted |
| e | `expectedNavigate === to` | as (a) |
| f | otherwise | `pending = { from: lastKnown, to, since }` (or replace `to` if already pending) |

`from` for (d) and (f) is `lastKnown`, i.e. the origin before this chain of changes (FR-189).

Only an `http(s)` origin is an arrival at all (S2 review F8, 2026-09-22): `chrome://` and
`chrome-extension://` pages have real origins in the browser and are not sites, so a tab landing
on one records nothing — no pending, and no change to `known` or `lastKnown`.

## AgentEffectPrompt (contracts; additive fields)

| Field | Type | Set by | Rendered as |
| --- | --- | --- | --- |
| `kind` | + `"transition"`, `"upload-directory"` | runtime | card body per kind |
| `transition` | `{ from, to }`? | runtime | 繼續 / 一律允許 / 拒絕 |
| `files` | `{ path, directory }[]`? | runtime from the host's request | 這些檔案這次 / 這些資料夾以後都可以 / 不准 |
| `delivery` | `"input" \| "drop"`? | `upload.ts` from the arguments | the upload_image sentence |

`PromptDecision` gains `{ decision: "interrupted" }`. `ui.agent.effect-decide` gains
`rememberTransition?: boolean` (transition cards) and `rememberDirectory?: boolean` (directory
cards); `allow: false` is decline for both.

## Upload consent (host ↔ worker control frames)

| Frame | Direction | Fields |
| --- | --- | --- |
| `upload-consent-request` | host → worker | `sessionId`, `callId`, `files: { path, directory }[]` |
| `upload-consent-result` | worker → host | `callId`, `decision: "once" \| "always" \| "deny" \| "timed-out" \| "interrupted" \| "busy"`, `hint?` (the closed-panel sentence on a `timed-out`; S3 review F1, F3) |
| `pair-result.features` | worker → host | `string[]`?; `"upload-consent"` advertises the card |

Host-side pending consent: `{ callId, files, timer }`; at most one per call; resolved by the
result frame, by the bound (120 s + 5 s), or by the link dropping (→ `bridge-lost`, S3 review).
The call's progress token is registered *before* the question, so 011's prompt-waiting ticks about
this card reach the agent (S3 review F1); a session ending under a standing card answers
`interrupted` rather than "nobody answered".

## Upload roots (host `config.json`, unchanged file shape; `upload-config-store.ts`)

`{ uploadRoots: string[] }` — absolute paths; on write: read the current file, merge (add or
remove), de-duplicate by realpath, validate each root is an existing directory, write to
`config.json.<pid>.<n>.tmp` (one temp file per write, S3 review F5), rename over `config.json`.
Malformed content on read → `[]` (as today), reported to the worker as `malformed: true` on
`upload-roots`; before the first write over it the document is renamed to `config.json.invalid`
(one copy, the newest) and reported as `preserved` (S3 review F4). A root directory
(`isRootDirectory`: a drive root, a UNC share root) is never added - the files there are uploaded
once instead, with `UPLOAD_HINTS.rootNotRemembered` on the answer (S3 review F7).

| Frame | Direction | Fields |
| --- | --- | --- |
| `upload-roots-list` | worker → relay | — |
| `upload-roots-remove` | worker → relay | `root` |
| `upload-roots` | relay → worker | `roots: string[]`, `malformed?: boolean`, `path: string`, `preserved?: string` (the kept copy's name; S3 review F4) |

## AgentPanelState (contracts; additive fields)

| Field | Type | Notes |
| --- | --- | --- |
| `sessions[].inFlight` | number | enables 中斷 |
| `transitions` | `TransitionAllowance[]` | persisted pairs, for the rows |
| `uploadRoots` | `{ roots: string[], path: string, malformed?: boolean, preserved?: string, notRecorded?: string[] }`? | absent when the relay is old or not yet answered; `notRecorded` is an "always" the host did not keep (S3 review F2) |

New panel messages: `ui.agent.session-interrupt { sessionId }`, `ui.agent.transition-clear
{ from, to }`, `ui.agent.upload-root-clear { root }`.

## Activity line

`{ kind: "upload", outcome: "delivered", site, message: "input" | "drop" }` for both upload tools;
`{ kind: "interrupt" }` once per interrupt.

## Reasons (agent-facing, contracts)

`owner-interrupted` (stopped) · `site-transition-declined` (denied) · `site-transition` (batch
stopped before a step) · `upload-declined` · `upload-not-answered` ·
`upload-outside-allowed-directories` (denied; replaces `upload-not-allowed` for that one code) ·
`upload-directory-not-recorded` (denied; the owner said yes and the write failed - `hint` carries
the store's refusal; S3 review F2) · `prompt-pending` (busy; the owner was already being asked;
S3 review F3) ·
`not-answered` unchanged for cards that time out.

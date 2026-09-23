# Research: Interrupt a Step, Confirm a Site Transition, Ask Before Uploading From a New Directory

Numbering continues from 013 (R-184). Every question is answered by reading the code paths on
2026-09-22 in this worktree (44f03c1) and the private evidence file for 014; two items need a
measurement during implementation and say so (R-186 the loopback test switch, R-187 the frame
schema strictness).

## R-185 — Interrupt = a race in the dispatcher, answered by the worker, no new frame (decided)

**Facts read**:

- `agent-tools/stop.ts` 66–93: `begin(callId, sessionId)` hands every runner an
  `AgentStopHandle { stopped(), end() }`; `stop(callId?)` flags one call and its batch steps
  (`callId#n`), `stopSession(sessionId)` flags one session's live calls. Runners poll
  `handle.stopped()` at their checkpoints and answer `{outcome:"stopped", reason:"owner-stopped"}`
  (`wait.ts`, `batch.ts:120`, `effects.ts:1848`, `diagnostics.ts:451`, `tabs.ts:330`,
  `upload.ts:128`, `dialogs.ts:387`).
- `stopSessionFromOwner` (`agent-runtime.ts:1626-1644`) = `stops.stopSession` + `releaseSession`.
  The host has a `stop` control frame that would fail everything it holds at once
  (`mcp-server.ts:651-654` → `router.failAll("stopped","owner-stopped")`), but the worker never
  sends one: the host fails each call as the worker's own runners answer it `stopped /
  owner-stopped` (corrected S2 review, 2026-09-22).
- The bridge answers a call once: `agent-bridge.ts:245-256` awaits `deps.callTool` and sends one
  response frame. The host composes the agent-facing text as JSON `{outcome, reason, refusal?,
  hint?}` (`mcp-server.ts:807-828`); `hint` is the only free-text field the agent reads.
- The operation marker (001, kept) is written **before** an effect's input is dispatched, so
  "was the input already delivered when the interrupt arrived" is a fact the runtime can read.
- Prompts: `prompts.cancelSession(sessionId, "stopped")` resolves a waiting `ask()` with
  `{decision:"stopped"}`; the runners map that to the stopped outcome.

**Decision**:

1. `stop.ts` gains a reason on the flag: `interruptSession(sessionId)` marks every live call of
   the session `{stopped:true, reason:"owner-interrupted"}`; `handle.reason()` returns it; the
   existing `stopSession` keeps `"owner-stopped"`. Runners that already check `stopped()` answer
   with `handle.reason()` instead of the literal.
2. The runtime's call dispatcher (where `begin()` is called for a call) races the runner against
   the handle's interruption promise. On interrupt it answers **immediately** — within the
   1-second bound — with `outcome:"stopped"`, `reason:"owner-interrupted"` and a `hint` that says:
   *"The owner interrupted this step. Nothing refused it; the session and its tabs are still
   held. Re-run it if still needed."* When the operation marker for that call is present (input
   delivered), the hint instead says the effect *may have taken effect and was not verified*
   (FR-181). **S1 note (2026-09-22)**: the 001 operation marker does not exist on the agent
   path; the only pre-delivery write is the runners' `onDelivered`, so the dispatcher keeps an
   `inputDelivered` set fed from it, and S1 added that write to the keyboard family, which had
   none. The runner's own later completion is awaited in the background, its result
   discarded, and `agent.call.late-result` logged with the call id (FR-182). Batches: the batch
   runner already answers per step; on interrupt it reports completed steps, the interrupted
   step, the rest not run, and clears its stated plan (`plans.clear`).
3. Pending prompts of the session are cancelled with a new reason `"interrupted"`
   (`PromptDecision` gains `{decision:"interrupted"}`); the card is withdrawn; runners map it to
   the interrupted outcome, not to declined; no site decision is stored.
4. **No host change is required for correctness**: the worker answers every in-flight call
   itself and the host's router settles them. The worker does **not** send the `stop` control
   frame (that would make an old or new host fail with `owner-stopped`). One host change for
   parity of vocabulary: none needed — the JSON the agent reads is composed from the worker's
   response fields.
5. Panel: `ui.agent.session-interrupt {sessionId}` → `runtime.interruptSession`; the session
   card shows 中斷 enabled only while the projection reports ≥ 1 call in flight (the projection
   gains `inFlight: number` per session, already derivable from the stop registry); with nothing
   in flight the panel shows a transient notice (FR-178). One activity line `interrupt`.
6. Everything the session holds is untouched by construction: `interruptSession` never calls
   `releaseSession`, `attachments.release`, `tabs.endSession` or the recording exporter.

**Alternatives considered**: (a) a `stop` frame with a `reason` field — rejected: it needs a
host change to carry a new vocabulary and gains nothing the worker's own answer does not;
(b) a per-call interrupt from the panel — rejected for now: the card shows a session, not a call
list, and a session has at most one in-flight call in practice (batch steps are one call).

## R-186 — Site transitions: `tabs.onUpdated`, per-tab state in session storage, asked by the dispatcher (decided; one test switch to measure)

**Facts read**:

- The agent manifest has no `webNavigation` permission (`build-config.ts:42-58`); adding one
  would break FR-195. `chrome.tabs.onUpdated` is already the product's navigation signal:
  `chrome-adapters/tabs.ts:134-146` `watchTabUpdates()`, used by `diagnostics.ts:536` to drop a
  diagnostics grant the moment a tab leaves its site (FR-071), and by `watchTabSettle`
  (`tabs.ts:169-208`) to detect a navigation's end. `onUpdated` is top-level by nature (a tab
  has one URL) and fires with `changeInfo.url` on every URL change including redirects and the
  person's own navigation.
- Site identity: `site-mode-store.ts:51-61` `siteOfUrl` = origin. The lease record
  (`agent-tab-manager.ts:45`) holds no URL; the projection reads `tab.url` live.
- `navigate` (`tabs.ts:621-682`) knows its requested `args.url` and reports the committed
  `after.url`; it already calls `deps.onTabNavigated(tabId)`.
- The gate (`gate.ts`) decides admit/prompt/refuse per call from the tab's current site; batch
  steps re-derive the site (`batch.ts:104-138`). Reads (`read_page`, `get_page_text`, `find`,
  `screenshot`, `computer` screenshot) do not pass the gate.
- Prompts: `AGENT_PROMPT_KINDS = ["pairing","ask","plan","dialog","diagnostics"]`
  (`agent-tools.ts:2507`); `ask()` returns allow (with optional `rememberMode`) / deny /
  timed-out / stopped / released; the panel answers `ui.agent.effect-decide {promptId, allow,
  rememberMode?}`; 011's `prompt-waiting` ticks reach the host only while no panel is connected,
  and the closed-panel timeout is 120 s (`prompts.ts:34-49, 318-338`).
- `AgentEffectPrompt` (`agent-tools.ts:2888-2939`) has `kind?`, `dialogText?`, `argsSummary`,
  target fields; the panel renders its own sentence per kind (`PromptCard.tsx:150-168`).

**Decision**:

1. New worker module `agent-tools/transitions.ts` (pure rules + a small store) with, per held
   tab: `known: origin[]` (every origin the session has been on for that tab, seeded when the
   tab is claimed or created), `pending?: { from, to, since }`, and per session an
   `allowedPairs: Set<"from→to">`. State lives in `chrome.storage.session` keyed by session and
   tab so a recycled worker keeps it; it is dropped with the tab lease and with the session.
2. Feed: the runtime subscribes once to `watchTabUpdates`; for a held tab whose `changeInfo.url`
   yields an origin `to` ≠ the tab's last-known origin, apply the rules in order: (a) `to` is
   loopback (`localhost`, `127.0.0.0/8`, `[::1]`) → record known, no pending; (b) `to` is in
   `known` → clear pending, set last-known; (c) `siteModes.get(to).mode !== "ask"` → known, no
   pending; (d) the pair is allowed for the session or persistently → known, no pending, touch
   `lastUsedAt` on the persisted pair; (e) a `navigate` call for this tab is in flight whose
   requested origin is `to` → known, no pending (the runner registers its expectation before it
   navigates and clears it after); (f) otherwise `pending = { from: lastKnown, to }`; a later
   change before the next call replaces `to` and keeps `from` (FR-189).
3. Ask: the dispatcher, before any tool that names a `tabId` (reads included; `tabs_context`,
   `tabs_create`, `tabs_claim`, `gif_recorder`, `downloads_context` and session-scoped tools are
   not tab calls), checks `pending` for that tab; if set, `prompts.ask` with a new kind
   `"transition"` and `AgentEffectPrompt.transition = { from, to }`. Allow → clear pending, add
   the pair to the session set, and when `rememberTransition` → persist to
   `chrome.storage.local["agentTransitionAllowances"]` `{ from, to, allowedAt, lastUsedAt }`.
   Deny → the call answers `{outcome:"denied", reason:"site-transition-declined"}` and the
   pending stays; a `navigate` whose requested origin ≠ `to` is admitted without asking (it
   leaves). Timed-out → `not-answered` as consent cards do. `browser_batch`: a pending transition
   on the step's tab stops the batch before that step with reason `site-transition` (no card
   mid-batch; the agent's next single call asks).
4. The causing call's answer: the response frame gains an optional top-level
   `notice: { transition: { from, to } }` that `toolReply` appends to the JSON the agent reads
   (see R-187 on strictness); the text the host adds: *"the tab moved from A to B; the next call
   on this tab will ask the owner."* The runtime attaches it when the call's tab has a pending
   transition at answer time. With an old host that strips or rejects unknown fields, the
   field is put into `hint` instead (measured in S2, see R-187).
5. Panel: `PromptCard` renders kind `transition` with both origins and three buttons 繼續 /
   一律允許 / 拒絕 (plus the card's usual 停止); `ui.agent.effect-decide` gains
   `rememberTransition?: boolean`. `AgentPanelState` gains `transitions: TransitionAllowance[]`;
   `SiteList` renders them as rows with last-used and a revoke → `ui.agent.transition-clear
   {from, to}` → store delete + `notify()`.
6. **Test switch — measured 2026-09-22 (T366, read of the harness)**: every gate fixture is
   loopback (`tests/harness/page-fixtures.ts` `HOST = "127.0.0.1"`, three TLS ports 19443/19444/
   19445, plus `https://localhost:<port>` as the OOPIF site), which rule (a) exempts. The
   packaged-extension fixture (`tests/e2e/fixtures/packaged-extension.ts`) already evaluates
   code in the service worker target over CDP — it reads `chrome.storage.session` (`:332`,
   `:362`) and clears both storages (`:397`) — so the gate can set
   `chrome.storage.local["agentTransitionsTestNoLoopbackExemption"] = true` in the worker
   before the first held-tab navigation. Rule (a) is skipped while it is set; it widens
   prompting only, never privilege; the branded-Chrome run on real sites proves rule (a) as
   shipped. Two fixture ports are two **origins** (`https://127.0.0.1:19443` vs `:19445`), which
   is the identity the rules use, so A→B is a real transition on the gate without a second
   server. The fallback (a LAN-address server) is not needed.

**Alternatives considered**: CDP `Page.frameNavigated` on the held tab's attachment — precise
but the attachment is made lazily on the first effect (`input.ts:14-16`), so a tab claimed and
only read would have no attachment and no event; `webNavigation` — a new permission (FR-195);
asking at commit time inside the causing call — the click has already happened and the call
must answer honestly; the ask belongs to the next call (spec FR-186/187).

## R-187 — Upload directory consent: host asks the worker mid-call over the existing control-frame channel (decided; strictness to measure)

**Facts read**:

- `mcp-server.ts:1006-1016`: `file_upload` args are rewritten before `placeCall` sends anything:
  `resolveUploadFiles(paths, await readUploadConfig())`; refusal → `{outcome:"denied",
  reason:"upload-not-allowed"}` (the specific code `outside-roots | too-many-files | too-large |
  not-a-file` is only logged, `upload-policy.ts:41-45, 125-178`); success → `args.files`
  (base64) replaces `args.paths`.
- Nothing host-side awaits a worker-originated mid-call message except the response frame;
  but the channel exists: control frames flow both ways (`pair-request` ← worker, `pair-result`
  → worker, `stop` → worker, `unpair` ← worker; `agent-tools.ts:2363-2447`), the relay forwards
  by `sessionId`/`callId` and drops unaddressed frames (`relay-mux.ts:230-236`). An unknown
  control type is logged and dropped on both sides (`agent-bridge.ts:369-376`,
  `mcp-server.ts:655-658`) — never answered.
- `readUploadConfig` is fail-closed; roots are `realpath`'d; `within()` is prefix containment,
  case-insensitive on Windows. The installer writes the empty template.
- 013 precedent for capability signalling: `pair-result.browserRunId` optional, additive
  (R-184).

**Decision**:

1. Two additive control frames. Host→worker `upload-consent-request { sessionId, callId,
   files: [{ path, directory }] }`; worker→host `upload-consent-result { callId, decision:
   "once" | "always" | "deny" | "timed-out" | "interrupted" }`. The worker advertises support on
   `pair-result` with `features: ["upload-consent"]` (optional, additive); a host that sees no
   such feature keeps 0.5.0's refusal. A worker that receives the request from a host it did
   not advertise to cannot happen (the host only asks after seeing the feature).
2. Host flow in the `file_upload` interception: resolve → on `outside-roots` **only** (other
   codes still refuse), and only when the session's worker advertised the feature, send the
   request and await the result with the closed-panel bound (120 s + margin; the worker's
   prompt-waiting ticks already tell the agent the owner is being asked). `once` → resolve again
   with those exact files allowed for this call (`resolveUploadFiles` gains an
   `allowFiles: string[]` parameter — realpath-compared); `always` → add each file's directory
   to the config through a shared `upload-config-store.ts` (read → merge → write to a temp file
   → rename; the same module the relay uses in step 4), then resolve again; `deny` →
   `{outcome:"denied", reason:"upload-declined"}`; `timed-out` → `"upload-not-answered"`;
   `interrupted` → the stopped outcome with the interrupted reason (R-185). The specific code
   `outside-roots` now also reaches the agent as `reason` when no consent is possible
   (`"upload-outside-allowed-directories"`), replacing the opaque `upload-not-allowed` for that
   one code — the other codes keep their reason.
3. Worker: on `upload-consent-request` the runtime raises `prompts.ask` kind `"upload-directory"`
   with `AgentEffectPrompt.files = [{ path, directory }]` (paths are shown to the owner in full;
   they never reach the page or any site); the card offers 這些檔案這次 / 這些資料夾以後都可以 /
   不准; the decision goes back as `upload-consent-result`. The directory question precedes the
   site's own gate by construction (the host asks before the call crosses the link).
4. Revoke and listing: the relay (the one process that talks to the worker) answers
   `upload-roots-list` (worker→relay) with `upload-roots { roots }` (relay→worker), and handles
   `upload-roots-remove { root }` (worker→relay) through the same store, answering with the
   new list. The worker asks on `relay-ack` and after every consent result; keeps the list in
   memory for the projection (`AgentPanelState.uploadRoots: string[]`); `SiteList` renders rows
   with a revoke → `ui.agent.upload-root-clear {root}`. An old relay drops the request: the
   projection has no `uploadRoots`, the panel shows no directory rows.
5. Two writers of one file (mcp-server on `always`, relay on remove): both go through
   `upload-config-store.ts` with read-merge-write and atomic rename; a lost update needs two
   owner actions inside the same few milliseconds and is recoverable by repeating the action.
6. **Strictness — measured 2026-09-22 (T349)**: `agentNativeResponseSchema`
   (`agent-tools.ts:2327`), every member of `agentControlFrameSchema` (2363–2450, including
   `pair-result`) and `promptWaitingFrameSchema` (2546) are `z.strictObject` — an unknown key
   makes the whole frame fail to parse, and a rejected frame is dropped unanswered on both
   sides. Consequences: (a) R-186's transition notice goes into the existing `hint` field (max
   400 chars; the notice sentence is ≈ 120), never a new `notice` key; (b) `pair-result.features`
   follows the 013 precedent exactly — `browserRunId` was added the same way (`:2412`), so a
   0.6.0 extension paired with a pre-0.6.0 host is already the "reinstall the host" case since
   0.5.0, documented in the README upgrade note; a 0.6.0 host with an older extension parses
   fine (the field is optional) and simply never asks; (c) every other addition is a new frame
   `type`, which an old side logs as unexpected and drops. Protocol number stays 2.

**Alternatives considered**: (a) the worker asks *before* the call reaches the host — impossible,
the host sees the paths first and the worker never sees paths; (b) the worker writes the config —
the extension cannot write host files; (c) a settings page — rejected by the owner (D-014-3);
(d) letting the agent add a root through a tool — rejected: the agent must not widen its own
allow-list (FR-195).

## R-188 — The 013 tails (decided)

- `noteUploadedImage` (`agent-runtime.ts:972-989`) is generalised to `noteUpload` for
  `file_upload` (message `"input"`) and `upload_image` (`"input" | "drop"`); the panel already
  picks the locale key from `message` (`SessionCard.tsx:45`).
- `upload.ts:116-125` sets `AgentEffectPrompt.delivery: "input" | "drop"` from the arguments
  (`ref` → input; `coordinate` → drop) for `upload_image`; `PromptCard` chooses
  `agent.summary.upload_image.input` / `.drop` (new locale keys, both languages) when present,
  else the existing generic key.
- `RECORDED_TOOLS` (`agent-runtime.ts:941-949`) gains `viewport`; the overlay label reads
  `viewport WxH` or `viewport cleared` from the call's arguments.

## R-189 — Version, counts, documents (decided)

0.6.0 in `build-config.ts` and `tool-offering.ts` (`SERVER_VERSION`); tool count stays 33; the
contract tests that pin counts and descriptions are updated (descriptions of `file_upload`,
`navigate`, `click` gain one sentence each: outside-directory files ask the owner; a move to a
new site is reported and asked at the next call). README, `README.zh-TW.md`, zh-TW operations
guide, QA guide, `docs/design-notes.md` §3 (consent chaining gains interrupt, transition and
directory), and the 參考套件功能拆解 artifact (012/013/014 rows; the transition row's Hallpass
cell corrected; the 設定頁 row moved to "刻意不做").

## R-190 — Spec amendment recorded here: FR-195's "old host says reinstall" (decided)

An old host is 0.5.0 code and cannot say anything new: its answer stays `upload-not-allowed`,
and the tool descriptions the agent reads are the host's, so they are old too. The reinstall
note can only be documentation (README upgrade section, zh-TW operations guide). FR-195 is
amended in S4 to: "an old host refuses as in 0.5.0; the 0.6.0 documentation says what that
answer means and that reinstalling the host enables the question". The old-*worker* case is
covered by the feature flag on `pair-result` (R-187 §1): the host never asks a worker that did
not advertise the capability.

## Follow-ups found on the way

- **A synthesised `click` on an `<a href>` does not navigate** (S2, 2026-09-22, Chromium 151,
  `apps/extension/src/service-worker/agent-tools/input.ts` path): the call answered
  `{"effect":"activated","documentChanged":false,"verified":true}` and the tab stayed put; the
  same click on a `<button>` whose handler sets `location.href` answered `documentChanged: true`
  and moved. `tests/harness/page-fixtures.ts`'s `transition-*` pages use buttons for that reason.
  Not investigated or fixed in S2.

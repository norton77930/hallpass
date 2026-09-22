# Research: Upload a Session Screenshot into a Page

Numbering continues from 012 (R-176). Nothing here needed a live measurement: every question is
answered by reading the code paths the spec's input named, on 2026-09-22, in this worktree. The
one question the owner asked to settle explicitly — who holds the bytes — is R-177.

## R-177 — Who holds the retained screenshot bytes: the host, not the worker (decided)

**Facts read**:

- Every screenshot the agent receives already crosses the host. The worker answers
  `agentScreenshotResultSchema` (`packages/contracts/src/agent-tools.ts` 1038–1074: `mimeType`,
  `data` base64, `cropped`, and the 012 fields), and the host's `toolReply()`
  (`packages/agent-host/src/mcp-server.ts` 647–666) turns any image-shaped result into the MCP
  `image` block plus a sibling `text` block holding the remaining fields as JSON. The `computer`
  tool's screenshot action answers the same schema and goes through the same function.
- `file_upload` already has the shape "bytes come from the host, the worker only places them":
  `mcp-server.ts` 867–877 intercepts `file_upload`, resolves the agent's `paths` against the
  owner's upload roots (`upload-policy.ts` 125–178) and replaces them with `files: [{ name, type,
  bytesBase64 }]` before the same `args` object crosses the link; the worker-facing schema is
  `agentFileUploadArgsSchema` (1539–1550) with the total bound `AGENT_UPLOAD_MAX_BASE64_CHARS =
  700 000` (`common.ts` 199). The `screenshot` tool refuses a picture above that same number itself
  (`SCREENSHOT_MAX_BASE64_CHARS = 700 000`, `reads.ts` 145 and 509), but the `computer` tool's
  screenshot action does not (`effects.ts` 1688–1715): it answers whatever `captureVisibleTab`
  produced, bounded only by the native-messaging frame. So "every screenshot fits an upload frame"
  is *not* true by construction, and the cache applies the upload bound itself — a picture over
  `AGENT_UPLOAD_MAX_BASE64_CHARS` is not retained, whatever the budget allows (S2c review F1,
  `screenshot-cache.ts` `retainLimit`).
- One `mcp-server` process serves one client session (the multi-session investigation of
  2026-09-16: one card per live `mcp-server.js`); its memory is therefore per session, dies with
  the session, and is untouched by worker eviction.
- `chrome.storage.session` has no quota assumption anywhere in the repo and no
  `setAccessLevel` call; Chrome's documented quota for it is 10 MB, and the 012 viewport record and
  the 008 window-restore record already live there. Keeping 8 MiB of base64 beside them would work
  on paper but would put every other session record within a few hundred KB of the quota and would
  serialise 8 MiB of JSON on every read (the 012 store reads fresh on every call by design, 
  `viewport-emulation.ts` 79–86).

**Decision**: the retained bytes live in the **host** (`packages/agent-host`), in memory, in one
module `screenshot-cache.ts`; the id is minted by the host in `toolReply()` at the moment the
image block is built, and `upload_image` is intercepted in `mcp-server.ts` exactly where
`file_upload` is, replacing `imageId` with `file: { name, type, bytesBase64 }` before the call
crosses the link. The worker never sees an id and never stores a picture.

**What this buys**: FR-168's "survives worker recycling" and "per session" hold by construction
(the process is the session); FR-175's "not readable by another session or the panel" holds by
process isolation; no storage quota, no serialisation on every call, no sweep timer in a worker
that may be evicted. FR-172's two refusals are decided before the call touches the browser.

**What it costs / how the spec's remaining clauses are met**: "ends when the browser exits" —
the host learns of a browser exit as a lost link (the worker's "reconnect required" path); the
cache is dropped on link loss and on session end (R-180). A client that keeps its `mcp-server`
alive across a browser restart therefore still cannot upload a pre-restart screenshot, as the
spec says.

**Alternatives considered**: (a) worker-side cache in `chrome.storage.session` as the one
reference does — rejected for the quota and serialisation reasons above and because it would add a
per-session sweep, a session-end drop path and a cross-session key check the host gets for free;
(b) relay-side — the relay is shared across sessions and is the wrong trust boundary.

## R-178 — Delivery in the page: extend the `file_upload` content path, do not touch `drag` (decided)

**Facts read**: `content-runtime/files.ts` `setFilesOnTarget()` (69–130) resolves the ref through
the element registry (`stale-target` if gone), refuses anything that is not `<input type=file>`
(`not-a-file-input`), checks `multiple` and `accept`, builds `new DataTransfer()` + `new File(...)`
in the page's realm, assigns `element.files`, dispatches `input` then `change`, and reads
`element.files` back for the answer. `content-runtime/actions.ts` `drag()` (455–484) is
element-to-element with an empty `DataTransfer`; it never carries files and is not the right seam.
The content broker sends `content.set-files` to a chosen `frameId` (`content-broker.ts` 871–936)
and the worker's `upload.ts` finds that frame with `discoverRefFrame` (004/T160).

**Decision**: one new content message `content.deliver-image` handled by a new function in
`files.ts` beside `setFilesOnTarget`, taking `{ target: { handle } | { point: { x, y } }, file,
documentEpoch }` and returning `{ delivery: "input" | "drop", file: { name, size }, point? }`:

- resolve the element: by handle through the registry, or by `document.elementFromPoint(x, y)`
  after checking the point is inside `innerWidth × innerHeight` (`point-outside-viewport (frame
  WxH)` otherwise);
- **one level of same-origin frame**: if the element found by point is a frame whose
  `contentDocument` is readable, resolve again inside it with the point shifted by the frame's
  bounding rectangle, using that document's realm for `File`, `DataTransfer` and `DragEvent`; a
  cross-origin frame or a frame found again inside the child answers `not-reachable`;
- if the element is `<input type=file>` → the existing set-files code path (shared helper), but
  **without the `accept` refusal**: a programmatic assignment is not filtered by `accept`, the
  answer is what the input holds, and the spec's edge case says the page's own validation decides;
  `multiple` is irrelevant for one file;
- otherwise → `dragenter`, `dragover`, `drop` `DragEvent`s in that order, each with the same
  `DataTransfer` holding the one `File`, `bubbles: true`, `cancelable: true`, `clientX/clientY`
  (and `screenX/screenY` from the window's offsets) at the point or the element's centre; no
  `dragleave` after a drop (a real drop sends none); a drop target that never cancels `dragover`
  still receives the `drop` (the spec reports delivery, not acceptance; a page that ignores the
  event simply shows nothing, which the agent reads).

The worker's `upload.ts` handles the new tool beside `file_upload`: same ownership, same
`decideGate` with `tool: "upload_image"`, same prompt/activity summary path; with a `ref` it calls
`discoverRefFrame` and sends to that frame; with a `coordinate` it sends to the top frame
(frameId 0), which does the one-level descent itself.

## R-179 — The id, the text block and the retention rules (decided)

- **Id**: `img_` + 10 lower-case base-36 characters from a cryptographic source, minted per
  screenshot answer; unique within the session by construction (collision check against the
  issued set). Opaque to the agent.
- **Where it appears**: `toolReply()` adds `imageId` to the `rest` object that becomes the text
  block, plus `upload: "Quote imageId to upload_image to put this picture into a page."` (the
  sentence FR-167 requires; an older host simply omits both fields). A screenshot the cache did
  not retain (oversize, R-179 below) carries `imageId` and `upload: "too large to retain; a smaller
  screenshot (scale or region) can be uploaded."` so the agent learns the rule on the spot.
- **Retention** (`screenshot-cache.ts`, pure, injectable clock): `put(id, bytesBase64, mimeType)`
  → if `bytesBase64.length > BUDGET` (8 388 608) do not store, return `"oversize"`; else sweep
  expired (older than 300 000 ms), then evict oldest until the total fits, then store. `take(id)`
  → `{ kind: "ok", file }` | `{ kind: "unknown" }` (never issued by this process) | `{ kind:
  "gone", why: "expired" | "evicted" | "oversize" }`. Issued ids are remembered in a bounded set
  (FIFO, 10 000) so "unknown" and "gone" stay distinguishable for the life of a session.
- **Answer wording** (ours, FR-172): unknown → `unknown-image-id; take a new screenshot and quote
  its imageId`; gone → `image-no-longer-available (expired|evicted|oversize); take a new screenshot`.

## R-180 — When the cache is dropped (decided)

The cache is a field of the `mcp-server` session object. It is cleared (a) on process exit
trivially, (b) when the link to the extension is lost or the session receives "reconnect
required" (the browser exited, the extension reloaded), (c) when the session is unpaired. A cleared
cache answers `gone (expired)` for previously issued ids only if they are still in the issued
set; after a link loss the issued set is cleared too, so the answer is `unknown`, which is honest
(a new session was formed).

**Superseded on the link-loss point by R-184 below** (gate finding F4, S4). Clause (b) is wrong as
written: a link loss is not evidence that the browser exited, and reading it as one broke the other
half of FR-168. Clauses (a) and (c) stand, and so does the "reconnect required / session ended"
half of (b) — that is the *session* ending, not the port dropping.

## R-181 — Consent, activity, recording and batch parity with `file_upload` (decided)

- Gate: `decideGate({ tool: "upload_image" })` — an effect like `file_upload`; `ask` prompts with
  the existing card whose summary line comes from `summariseToolCall("upload_image", args)`:
  "upload screenshot {id} to {ref}" / "drop screenshot {id} at ({x}, {y})".
- Activity: the same activity kind `file_upload` uses today for an admitted effect, with the
  tool name; the panel needs no new kind (two locale strings if the tool name is rendered).
- Recording overlay: `upload_image` joins the effect list the recorder frames (008, the list that
  contains `file_upload`).
- Batch: `upload_image` is batchable iff `file_upload` is; the host's interception runs per batch
  step exactly as it does for `file_upload` today (confirm in `mcp-server.ts` where batch steps
  are expanded; if `file_upload` is not intercepted inside a batch, neither is `upload_image` —
  parity, and the spec's batch edge case then reads "as `file_upload`").

## R-182 — Fixtures and the gate (decided)

`tests/harness/page-fixtures.ts` gains one fixture page `upload-image` with: a visible
`<input type=file>` and a hidden one behind a button (both report `name:size:type` and a
`change`-ran flag into a text node), a drop zone that records the order of `dragenter`,
`dragover`, `drop` and the dropped file's `name:size:type`, and a same-origin child frame
containing its own drop zone that reports into the parent through `postMessage` or a shared text
node. The gate `tests/e2e/packaged/agent-upload-image.spec.ts` runs the SC-093..097 scenarios
on Chromium in attach mode (unattended recipe), plus the branded-Chrome run and the paid probe
`s13-upload-image.json` in `tests/acceptance/probe-004/scenarios/` (prompt: "attach a picture of
this page to the form and tell me what the page shows afterwards").

## R-183 — Version and counts (decided)

`AGENT_EXTENSION_VERSION` (`apps/extension/src/build-config.ts` 184) and `SERVER_VERSION`
(`packages/agent-host/src/tool-offering.ts` 19) → `0.5.0`; the two contract tests asserting 32
(`tests/contract/agent-tools-008.contract.test.ts` 59, `agent-tools-012.contract.test.ts` 34) →
33 with a new `agent-tools-013.contract.test.ts` pinning the shapes and descriptions; README line
6 ("32 browser tools") and the tools table; `docs/zh-TW/operations-guide.md`;
`docs/zh-TW/qa-guide.html` tool list; `docs/design-notes.md` §7 ("image upload" moves from
planned to a paragraph). The English operations guide and QA guide do not exist in this tree (only
the zh-TW ones), so FR-177's "guides" are those two files.

## R-184 — A browser-run id on the link decides when the retention ends (decided, S4)

**The question** (gate finding F4): FR-168 asks for two things of the retention at once — it
"MUST survive worker recycling" and it "MUST end when the session ends or the browser exits". R-180
read both off the link dropping, and the gate proved that cannot work: `Target.closeTarget` on the
service worker kills the native-messaging host with it, so a recycling and a browser that exited are
the *same* event seen from the `mcp-server` (`agent.relay.detached`). Neither the relay's pid nor
the pairing id separates them — the pid changes on both, the pairing id changes on neither.

**Facts read**: `chrome.storage.session` survives an eviction of the worker and is thrown away when
the browser closes (this is why `window-restore.ts` and `viewport-emulation.ts` keep their records
there). Frame directions: the `hello` in `agentControlFrameSchema` (`agent-tools.ts` ~2423) is 003's
*relay → server* greeting, and the `hello` in `agentLinkFrameSchema` (~2560) is *server → relay →
worker*; the worker sends the host no greeting of its own. The worker-originated frames the host
receives are `pair-result`, `prompt-waiting` and call answers, and of those only `pair-result` is
sent on every (re)established link: a drop calls `resetPairing`, so the next attach re-requests the
pairing and the worker answers (`mcp-server.ts` `resetPairing`/`requestPairing`, 004/T099a). A call
awaits that answer before anything reads the cache (`placeCall` → `requestPairing` → `awaitPairing`
→ `screenshots.take`), so the run is known before it is needed — an unsolicited frame of its own
would have raced the first call after a re-link.

**Decision**: the worker mints one opaque id per browser start, keeps it in `chrome.storage.session`
(`apps/extension/src/service-worker/browser-run.ts`, one instance per worker so it is minted once),
and carries it on its pairing answer as an optional `browserRunId` (≤ 64 chars,
`agentControlFrameSchema`'s `pair-result`). Additive: `AGENT_LINK_PROTOCOL` stays 2, the relay is a
pump that never parses control frames, and an older worker simply omits the field. The host records
the run at the first answer and compares it at every later one (`mcp-server.ts` `noteBrowserRun`):

- same run → **keep** (the recycling case: only the port went away);
- different run → **clear** (the browser exited and started again);
- no run named, after a drop → **clear**, which is exactly S1's behaviour, so a mixed install stays
  honest rather than silently keeping pictures across a restart;
- the clear on a plain link loss is **removed**; the clears on the session ending (`reopenSession`)
  and on an unpair (a `pair-result` decline) stay, because those are the session ending and the
  owner withdrawing the pairing, not a port dropping.

**Alternatives considered**: (a) a new worker-originated frame carrying the run — rejected, it
would race the first call after a re-link and needs routing of its own for no gain; (b) do not clear
on link loss at all and amend FR-168's "browser exits" — rejected, it drops half a requirement the
owner asked for; (c) amend FR-168 and SC-097 to end the retention with the link — rejected for the
same reason; (d) keep the pictures in the worker's own `storage.session` — already rejected by
R-177 for quota and serialisation, and this decision borrows only its *lifetime*, which is the one
thing about it that fits.

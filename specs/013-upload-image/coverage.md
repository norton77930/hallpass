# Coverage: Upload Image (feature 013)

**Branch** `feature-013-upload-image` (worktree feature-008-spec, from `main` f1ab64b).

## R-181 batch parity (S2 finding)

Verified by reading, and nothing was changed. The host intercepts exactly two tool names, and it
does so by the *call's own* name inside `placeCall`: `packages/agent-host/src/mcp-server.ts:934`
(`if (tool === "file_upload")`, which swaps `paths` for `files`) and
`packages/agent-host/src/mcp-server.ts:953` (`if (tool === "upload_image")`, which swaps `imageId`
for `file`). A `browser_batch` call arrives with `tool === "browser_batch"` and its steps inside
`args.steps`, and the host never walks them — the word "steps" appears in `mcp-server.ts` only in a
comment at line 480, so neither interception can see a step. On the worker side the batch runner
forwards each step's arguments exactly as they came, `{ ...step.args, tabId }`, to the same
dispatch a single call uses (`apps/extension/src/service-worker/agent-tools/batch.ts:158-172`, the
arguments built at `:100`). So a `file_upload` step still carries `paths` and no `files`, and
`agentToolArgSchemas.file_upload.safeParse` refuses it as
`{ outcome: "failed", reason: "invalid-arguments" }`
(`apps/extension/src/service-worker/agent-tools/upload.ts:145-150`); an `upload_image` step still
carries `imageId` and no `file`, and its schema — which cannot express an id at all — refuses it
with the same words (`apps/extension/src/service-worker/agent-tools/upload.ts:206-210`). Both tools
are therefore listed as batchable in the contract
(`packages/contracts/src/agent-tools.ts:1130`, `:1133`) while being unusable inside a batch in
practice, and they are unusable in *exactly* the same way: `upload_image` inherits `file_upload`'s
behaviour rather than a new one, which is the parity R-181 asks for. The spec's batch edge case
accordingly reads "as `file_upload`". A batch step that carried worker-shaped arguments itself
(`files` bytes, or `file`) would pass, because `agentBatchStepSchema` leaves step arguments as
`z.record(z.string(), z.unknown())` (`packages/contracts/src/agent-tools.ts:1150-1153`) — that is
not a documented shape for an agent, and it is noted here only so the refusal is not mistaken for
an unconditional one.

## Activity parity (S2 note)

R-181's activity line resolves to "nothing to add": there is no activity kind for an upload today.
`agentActivityItemSchema` allows only `dialog | export | restore | viewport`
(`packages/contracts/src/agent-tools.ts:2746-2767`) and the runtime notes activity at three places
only — restore, viewport and dialogs (`apps/extension/src/service-worker/agent-runtime.ts:697`,
`:717`, `:750`) — so `file_upload` writes no activity entry either. Parity with `file_upload` means
`upload_image` writes none, and giving it one would be a new activity kind (a contracts change)
outside this slice. The panel-visible evidence of an admitted `upload_image` is the consent card and
the recording frame instead.

**Superseded by the activity-line decision below (S2c):** FR-174 asks for the line in so many words,
so `upload_image` now writes one and the contracts change was made.

## Review findings (T337)

The S1+S2 review produced three findings; all three are fixed here, in commit `S2c` ("Feature 013
S2c: review fixes … and the upload activity line"), each with its own RED test first.

### F1 (medium) — the oversize bound now includes the upload frame bound

A retained picture exists to be carried back to the worker in one native-messaging frame, whose
`file.bytesBase64` the contract bounds at `AGENT_UPLOAD_MAX_BASE64_CHARS = 700 000`
(`packages/contracts/src/agent-tools.ts:1528`, `packages/contracts/src/common.ts:199`). The cache
classified oversize against `budgetChars` (8 MiB) alone, so a picture between the two numbers was
kept with the sentence that promises an upload — and that upload would have been refused by the
contract. The `screenshot` tool refuses such a picture itself
(`SCREENSHOT_MAX_BASE64_CHARS`, `apps/extension/src/service-worker/agent-tools/reads.ts:145`,
`:509`), but the `computer` tool's screenshot action does not
(`apps/extension/src/service-worker/agent-tools/effects.ts:1688-1715`), which is the path that made
this reachable.

- Fix: `packages/agent-host/src/screenshot-cache.ts:111` (`retainLimit = Math.min(budgetChars,
  AGENT_UPLOAD_MAX_BASE64_CHARS)`), applied at `:178`. `effects.ts` is deliberately unchanged: the
  bound is stated once, where the id is minted.
- Tests: `packages/agent-host/tests/screenshot-cache.test.ts:131` (700 001 → not retained, `take` →
  `gone oversize`; exactly 700 000 → retained). The budget's own bound keeps its case at `:110`,
  now with an injected budget under one frame so the two bounds are tested apart; the eviction case
  at `:83` likewise uses an injected two-picture budget.
- `research.md` R-177 corrected: "every screenshot fits an upload frame by construction" was not
  true, and the paragraph now says which tool bounds what and that the cache applies the upload
  bound itself.

### F2 (minor) — the iframe descent now subtracts padding as well as the border

The one-level descent translated the agent's coordinate by the frame's rectangle and `clientLeft`/
`clientTop` only, so a padded frame hit-tested the child document `padding` pixels off.

- Fix: `apps/extension/src/content-runtime/files.ts:294-301` (`getComputedStyle` read from the
  runtime's own scope; an absent function or a value that is not a number contributes 0).
- Test: `apps/extension/tests/content-runtime-deliver-image.test.ts:361` (rect left 100, border 2,
  padding 8 → child point = x − 110).
- `spec.md` Edge Cases gained a line: a CSS-transformed frame is a known limit and is not
  supported — the translation is exact for an untransformed frame only.

### F3 (minor) — the test gaps

- (a) `positiveEnv` is exported (`packages/agent-host/src/mcp-server.ts:185`) and pinned at
  `packages/agent-host/tests/mcp-server.test.ts:886`: `"abc"`, `"0"`, `"-5"`, `""` and unset each
  leave the product's own bound standing, for both overrides.
- (b) the input path reached by a *point*, and inside a child frame:
  `apps/extension/tests/content-runtime-deliver-image.test.ts:192` (`delivery: "input"`, `input` and
  `change`, and none of the drag sequence) and `:205` (a file input in a same-origin child frame,
  with the `File` built by the *child* realm).
- (c) the owner's Release tabs under a standing consent for `upload_image`:
  `apps/extension/tests/agent-upload.test.ts:320` — `denied/not-yours`, the prompt settled, and
  `deliverImage` never called.

### The activity line (FR-174), and what was deliberately left out

FR-174 names the panel's activity list explicitly, so `upload_image` writes one item:

```
{ at, kind: "upload", outcome: "delivered", site?: <the tab's site>, message: "input" | "drop" }
```

- Contract: `packages/contracts/src/agent-tools.ts:2752` (`kind` gains `"upload"`) and `:2765`
  (`outcome` gains `"delivered"`); `message` carries the delivery the *page* reported. Additive —
  the link protocol floor does not move.
- Worker: `apps/extension/src/service-worker/agent-runtime.ts:971` (`noteUploadedImage`), called
  from the upload branch of `runTool` at `:1065`. Only an `ok` answer earns a line; the site is the
  tab's own (`getTabSnapshot` + `siteOfUrl`) and is left out when it cannot be named.
- Panel: `apps/extension/src/side-panel/agent/SessionCard.tsx:39`, keys
  `agent.activity.uploadInput` ("Screenshot put into a form on {site}" / 「截圖已放進 {site} 的表單」),
  `agent.activity.uploadDrop` ("Screenshot dropped on {site}" / 「截圖已拖放到 {site}」) and the
  outcome word `agent.activity.delivered` ("Delivered" / 「已送達」). A third key,
  `agent.activity.unknownSite` ("the page" / 「這個頁面」), fills the site hole when the worker sent
  none — the alternative was a dangling "…on " in both languages.
- Tests: `tests/contract/agent-tools-013.contract.test.ts:161` (the new kind and outcome, and a
  refused one), `apps/extension/tests/session-card.test.tsx:348` (both sentences, the site-less
  fall-back, and the rendered card) and `apps/extension/tests/recording-wiring.test.ts:234`/`:260`
  (one item for a delivered picture through the whole runtime; none for a refused call — that file's
  harness is the only one with a paired session, a held tab and a page that answers a delivery).
- **Left for the owner**: `file_upload` still writes no activity item. Giving it one is a change to
  behaviour the owner has been living with since 003, and FR-174 is 013's requirement, not 003's —
  so the parity decision is theirs. Nothing else about the two tools differs.

## Gate (T342)

**Fixture** `tests/e2e/fixtures/pages/upload-image.html` + `upload-image-child.html` (T340), served
by the existing page-fixture server at `https://127.0.0.1:19443/upload-image`. Every element is
absolutely positioned: visible file input `#visible` (20, 20), the page's own button `#pick` over a
`display: none` `#hidden` input, drop zone `#zone` 200x120 at (20, 92) — centre **(120, 152)** —, and
a same-origin `<iframe id=child>` at (20, 232), no border and no padding, whose own zone at (20, 20)
makes **(140, 312)** a point inside the child's zone in the parent's coordinates. The page reports
`<name>:<size>:<type> changed` (plus `data-events="input,change"`) for each input and
`dragenter,dragover,drop|<name>:<size>:<type>` for each zone, the child relaying through
`postMessage`.

**Spec** `tests/e2e/packaged/agent-upload-image.spec.ts` (T341), attach mode. Both environment
overrides are set by the spec *per session* (`startMcpClient({ env })`) rather than for the run, so
every other journey in the file exercises the shipped five minutes and 8 MiB; they are documented in
the spec's header, not in the README.

| Run | Browser | Result |
| --- | --- | --- |
| upload-image, run 1 | Chromium 151.0.7922.34 | 2/5 — three harness faults, all in the spec: the read does not carry `hidden` to the agent (`reads.ts:305` decides with it and does not say so), the consent card shows the panel's own per-tool sentence rather than the worker's `argsSummary` (`agent-panel-keys.ts` TOOL_SUMMARY_KEYS, by design), and the site-mode helper matched an activity `li` naming the same site instead of the mode row (`[data-site]` now) |
| upload-image, run 2 | Chromium 151.0.7922.34 | 4/6 — the two above fixed; journey 5 split in two so SC-097's halves report separately |
| upload-image, run 3 | Chromium 151.0.7922.34 | 5/6 — the one red was the worker-restart retention (F4, below) |
| regression trio (`agent-upload`, `agent-reads`, `agent-recording`) | Chromium 151.0.7922.34 | 8/8 |
| upload-image, run 4 (final, after the S4 fix) | Chromium 151.0.7922.34 | **6/6** — F4 fixed; the run-restart journey is green with no change to the spec's assertions |
| `agent-tabs` (pairing + reconnect regression for the handshake change) | Chromium 151.0.7922.34 | 1/1 |

| SC | Result |
| --- | --- |
| SC-093 | **2/2** — journey 1: `screenshot` answered `imageId` matching `/^img_[a-z0-9]{10}$/` and the retained sentence; `upload_image {ref}` into the visible input → page reported `screenshot.png:28187:image/png changed` with `data-events="input,change"`, and into the `display: none` input (which the `interactive` read leaves out and the `all` read still gives a ref for) under `filename: "page-shot.png"`. The same id served both uploads, which is FR-168's five minutes seen from the agent's side. `size` is the decoded byte length of the picture the agent was handed |
| SC-094 | **3/3** — journey 2: by coordinate at the zone's centre, by `ref` to the zone (answer `point` = the same centre, read from the element's own rectangle), and by coordinate inside the child frame's zone; each reported `dragenter,dragover,drop` in order with one file, no `dragleave`, and the parent's zone stayed `none` for the child delivery |
| SC-095 | **3/3 live** — journey 3: `img_zzzzzzzzzz` → `unknown-image-id`; a picture under `HALLPASS_SCREENSHOT_RETENTION_MS=2000`, quoted 2.5 s later → `image-no-longer-available (expired)`; two screenshots under `HALLPASS_SCREENSHOT_BUDGET_CHARS` = 1.5x one picture's base64 length (both answered *retained*, so the refusal is eviction and not the oversize bound) → the first → `(evicted)` while the second still uploaded. The fixture reported `none` after each refusal, and the host logged `agent.upload-image.refused`. The foreign-session case is T327 (f) |
| SC-096 | **2/2** — journey 4: on `ask` the card appeared with "Claude Code wants to do this on https://127.0.0.1:19443: Put a screenshot the agent took into the page" (the panel's own reviewed string, no id and no file name); Refuse → `denied/owner-denied`, the input empty and its `data-events` still empty; Allow once → delivered, and the card carried exactly one activity line "Screenshot put into a form on https://127.0.0.1:19443" with "Delivered" — none for the refused call, and no drop sentence |
| SC-097 | **2/2** — Session end: a new session quoting the old id → `unknown-image-id`, the page untouched (1/1, journey "forgets a picture when the session ends"). Worker restart: the worker killed through `Target.closeTarget`, the link re-established ~7 s later, and the same id then delivered the picture as a drop at the zone's centre with the fixture reporting `dragenter,dragover,drop|screenshot.png:<size>:image/png` (1/1, journey "keeps a picture across a worker restart") — red in run 3, green in run 4 after the S4 fix below |

### F4 (blocking, found by the gate) — **fixed in S4**: a worker recycling took the retention with it

FR-168's last sentence: "Retention MUST survive worker recycling and MUST end when the session ends
or the browser exits", and SC-097 asks for the upload to succeed after a forced worker restart. It
does not. `Target.closeTarget` on the service worker kills the native-messaging host with it, so the
`mcp-server` sees its link drop (`agent.dial.detached` / `agent.relay.detached`) and clears the cache
there — `packages/agent-host/src/mcp-server.ts:649` (`screenshots.clear()`, R-180 "site 1 of 3"). The
session re-links ~14 s later and re-pairs, and the id then answers `unknown-image-id`; the gate
records the host's own words in the failure message.

R-180 decided that clearing on link loss is how this process learns the browser exited, which is the
*other* half of the same FR-168 sentence — so the two halves of the requirement are in conflict as
implemented, and honouring both needs a way to tell a recycled worker from a browser that exited
(the relay's port changes either way, and the pairing id does not change at all; something like a
browser-run id kept in `storage.session` and carried on the link would do it). That is a design
decision about the retention's own rule and a change to S1's host, so it was **not** made in the S3
brief: the gate kept the assertion FR-168 asks for and was red. Options were (a) carry a browser-run
id on the link and clear only when it changes; (b) do not clear on link loss and amend FR-168's
"browser exits" to "session ends"; (c) amend FR-168 and SC-097 to end the retention with the link.

**The fix (S4, option (a); the decision is written up as R-184 in `research.md`, which also marks
R-180 superseded on the link-loss point).** A **browser-run id**: one opaque id the worker mints on
first use after the browser starts and keeps in `chrome.storage.session` — the one store whose
lifetime is exactly the difference the requirement turns on, since Chrome keeps it across an
eviction of the worker and throws it away when the browser closes.

- There is no worker→host greeting to put it on: the `hello` at `packages/contracts/src/agent-tools.ts:2423`
  is 003's *relay → server* frame and the one at `:2560` is *server → relay → worker*. The frame the
  *worker* sends on every (re)established link is its pairing answer, so the field rides that:
  `browserRunId: z.string().min(1).max(64).optional()` on `pair-result`
  (`packages/contracts/src/agent-tools.ts:2412`, pinned at
  `tests/contract/agent-tools-013.contract.test.ts:191`: named, omitted, at the 64-char bound,
  empty, over the bound, not a string). Additive — `AGENT_LINK_PROTOCOL` stays 2
  (`tests/contract/agent-tools-013.contract.test.ts:211`), the relay never parses a control frame,
  and an older worker omits the field. It is also the frame with the right *ordering*: a call awaits
  the pairing answer before `screenshots.take` runs, so the run is known before the cache is read.
- Worker: `apps/extension/src/service-worker/browser-run.ts` (mint-or-read, one instance per worker
  so two concurrent asks cannot mint two runs), held by the runtime at
  `apps/extension/src/service-worker/agent-runtime.ts:1244` (wired at `:1307`) and put on the answer
  by the bridge at `apps/extension/src/service-worker/agent-bridge.ts:314-351` (asked for *beside* the owner's
  decision, and a storage failure leaves the field off rather than withholding the answer).
- Host: `packages/agent-host/src/mcp-server.ts:382` (`noteBrowserRun`), called from the
  `pair-result` branch at `:623`. Same run → keep; different run → clear; no run named after a drop
  → clear, which is S1's behaviour kept for a mixed install. The clear on a plain link loss is gone
  (`:713`, which now only records that the link dropped).
- **What the remaining clear sites mean**, read in the code: `reopenSession` (`:426`) is the
  *session* ending — the worker forgot this session (the owner pressed Stop on its card, 006 FR-087)
  and the way on is a new session under the same id, so a picture the previous one took is not this
  one's; the `pair-result` decline (`:642`) is the owner *unpairing*, which withdraws what the
  session was holding of their screen. Neither is a port dropping. The rule the code now states is:
  clear when the session ends, when the agent is unpaired, or when the browser run changes — never
  merely because the link went away.
- Tests: `packages/agent-host/tests/mcp-server.test.ts:812` (same run across a drop → the id still
  resolves and the picture crosses the *new* link), `:844` (a different run → `unknown-image-id`,
  nothing reaches the worker), `:875` (no run named → `unknown-image-id`, the legacy answer); the
  session-ended and unpair cases at `:896` and `:920` are unchanged and still clear. Worker side:
  `apps/extension/tests/browser-run.test.ts` (minted once, read back from a fake
  `chrome.storage.session` by a second module instance — the recycling — a new id when the store is
  empty, one id under two concurrent asks, and `undefined` with no store) and
  `apps/extension/tests/agent-bridge.test.ts:110` (the field on the frame, on contract) and `:129`
  (a storage failure still answers the pairing, without the field). The harness learned to state a
  run: `tests/harness/fake-agent-worker.ts` option `browserRunId`.
- Four runtime-level assertions now read `browserRunId: expect.any(String)` on an accepted
  `pair-result`, because the wired runtime really does name its run
  (`apps/extension/tests/agent-runtime-wiring.test.ts:187`,
  `agent-runtime-sessions.test.ts:254`/`:669`, `agent-panel-port.test.ts:195`).
- Numbers after the fix: unit 1211 (1 skipped), extension-ui 62, contract 208 (2 skipped),
  `typecheck` and `snapshot:check` clean, gate `agent-upload-image` **6/6** and `agent-tabs` 1/1 on
  Chromium 151.0.7922.34.

## Requirements → evidence (T344)

| FR | What | Unit / contract | Gate (Chromium 151 · Chrome 153) | Probe |
| --- | --- | --- | --- | --- |
| FR-167 an `imageId` on every screenshot answer | host `toolReply` mints it; `upload` sentence | mcp-server.test (screenshot + computer screenshot, oversize sentence) | agent-upload-image #1 (text block carries `imageId` + sentence) | s13: `img_8452egrmla` quoted back |
| FR-168 retention 5 min / 8 MiB / oldest-first / per session / survives recycling / ends with the browser | `screenshot-cache.ts`; browser-run id on `pair-result` (R-184) | screenshot-cache.test (a–i, + 700 000 bound), mcp-server.test (same run / different run / no run / unpair / session end), browser-run.test | #3 expired + evicted refusals; #5 worker restart → upload ok (SC-097 2/2) | |
| FR-169 upload by id to a ref or a coordinate; exactly one | contracts shapes; host interception | agent-tools-013.contract, mcp-server.test (interception, invalid-arguments) | #1 ref, #2 coordinate | s13: `ref=t_…` |
| FR-170 input path: one file, change handling ran, answer read back | `deliverImage` input path | content-runtime-deliver-image.test (a, point-on-input, child-frame input) | #1 visible + hidden input: `screenshot.png:<size>:image/png changed` (2/2) | s13: page shows `screenshot.png:29436:image/png changed` |
| FR-171 drop path: enter/over/drop with one File; one-level same-origin frame | `deliverImage` drop path, frame descent | content-runtime-deliver-image.test (b–f, padding) | #2 zone by coordinate, by ref (centre), child-frame zone (3/3) | |
| FR-172 unknown vs no-longer-available, before the browser | host `take` + refusal strings | mcp-server.test (c, d), screenshot-cache.test (e–g) | #3 unknown / expired / evicted, page untouched (3/3) | |
| FR-173 not-a-drop-target, point outside, both/neither | content refusals; schema refinement | content-runtime-deliver-image.test (g, h), agent-upload.test (mapping, invalid-arguments) | (unit-proven; the gate's fixtures have no non-droppable ref) | |
| FR-174 same consent as `file_upload`; ownership first; activity line; recording overlay | `admit()` shared; `requiresGate`; `noteUploadedImage`; `RECORDED_TOOLS` | agent-upload.test (gate table, released), site-mode-gate.test, recording-wiring.test, session-card.test | #4 ask-site card + decline → input empty; accept → uploaded; one activity line (2/2) | |
| FR-175 bytes never on disk, never readable by another session or the panel | host memory only; per-process cache | screenshot-cache.test (f two instances), mcp-server.test (logs carry codes only) | #5 new session → `unknown-image-id` | |
| FR-176 descriptions steer | contracts descriptions | agent-tools-013.contract (T338) | | s13: the model chose `screenshot` → `upload_image`, never `file_upload` |
| FR-177 33 tools, 0.5.0, docs | build-config, tool-offering, README, zh-TW guides, design notes | agent-tools contract (33), hallpass-identity (0.5.0), public-files, qa-package | | |

## Branded Chrome (T345)

`agent-upload-image.spec.ts` on the owner's branded **Chrome 153.0.8010.50** (private profile +
private LOCALAPPDATA, attach on 9222, agent build loaded unpacked by the fixture): **6/6** in 1.8 m —
SC-093 2/2, SC-094 3/3, SC-095 3/3, SC-096 2/2, SC-097 2/2. Same assertions as the Chromium run; no
browser-specific difference surfaced (unlike 012's R-176).

## Probe (T346, SC-098)

`s13-upload-image` on Chrome 153.0.8010.50, `claude` 2.1.278, model sonnet, site mode skip-checks,
reference extension loaded unpacked (id as installed) so the runner's environment check passes:
`tabs_create → screenshot → read_page → upload_image {imageId: img_8452egrmla, ref: t_…} →
get_page_text`; observed `uploaded-by-id`, answer `{"delivery":"input","file":{"name":"screenshot.png",
"size":29436}}`, page report `screenshot.png:29436:image/png changed`; the model quoted the
screenshot answer's sentence back ("Quote imageId to upload_image … (kept 5 minutes)"). Verdict
**done 1/1** (`tests/acceptance/probe-004/reports/004-2026-09-22T04-02-15Z.md`, private).

## Final verification (T347, 2026-09-22 12:10 local, HEAD c6bab75 + S13 runner registration + this file)

| Check | Result |
| --- | --- |
| `npm run test` (unit + extension-ui) | 1273 passed / 1 skipped (117 files) |
| `npm run test:contract` | 208 passed / 2 skipped |
| `npm run snapshot:check` | 585 files, 0 forbidden paths, 0 pattern hits |
| `npm run typecheck` | clean |
| Gate Chromium 151.0.7922.34 | 6/6 (+ agent-tabs 1/1, regression trio 8/8) |
| Gate Chrome 153.0.8010.50 | 6/6 |
| Probe S13 | done 1/1 |

Counts at the 012 tip before 013: unit 1218, contract 196, snapshot 565.

## Left for the owner

1. Merge in order: `git merge --ff-only feature-012-viewport-zoom` then `git merge --ff-only
   feature-013-upload-image` (on `main`); `npm run build`; host reinstall; extension reload.
2. Public switch at 0.5.0 now supersedes the 0.4.0 decision of this morning if you merge both first
   (one re-snapshot); say which.
3. Parity decision recorded in "Activity parity": `file_upload` still writes no activity line; the
   consent card shows the panel's per-tool sentence and cannot tell input from drop (the activity
   line can).
4. Known limit: a CSS-transformed iframe is hit-tested wrong (spec Edge Cases); batch steps are not
   host-intercepted for either upload tool (R-181, unchanged behaviour).

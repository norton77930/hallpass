---

description: "Task list for Upload a Session Screenshot into a Page"
---

# Tasks: Upload a Session Screenshot into a Page

**Input**: `/specs/013-upload-image/spec.md`, `plan.md` (S1–S3), `research.md` (R-177–R-183),
`data-model.md`, `contracts/upload-image.md`, `quickstart.md`.

**Tests**: TDD in S1/S2 (one focused RED per module before the code: cache rules; host reply and
interception; content delivery table; worker routing and gate parity); S3 closes on the packaged
gate, one branded-Chrome run and one paid probe (SC-098, owner allowed 2026-09-22).
`code-reviewer` once, after S1+S2 (base64→File across realms, budget arithmetic, gate parity,
isolation claims).

**Numbering** continues from 012 (T302–T323): this feature starts at **T324**.

## Standing rules (owner, 2026-09-18 — binding for every task)

1. **Two attempts, then stop.** A task that fails its second attempt is not tried a third time.
2. **Clean room.** Behaviour only; no reference identifier in `specs/` or source (the reference
   evidence is private and export-ignored); answer strings and event names are ours.
3. **One writer at a time.** Brief 1 = S1 (contracts + host); brief 2 = S2 (worker + content);
   brief 3 = fixture + gate spec + docs; version bump, branded run, probe and coverage stay with
   the main session.
4. **No new permission; nothing private leaves.** `npm run snapshot:check` before the final commit.
5. **Paid run**: one probe (T346), allowed by the owner on 2026-09-22.

## Phase 1 — Setup

- [X] T324 Read `contracts/upload-image.md`, `data-model.md`, `research.md` R-177–R-181 and the
  sources they name; confirm at HEAD: `mcp-server.ts` intercepts `file_upload` at one place
  (≈ 867) and `toolReply()` builds the image block (≈ 638–666); `upload.ts` handles only
  `file_upload`; `files.ts` `setFilesOnTarget` refuses non-inputs and checks `accept`;
  `AGENT_TOOL_NAMES` has 32 entries; `file_upload` is in `AGENT_BATCH_STEP_TOOL_NAMES` and in
  `RECORDED_TOOLS` (`agent-runtime.ts` ≈ 940); `AGENT_UPLOAD_MAX_BASE64_CHARS = 700_000`.

## Phase 2 — Foundational: contracts (blocks US1–US4)

- [X] T325 RED: `tests/contract/agent-tools-013.contract.test.ts` — `AGENT_TOOL_NAMES` contains
  `upload_image` (33 names) and `AGENT_BATCH_STEP_TOOL_NAMES` contains it (parity with
  `file_upload`); the agent-facing shape accepts `{tabId, imageId, ref}` and `{tabId, imageId,
  coordinate:{x,y}, filename:"a.png"}`, rejects both-given, neither-given, `filename` with `/` or
  `\`; the worker-facing schema accepts `{tabId, target:{ref}, file:{name,type,bytesBase64}}` and
  `{tabId, target:{coordinate}, file}` and rejects `bytesBase64` over the bound; the result schema
  accepts `{delivery:"input", file:{name,size}}` and `{delivery:"drop", file, point}`; the manifest
  snapshot has no new permission; update the 32 assertions in `agent-tools-008` and
  `agent-tools-012` contract tests to 33.
- [X] T326 GREEN: `packages/contracts/src/agent-tools.ts` — `agentUploadImageShape` (agent-facing,
  `superRefine` exactly-one-of `ref`/`coordinate`, `filename` via `agentFileNameSchema` with
  default `screenshot.png`), `agentUploadImageArgsSchema` (worker-facing, `file` via
  `agentUploadFileSchema` bounded), `agentUploadImageResultSchema`, the tool in both name lists,
  the tool entry with the FR-176 description, the `file_upload` / `screenshot` / `computer`
  description additions. `AGENT_LINK_PROTOCOL` unchanged (comment: additive).

## Phase 3 — US3 retention + US1 host side (P1/P3) — FR-167, FR-168, FR-172, FR-175 (S1, brief 1)

**Goal**: every screenshot answer carries an `imageId`; the host keeps the bytes under the
spec's bounds; `upload_image` is turned into a bytes call or refused before the browser is
touched.

**Independent Test**: unit tables in T327 and T329.

- [X] T327 [US3] RED: `packages/agent-host/tests/screenshot-cache.test.ts` — with an injected
  clock and id source: (a) `put` then `take` returns the bytes and type; (b) at +300 001 ms `take`
  → `gone expired`; (c) three entries of 3 MiB each: the third `put` evicts the first only
  (oldest-first, stop when it fits) and `take(first)` → `gone evicted`; (d) one entry of
  8 388 609 chars → `put` returns `oversize`, nothing stored, `take` → `gone oversize`; (e) an id
  never issued → `unknown`; (f) two cache instances do not see each other's ids (`unknown`);
  (g) `clear()` → later `take` → `unknown` (issued set cleared too, R-180); (h) the issued set is
  bounded at 10 000 (the 10 001st issue forgets the oldest, which then answers `unknown`);
  (i) ids match `/^img_[a-z0-9]{10}$/` and never repeat across 1 000 mints.
- [X] T328 [US3] GREEN: `packages/agent-host/src/screenshot-cache.ts` (NEW) —
  `createScreenshotCache({ now, randomId })` with `issue(bytesBase64, mimeType) → { imageId,
  retained: boolean }`, `take(imageId)`, `clear()`; constants `SCREENSHOT_RETENTION_MS`,
  `SCREENSHOT_BUDGET_CHARS`, `SCREENSHOT_ISSUED_LIMIT`; pure, no timers (sweep on `issue` and
  `take`).
- [X] T329 [US1] RED: `packages/agent-host/tests/mcp-server.test.ts` (extend) — (a) a
  `screenshot` reply and a `computer` screenshot reply each yield a text block whose JSON has
  `imageId` and `upload` (the quote sentence); (b) an oversize reply has `imageId` and the
  too-large sentence; (c) `upload_image` with an unknown id → `denied` with reason starting
  `unknown-image-id`, nothing sent to the link; (d) an expired id → `denied`
  `image-no-longer-available (expired)`; (e) a live id → the frame crossing the link carries
  `target` and `file:{name:"screenshot.png", type:"image/png", bytesBase64}` and no `imageId`;
  `filename` given → that name; (f) after the link drops / `reconnect required` / unpair, the id
  answers `unknown`.
- [X] T330 [US1] GREEN: `packages/agent-host/src/mcp-server.ts` — one cache per session object;
  `toolReply()` issues the id when it builds the image block and adds `imageId` + `upload` to the
  text-block object; `upload_image` interception beside `file_upload` (take → denied reasons per
  contract; ok → `{ tabId, target, file }`); `cache.clear()` on link loss, reconnect-required and
  unpair paths (name the three sites in the commit message). Log codes
  `agent.upload-image.refused` with the kind, never the bytes.
- [X] T331 Run `npm run test:unit` and `npm run test:contract`; tick T325–T330; commit
  "Feature 013 S1: screenshot ids, the host cache, and the upload_image interception".

**Checkpoint**: an agent gets ids and the host answers refusals; the worker does not yet know the
tool.

## Phase 4 — US1 + US2 worker and content (P1/P2) — FR-169, FR-170, FR-171, FR-173, FR-174 (S2, brief 2)

**Goal**: the worker treats `upload_image` as `file_upload`'s sibling and the page receives the
file into an input or as a drop, one level into a same-origin frame.

**Independent Test**: unit tables in T332 and T334; gate T341 steps 1–2, 4.

- [X] T332 [US2] RED: `apps/extension/tests/content-runtime-dom.test.ts` (or a new
  `content-runtime-deliver-image.test.ts` on the same jsdom harness) — `deliverImage` table:
  (a) handle → `<input type=file accept=".pdf">` → `delivery:"input"`, `files.length 1`, name and
  size read back, events `input` then `change` observed in order, **no** accept refusal;
  (b) handle → `<div>` → `delivery:"drop"` at the element's centre, the div observed `dragenter`,
  `dragover`, `drop` in order, each `event.dataTransfer.files[0]` is the one File with the name
  and type, `clientX/Y` = centre, no `dragleave`; (c) point → the element under it (`elementFromPoint`
  stubbed) → same as (b) with `clientX/Y` = point; (d) point over a same-origin iframe: the child
  document's element under the shifted point receives the drop and the File is built with the
  child realm's constructors; (e) point over a cross-origin iframe (`contentDocument` null) →
  `not-reachable`; (f) point over an iframe whose child element is itself an iframe →
  `not-reachable`; (g) point outside `innerWidth×innerHeight` → `point-outside-viewport` with
  `frame:{width,height}`; (h) `elementFromPoint` null → `not-a-drop-target`; (i) stale handle →
  `stale-target`; (j) a realm without `DataTransfer` → `unsupported`.
- [X] T333 [US2] GREEN: `apps/extension/src/content-runtime/files.ts` — `deliverImage(payload)`
  with a shared `placeIntoInput(element, files, { checkAccept })` used by `setFilesOnTarget`
  (accept check on) and by `deliverImage` (off), `resolveDeliveryTarget` (handle | point, one-level
  descent), `dropOnto(element, file, point, realm)`; `content-runtime/index.ts` route
  `"content.deliver-image"`; `service-worker/content-broker.ts` `deliverImageOnTab(input)` shaped
  like `setFilesOnTab` (epoch/origin re-check, `frameId`, bounded reply).
- [X] T334 [US1] RED: `apps/extension/tests/agent-upload.test.ts` (extend) — `upload_image`:
  (a) not the session's tab → `not-yours` refusal; (b) gate table as `file_upload`: `ask` →
  prompt with `argsSummary` "upload screenshot img_… to ref …" / "drop screenshot img_… at (x, y)",
  decline → `denied`, accept → proceeds; `skip-checks` → proceeds; revoked → refused;
  (c) `target.ref` → `discoverRefFrame` consulted and `deliverImage` called with that `frameId`
  and `{handle}`; (d) `target.coordinate` → `frameId 0` and `{point}`; (e) reply mapping:
  `stale-target` → `stale`, `not-a-drop-target` / `point-outside-viewport (frame WxH)` /
  `not-reachable` → `not-actionable` with the reason text, `unsupported` → `failed`, ok →
  `{outcome:"ok", result:{delivery, file, point?}}`; (f) an admitted upload notes one activity
  entry with tool `upload_image`; (g) `RECORDED_TOOLS` contains `upload_image`.
- [X] T335 [US1] GREEN: `apps/extension/src/service-worker/agent-tools/upload.ts` — `handles()`
  both tools; `run()` branches on the tool after the shared ownership + bind + gate steps;
  `agent-tools/summaries.ts` — `upload_image` summary; `agent-runtime.ts` — `RECORDED_TOOLS` +
  `upload_image`; `locales/en-US.ts` + `zh-TW.ts` — `agent.summary.upload_image` ("Put a
  screenshot the agent took into the page" / 「把代理拍的截圖放進頁面」); R-181 batch parity:
  confirm whether `file_upload` steps inside `browser_batch` pass the host interception; if they
  do, `upload_image` must too (same code path); if they do not, note it in `coverage.md` and keep
  parity (record which).
- [X] T336 Run `npm run test:unit`; tick T332–T335; commit "Feature 013 S2: upload_image in the
  worker and the deliver-image content path".

**Checkpoint**: US1–US3 complete at unit level.

## Phase 5 — Review gate

- [X] T337 Dispatch `code-reviewer` (read-only) over the S1+S2 diff with the claim: "a retained
  screenshot is resolvable only by the process that issued it, for at most five minutes, within
  the budget with oldest-first eviction; `upload_image` cannot reach the page without passing the
  same gate as `file_upload`; the file delivered to the page is byte-identical to the screenshot
  the agent received, built in the target document's realm; refusals happen before any page
  change". Fix findings in a fourth brief if any; record them in `coverage.md`.

## Phase 6 — US4 + proof + documents (P3) — FR-176, FR-177; SC-093..099 (S3, brief 3 + main session)

**Goal**: the agent reaches for a screenshot then `upload_image`; the gate proves US1–US3 live;
0.5.0 ships.

**Independent Test**: contract test on the descriptions; gate spec green; probe transcript.

- [X] T338 [P] [US4] Contract test in `tests/contract/agent-tools-013.contract.test.ts` —
  `upload_image`'s description contains "screenshot", "imageId", "ref", "coordinate", "5 minutes"
  and "file_upload"; `file_upload`'s contains "upload_image"; `screenshot`'s and `computer`'s
  contain "imageId" (FR-176).
- [X] T339 [P] Version 0.5.0 (R-183): `apps/extension/src/build-config.ts`
  `AGENT_EXTENSION_VERSION`, `packages/agent-host/src/tool-offering.ts` `SERVER_VERSION`, the
  watermark strings in `apps/extension/tests/{offscreen-router,overlay,recorder}.test.ts`, the
  offering snapshot if it pins the version. (main session)
- [X] T340 [P] Gate fixture in `tests/harness/page-fixtures.ts` (`upload-image` page): a visible
  `<input type=file id=visible>` and a hidden one (`display:none`) behind a `<button>`, each
  writing `name:size:type` and `changed` into `#report-visible` / `#report-hidden` on `change`; a
  `#zone` 200×120 at a fixed position recording the event order and the dropped file into
  `#report-zone` (`dragenter,dragover,drop|name:size:type`), cancelling `dragover`; a same-origin
  `<iframe id=child>` at a fixed position whose document has the same zone reporting to the
  parent's `#report-child` via `parent.postMessage`. Fixture served by the existing server.
- [X] T341 Gate spec `tests/e2e/packaged/agent-upload-image.spec.ts` (Chromium attach recipe):
  1. `screenshot` → text block `imageId` + sentence; `upload_image {ref: visible}` →
     `#report-visible` = `screenshot.png:<decoded size>:image/png changed`; the same to the hidden
     input by ref (SC-093, 2/2);
  2. `upload_image {coordinate: zone centre}` → `#report-zone` order + file; `{ref: zone}` →
     same, answer `point` = centre; `{coordinate: inside child zone}` → `#report-child` (SC-094,
     3/3);
  3. unknown id → `unknown-image-id`; expired: use a host test hook or env
     `HALLPASS_SCREENSHOT_RETENTION_MS=1000` for the run → `(expired)`; evicted: env
     `HALLPASS_SCREENSHOT_BUDGET_CHARS` small enough that a second screenshot evicts the first →
     `(evicted)`; fixture reports unchanged after each (SC-095, 3/3 live; the foreign-session
     case is T327 f);
  4. site in `ask`: card visible with the summary, decline → input empty + `denied`; accept →
     uploaded; the panel activity list shows one `upload_image` line (SC-096);
  5. screenshot, kill the worker (`agent-panel-multi` recipe), `upload_image` → ok (SC-097);
     end the session, new session, old id → `unknown-image-id` (SC-097).
  Both env overrides are read by the cache factory only when set (default constants otherwise)
  and documented in the spec file header, not in the README.
- [X] T342 Run the gate: `npx playwright test tests/e2e/packaged/agent-upload-image.spec.ts` and
  the regression trio in `quickstart.md` §5; record numbers in `coverage.md`. **Gate 5/6 on
  Chromium 151, regression 8/8; the one red is F4 in `coverage.md` (a worker recycling clears the
  host's retention, FR-168 vs R-180) — an open decision, not a harness fault.** S4 decided it
  (R-184, a browser-run id on the pairing answer) and the re-run is **6/6** on the same Chromium,
  plus `agent-tabs` 1/1 for the handshake change; see `coverage.md` F4.
- [X] T343 [P] Documents: `README.md` (line 6 count 33, tool table row for `upload_image`,
  `screenshot` row mentions the id, a 0.5.0 note), `docs/zh-TW/operations-guide.md` (count, one
  paragraph: what is kept, for how long, where, and that it passes the site's consent),
  `docs/zh-TW/qa-guide.html` tool list, `docs/design-notes.md` §7 (image upload leaves
  "planned"; one paragraph on host-side retention and the two delivery forms). No reference
  identifier.
- [X] T344 `coverage.md` — FR-167..177 ↔ tests/gate steps ↔ SC-093..099, the review findings,
  the R-181 batch finding, what remains (T345, T346).
- [X] T345 Branded Chrome: run T341's spec against the owner's Chrome 153 through the attach
  recipe (as 012 T321); record the Chrome version and result in `coverage.md`. (main session)
- [X] T346 **Probe (paid, owner allowed 2026-09-22)**:
  `tests/acceptance/probe-004/scenarios/s13-upload-image.json` on the fixture — "Attach a picture
  of this page to the form on it, then tell me what the page shows next to the attachment field";
  assert a screenshot call followed by `upload_image` with that `imageId` and no `file_upload`;
  record model and outcome in `coverage.md` (SC-098). (main session)
- [X] T347 Final verification (the one planned): `npm run test`, `npm run test:contract`,
  `npm run snapshot:check`, `npm run typecheck`; tick everything; commit "Close feature 013
  implementation: coverage, final verification green". (main session)

## Not scheduled

- Uploading a recording by this path; owner-configurable retention (spec Out of Scope).
- `viewport` in the recording tool list; issues #1/#2 (owner's post-013 list).

## Dependencies

T324 → T325/T326 → S1 (T327 → T328 → T329 → T330 → T331) → S2 (T332 → T333 → T334 → T335 →
T336) → T337 → S3: T338, T339, T340, T343 in parallel; T341 after T340 and T339; T342 after
T341; T344 after T342; T345 and T346 after T342; T347 last.

## Implementation strategy

S1 alone changes nothing the owner sees except an id on screenshots; S2 makes the tool real;
S3 is proof and shipping. Stop after T337 if the review finds an isolation or gate hole; do not
proceed to the gate with a known one.

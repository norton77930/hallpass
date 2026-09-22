# Implementation Plan: Upload a Session Screenshot into a Page

**Branch**: `013-upload-image` (git: `feature-013-upload-image`) | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification; [research.md](./research.md) R-177–R-183; the private
reference evidence for 012 §3; the host, worker, content-runtime and contract sources read on
2026-09-22.

## Summary

The bytes stay where they already pass: the **host** (one `mcp-server` process per session)
mints an `imageId` when it builds the MCP image block for any screenshot answer, keeps the base64
in an in-memory cache with the spec's bounds (5 min, 8 MiB, oldest out, oversize not kept), and
intercepts `upload_image` exactly where it intercepts `file_upload` today — replacing the id with
`file: { name, type, bytesBase64 }` before the call crosses the link (R-177). The **worker** treats
the call as `file_upload`'s sibling: same ownership, same per-site gate, same prompt summary and
activity line, then one new content message that either sets the file on an `<input type=file>`
(sharing the existing code) or delivers a `dragenter`/`dragover`/`drop` sequence with the file at
a coordinate or an element's centre, descending one level into a same-origin frame (R-178). Three
slices: (1) contracts + host cache + interception; (2) worker + content delivery; (3) descriptions,
version 0.5.0, gate spec and fixtures, docs, branded-Chrome run and one paid probe. One
`code-reviewer` after S2.

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (host, contracts), MV3 extension (worker, content
runtime, panel); Vitest; Playwright for the packaged gate.

**Primary Dependencies**: none added. No CDP domain is needed: the delivery is DOM events in the
page through the content runtime, as `file_upload` is. **No new manifest permission** (FR-174).

**Storage**: none in the browser. Host memory only (`screenshot-cache.ts`), dropped on session
end, link loss and unpair (R-180).

**Testing**: unit (cache: TTL, budget, eviction order, oversize, unknown-vs-gone, issued-set
bound; host reply: id present, sentence present, oversize sentence; worker: gate parity, ref vs
coordinate routing, refusal mapping; content: input path, drop path, event order and payload,
frame descent, outside-viewport, cross-origin refusal), contract (tool count 33, shapes,
descriptions, batchable parity, no new permission, snapshot), packaged gate
`agent-upload-image.spec.ts` on Chromium in attach mode, one branded-Chrome run, one paid probe.

**Target Platform**: Windows 11, Chrome / Chromium 151+.

**Project Type**: browser extension + local host.

**Constraints**: the native-messaging frame bound (700 000 base64 chars) equals the upload bound,
so any retained screenshot fits by construction. Link protocol number unchanged: the new tool is
absent from an older offering; the text block's new fields are ignored by an older client.

**Scale/Scope**: contracts (1 tool: agent-facing and worker-facing shapes, 1 result schema, 3
descriptions touched, batchable list, 33), host (1 new module ≈ 120 lines, `toolReply` + 1
interception ≈ 60 lines), worker (`upload.ts` second tool ≈ 120 lines, content broker 1 message,
content runtime `files.ts` ≈ 150 lines, summaries + recording list + locales), 1 gate spec + 1
fixture page, 4 documents, 1 probe scenario.

## Constitution Check

| Principle | Status |
| --- | --- |
| I. PR as source of truth | PASS. PR-006 (screenshots) and PR-009 (files into a page); design-notes §7 lists image upload as planned. |
| II. Clean-room | PASS. Behaviour read from one bundle and recorded privately; the design differs (host-side retention, shared input path, no custom event, own answer strings). No identifier from the reference in any artifact. |
| III. Traceability | PASS. FR-167..177 ↔ US1–US4 ↔ SC-093..099; tasks cite them. |
| IV. Explicit uncertainty | PASS. No measurement was needed; R-181's batch parity is a read-and-confirm item for S2, recorded either way. |
| V. Least privilege | PASS. No new permission; nothing new is read from disk; the upload passes the same consent as every effect. |
| VI. Privacy | PASS. The bytes already reach the host today; they are now kept 5 minutes in that process and nowhere else; the panel and other sessions cannot read them; the activity line carries an id and a target, not the picture. |
| VII. Observable | PASS. SC-093..099 are counts on fixtures and one probe. |
| VIII. MV3 | PASS. Nothing in the worker outlives a call. |
| IX. Requirements before architecture | PASS. |
| X. Dependency discipline | PASS. |
| XI. Defined failure | PASS. unknown / gone (expired, evicted, oversize) before the browser is touched; not-a-drop-target, point-outside-viewport, not-reachable, both-or-neither, ownership, restricted page, consent declined, stale target. |
| XII. Specification before implementation | PASS. |

## Project Structure

### Documentation (this feature)

```text
specs/013-upload-image/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/upload-image.md            # the tool, the screenshot text block, the worker result
├── checklists/requirements.md
└── tasks.md                             # /speckit-tasks
docs/design-notes.md §7                  # public summary (image upload: planned → shipped)
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts             # `upload_image` agent shape (imageId, ref|coordinate, filename?) + worker schema (file) + result; descriptions (upload_image, file_upload, screenshot, computer); batchable list; 33
packages/agent-host/src/
├── screenshot-cache.ts                           # NEW: pure cache (put/take/sweep/evict/issued set), injectable clock + id source
└── mcp-server.ts                                 # toolReply: mint id + text fields; upload_image interception beside file_upload; cache drop on link loss / unpair / end
apps/extension/src/
├── service-worker/agent-tools/upload.ts          # handles `upload_image` beside `file_upload`: ownership, gate, ref → discoverRefFrame → frame; coordinate → top frame
├── service-worker/agent-tools/summaries.ts       # prompt/activity summary for upload_image
├── service-worker/content-broker.ts              # deliverImageOnTab → "content.deliver-image"
├── content-runtime/index.ts                      # route "content.deliver-image"
├── content-runtime/files.ts                      # deliverImage: resolve (handle | point, one-level frame descent), input path (shared with setFilesOnTarget, no accept refusal), drop path (dragenter/dragover/drop), answer
├── service-worker/recording (008 effect list)    # + upload_image
├── side-panel locales                            # tool name strings if rendered
└── build-config.ts                               # 0.5.0
packages/agent-host/src/tool-offering.ts          # SERVER_VERSION 0.5.0
tests/harness/page-fixtures.ts                    # + upload-image fixture (visible + hidden input, drop zone with event order, same-origin child frame zone)
tests/e2e/packaged/agent-upload-image.spec.ts     # NEW gate spec
tests/contract/agent-tools-013.contract.test.ts   # NEW; 008/012 count assertions → 33
tests/acceptance/probe-004/scenarios/s13-upload-image.json
README.md · docs/zh-TW/operations-guide.md · docs/zh-TW/qa-guide.html · docs/design-notes.md
```

**Structure Decision**: no new worker module; `upload.ts` already is "place bytes the host
vetted into the page under the effect gate", and the second tool is that with a different origin
of bytes and a second delivery form. The only new module is the host cache, kept pure so its rules
are unit-tested without a process.

## Slice ordering

| Slice | Content | Closes | Writer | Evidence |
| --- | --- | --- | --- | --- |
| **S1** | contracts (agent shape, worker schema, result, 33, batchable parity, descriptions placeholder text); `screenshot-cache.ts` (RED first on: TTL expiry, oldest-first eviction to fit, oversize not stored, unknown vs gone reasons, issued-set bound, per-instance isolation); `mcp-server.ts` `toolReply` mints `imageId` + `upload` sentence (RED on: id present on screenshot and computer-screenshot replies, oversize sentence), `upload_image` interception (RED on: unknown/gone denied before send, ok replaces `imageId` with `file`, default filename `screenshot.png`), cache drop on link loss / unpair / end | FR-167, FR-168, FR-169 (shape), FR-172, FR-175 | implementer | unit + contract |
| **S2** | `upload.ts` second tool (RED on: gate parity with file_upload incl. prompt summary and activity, ref → frame discovery, coordinate → top frame, both/neither refused by schema, result mapping incl. `not-a-drop-target`, `point-outside-viewport`, `not-reachable`); `content-broker.ts` + `content-runtime/index.ts` routing; `files.ts` `deliverImage` (RED on: input path sets one file and fires input+change and reads back, no accept refusal, drop path dispatches dragenter/dragover/drop in order with one File and client coordinates, element-centre for a ref, one-level same-origin descent with shifted point, cross-origin → not-reachable, nested frame → not-reachable, outside viewport → refusal naming WxH); recording effect list; summaries + locales | FR-169, FR-170, FR-171, FR-173, FR-174 | implementer | unit, then **code-reviewer** over S1+S2 (base64→File across realms, eviction and budget arithmetic, gate parity, cross-session isolation claims — invisible to a live run) |
| **S3** | descriptions (FR-176) + contract test; version 0.5.0 (R-183); fixture page + gate spec (SC-093..097: visible + hidden input; drop by coordinate, by ref, into a child frame; unknown / expired / evicted refusals; ask-mode card + decline; activity line; worker kill between screenshot and upload; session end); docs (README, zh-TW ops guide, QA guide tool list, design notes §7); `coverage.md`; branded-Chrome run of the gate; **probe** `s13-upload-image` (paid, owner allowed 2026-09-22) | FR-176, FR-177; SC-093..099 | implementer (gate spec, fixtures, docs), main session (version, branded run, probe, coverage) | gate + contract + probe |

S1 → S2 → S3. The review after S2 is the one review of the feature (risk axis: data conversion
and cross-module state; the rest is visible on the gate).

## Complexity Tracking

No constitution violation.

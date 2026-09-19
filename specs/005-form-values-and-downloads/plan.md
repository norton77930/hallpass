# Implementation Plan: Form Values in the Read, and Download Reporting

**Branch**: `005-form-values-and-downloads` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-form-values-and-downloads/spec.md`

## Summary

Two small additions to the local-agent path, each a read of something the browser already knows.
(1) **Field state in the read** — the content-runtime collector, behind the gate that already separates
agent-only node fields from the archived remote path, emits a control's current value / checked state,
with the reference's redaction list applied inside the page and never crossing to the worker (R-122).
(2) **Download reporting** — the agent build gains the `downloads` permission and a worker-side observer
that attributes each browser download to the sessions holding tabs at that moment, keeps a bounded
per-session record in session storage, answers a new `downloads_context` tool, and satisfies a new
worker-evaluated `wait` condition `download-complete` (R-123, R-124). The narrow build stays byte-identical
(R-121 carried over). Verification is the 004 standard: unit + contract for shape, the packaged attach gate
for behaviour on the owner's Chrome, and two new probe scenarios for the report.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node 24, strict, unchanged.
**Primary Dependencies**: none added.
**Storage**: `chrome.storage.session` gains `agentDownloads` (per-session ring, newest first, bound 20,
plus a per-session watermark for `download-complete`). Nothing in `storage.local`.
**Permissions**: `downloads` added to `AGENT_PROFILE_PERMISSIONS` only (`apps/extension/src/build-config.ts`).
**Testing**: vitest unit (`apps/extension/tests`), contract (`tests/contract`), packaged attach gate
(`tests/e2e/packaged/agent-*.spec.ts`, `HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222`), probe-004 harness with new
scenarios `s7-form-values.json`, `s8-download.json`.
**Target Platform**: branded Chrome 152, MV3.
**Constraints**: the remote path's `collectPage` answer and the narrow manifest are unchanged
(SC-041); no extension-initiated download API call other than the two listeners (FR-076).

## Constitution Check

*GATE: evaluated before implementation. Result: PASS.*

| Article | Assessment |
| --- | --- |
| I. Product requirements | PASS. FR-072–075 trace to PR-004; FR-076–080 to PR-020; owner decisions D-005-1–3 precede this plan. |
| II. Clean-room | PASS. Reference identifiers stay in `docs/design-notes.md` §6; the redaction list is a behaviour (which autocomplete tokens hide a value), designed as our own predicate. |
| III. Traceability | PASS. Spec table; design-notes §6. |
| IV. Explicit uncertainty | PASS. The download record's lack of a tab id is stated; attribution by session liveness is the declared rule, and shared attribution is reported, not hidden. |
| V. Least privilege | PASS. One new permission (`downloads`), agent build only, traced to two listeners; every mutating download API is forbidden by FR-076 and asserted by a test that the adapter exposes only `onCreated`/`onChanged`. |
| VI. Privacy, consent, data minimisation | PASS. Values are shown only for a held tab (a read already requires the lease); the reference's redaction list is applied in the page so a redacted value never reaches the worker; download records carry the browser's record fields only, bounded and discarded with the session. |
| VII. Observable and testable | PASS. SC-039–043 are counts and presence checks on named pages. |
| VIII. MV3 | PASS. `chrome.downloads` events are MV3-safe; the worker re-reads its ring from session storage after eviction. |
| IX–XII | PASS. Spec → plan → tasks → source; no dependency; failure outcomes named (`bound-reached`, `failed`, `canceled`, `shared`). |

## Project Structure

```
apps/extension/src/content-runtime/collector.ts        field state behind the all-controls gate (R-122)
apps/extension/src/content-runtime/field-state.ts       NEW: pure `fieldState(el)` + redaction predicate
apps/extension/src/service-worker/agent-tools/reads.ts  projectNodes passes value/checked/redacted/valueTruncated
apps/extension/src/service-worker/download-observer.ts  NEW: listeners, attribution, per-session ring (R-123)
apps/extension/src/service-worker/agent-tools/wait.ts   `download-complete` branch, worker-evaluated
apps/extension/src/service-worker/agent-tools/downloads.ts NEW: `downloads_context` (R-124)
apps/extension/src/service-worker/agent-tab-manager.ts  `sessionsHoldingAnyTab()`; endSession discards the ring
apps/extension/src/build-config.ts                      AGENT_PROFILE_PERMISSIONS += "downloads"
packages/contracts/src/agent-tools.ts                   node fields; WAIT_CONDITIONS; downloads_context schemas
packages/agent-host/src/mcp-server.ts, prompts           tool registration + description
tests/contract/agent-*.contract.test.ts                 updated exact lists
tests/e2e/fixtures/pages/form-values.html               NEW fixture (password, cc-number, select, textarea)
tests/e2e/fixtures/pages/download.html                  NEW fixture (`<a download>` to a served blob)
tests/e2e/packaged/agent-form-values.spec.ts            NEW
tests/e2e/packaged/agent-downloads.spec.ts              NEW
tests/acceptance/probe-004/scenarios/s7-form-values.json, s8-download.json  NEW
```

## Research / design decisions

- **R-122 Field state is computed in the page, behind the existing agent gate.** `collectPage` already
  emits `href/type/placeholder/options` only when `mintPolicy === "all-controls"`; `value`, `checked`,
  `redacted`, `valueTruncated` join that branch. The predicate `isRedactedField(el)` is a pure function
  in a new `field-state.ts` (type `password`/`hidden`; autocomplete tokens for current/new password,
  one-time code, card number/csc/expiry incl. month/year), unit-tested against a jsdom table. A redacted
  field's value is never read into the message (the predicate runs first). `value` for a `select` is the
  selected option's text (multiple: joined by `", "`); for a textarea the raw text with line breaks; cut
  at `DEFAULT_BOUNDS.maxLabelChars` with `valueTruncated: true`. `checked` for checkbox/radio only;
  toggles never carry `value`.
- **R-123 Downloads are observed by a worker module with two listeners and one rule.** The record has no
  tab id, so attribution is "which sessions hold ≥ 1 tab right now" (a new tab-manager query). On
  `onCreated` the item is written to every such session's ring (`attribution: "session" | "shared"`); a
  created item with no holder is dropped. `onChanged` updates `filename`, `state`, bytes on every ring
  that holds the id. Ring bound 20, newest first, `chrome.storage.session`, serialized through the same
  queued-write pattern as the 004 diagnostics rings. `endSession` deletes the ring. The adapter exposes
  only `onCreated`/`onChanged`; a test asserts no other `chrome.downloads` member is referenced in
  `src/service-worker/**`.
- **R-124 `download-complete` is worker-evaluated and watermarked.** Unlike the four element conditions,
  it never asks the page. Per session the ring stores `waitWatermark` (initially the ring's creation
  time). The condition holds when the newest attributed record is terminal (`complete | failed |
  canceled`) and its terminal time is later than the watermark; answering the wait moves the watermark
  to now. This makes "click, then wait" correct even when a small file finishes before the wait begins,
  while a download answered once is never answered twice. `bound-reached` and `owner-stopped` are
  unchanged.
- **`downloads_context`** is a read that needs no lease (like `tabs_context`), returns the ring as-is.
- **MCP surface**: 28 → 29 tools; the contract test's exact list, the arg-schema map and the prompt
  description are updated together.

## Slice ordering

| Slice | Delivers | Closes |
| --- | --- | --- |
| **S1** | field-state predicate + collector branch + projection + contract fields + fixture + e2e + probe s7 | US1, FR-072–075, SC-039–041 |
| **S2** | permission + observer + tab-manager query + ring + `downloads_context` + wait condition + contracts + fixture + e2e + probe s8 | US2, FR-076–080, SC-042–043 |

S1 first: no permission change, and it exercises the collector gate that SC-041 protects. Each slice
ends green on unit + contract + the attach family; the probe scenarios run once at the end of the feature.

## Complexity Tracking

No constitution violation requires justification. One new permission, agent profile only, observe-only.

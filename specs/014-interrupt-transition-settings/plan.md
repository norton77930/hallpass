# Implementation Plan: Interrupt a Step, Confirm a Site Transition, Ask Before Uploading From a New Directory

**Branch**: `014-interrupt-transition-settings` (git: `worktree-feature-014-interrupt-domain-settings`) | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification; [research.md](./research.md) R-185–R-190; the private
reference evidence for 014 §1–§4; the worker, panel, contracts and host sources read on
2026-09-22.

## Summary

Three consent-shaped changes and three small honesty items, all inside protocol 2 (additive
frames and fields only). **Interrupt** (R-185): the stop registry gains a reason; the runtime's
call dispatcher races each runner against its handle and answers within a second with
`stopped / owner-interrupted` and a hint the agent can act on, discarding the late result; the
session keeps everything; the panel gets 中斷 beside 停止. **Site transitions** (R-186): a new
pure module tracks, per held tab, the origins the session has been on and a pending A→B set by
the existing `tabs.onUpdated` signal under six ordered rules (loopback, known, decided site,
allowed pair, named navigate, else pending); the dispatcher asks on the next call to that tab
with a new prompt kind, reads included; pairs persist in `storage.local` and are revocable as
rows in the panel's site list. **Upload directories** (R-187): the host, on `outside-roots`
only and only when the worker advertised the capability on `pair-result`, sends a new control
frame asking the worker to raise a card with the full paths; once / always / deny come back on
a second new frame; `always` is written to the host's config through one atomic store that the
relay also uses to list and remove roots for the panel's rows. **Tails** (R-188): activity line
for `file_upload`, delivery form on the `upload_image` card, `viewport` recorded. Four slices,
`code-reviewer` after S2 and S3, one paid probe, branded-Chrome run at the end.

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (host, contracts), MV3 extension (worker, panel
React); Vitest; Playwright for the packaged gate.

**Primary Dependencies**: none added. Navigation detection uses `chrome.tabs.onUpdated`, already
in use; **no new manifest permission** (FR-195; `webNavigation` is deliberately not added).

**Storage**: `chrome.storage.session` for per-tab transition state (survives worker recycling,
dies with the browser); `chrome.storage.local["agentTransitionAllowances"]` for persisted pairs
(origins and timestamps only); the host's `config.json` for upload roots (unchanged file, new
writers through one store module). Nothing new is written by the page or the host about page
content.

**Testing**: unit (stop reason + dispatcher race + late-result discard + marker-aware hint;
transition rules table; storage round-trips; prompt kinds and decisions; host consent flow with
a fake link, config store atomicity and merge; policy `allowFiles`), contract (frames additive,
prompt kinds, panel state fields, tool count 33, descriptions, no new permission, no MCP request
touching roots), packaged gate (`agent-interrupt.spec.ts`, `agent-transitions.spec.ts`,
`agent-upload-directory.spec.ts`, tails folded into existing recording/upload specs) on
Chromium in attach mode with the unattended recipe, one branded-Chrome run, one paid probe
(SC-107).

**Target Platform**: Windows 11, Chrome / Chromium 151+.

**Project Type**: browser extension + local host.

**Constraints**: link protocol number unchanged (2); every new frame type is unknown-and-dropped
by an old side and every new field is optional; the old-host and old-worker cases are stated
per feature (R-185 none; R-186 `notice` falls back to `hint`; R-187 feature flag). Interrupt
answer bound 1 s (SC-100). Transition and directory cards obey the 011 waiting rules.

**Scale/Scope**: contracts (+2 control frames, +1 link frame pair, +2 prompt kinds, +3 prompt
fields, +2 panel state fields, +2 panel messages, +1 decision field, 3 descriptions, reasons);
worker (`stop.ts` +reason ≈ 30 lines, dispatcher race ≈ 80, `transitions.ts` NEW ≈ 200 + store
≈ 60, runtime wiring ≈ 120, `upload.ts` delivery field ≈ 10, activity + recorded list ≈ 20,
bridge frames ≈ 60); panel (`SessionCard` button, `PromptCard` two kinds, `SiteList` two row
kinds, locales ≈ 30 keys); host (`upload-config-store.ts` NEW ≈ 80, `upload-policy.ts`
`allowFiles` ≈ 20, `mcp-server.ts` consent flow ≈ 120, relay list/remove ≈ 60); 3 gate specs +
fixtures (redirect page, second fixture origin or the test switch), 1 probe scenario, docs.

## Constitution Check

| Principle | Status |
| --- | --- |
| I. PR as source of truth | PASS. PR-007 (stop), PR-008 (consent on cross-origin transition: "page or origin changes after approval: re-evaluate before continuing"), PR-019 (review/revoke), PR-020 (local agent). The settings page of one reference was **not** adopted (D-014-3). |
| II. Clean-room | PASS. Behaviour read from bundles and recorded privately; own module shapes, own frame names, own wording; identity is origin (not the reference's hostname); decline keeps the session (not the reference's stop). |
| III. Traceability | PASS. FR-178..199 ↔ US1–US5 ↔ SC-100..108; tasks cite them; spec's table records the not-adopted reference features. |
| IV. Explicit uncertainty | PASS. Two measurements named before design is trusted: R-186 §6 (loopback test switch vs second origin) and R-187 §6 (frame schema strictness); each has its fallback written down. |
| V. Least privilege | PASS. No new permission; the upload allow-list can only grow by the owner's hand on a card and only through the extension link; the agent has no request that reads or changes it (contract-pinned). |
| VI. Privacy | PASS. Persisted: origin pairs + timestamps; directories; nothing about pages. File paths appear on the panel card only, never in a page, a site, a recording frame or the activity line (the line names "an upload into an input", not the path). |
| VII. Observable | PASS. SC-100..108 are counts on fixtures and one probe. |
| VIII. MV3 | PASS. Per-tab state in session storage; no worker-lifetime assumption. |
| IX. Requirements before architecture | PASS. |
| X. Dependency discipline | PASS. |
| XI. Defined failure | PASS. Interrupt with nothing in flight; effect already delivered; late result; interrupt during a card; transition declined / not answered / while a batch runs / tab released / several commits; directory once / always / deny / timed-out / old host / old worker / invalid path / hand-edited file; host unreachable for a revoke. |
| XII. Specification before implementation | PASS. Owner decisions D-014-1..6 taken 2026-09-22. |

## Project Structure

### Documentation (this feature)

```text
specs/014-interrupt-transition-settings/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md
├── contracts/interrupt.md               # reason, hint, dispatcher race, panel message
├── contracts/transitions.md             # rules, prompt kind, decision, storage, notice, panel rows
├── contracts/upload-directory.md        # control frames, feature flag, reasons, relay list/remove, store
├── checklists/requirements.md
└── tasks.md                             # /speckit-tasks
docs/design-notes.md §3                  # public summary (interrupt, transition, directory question)
(the private reference evidence for 014, export-ignored, already written)
```

### Source Code (repository root)

```text
packages/contracts/src/agent-tools.ts
  # reasons: owner-interrupted, site-transition-declined, site-transition, upload-declined,
  #   upload-not-answered, upload-outside-allowed-directories
  # AGENT_PROMPT_KINDS + "transition", "upload-directory"; AgentEffectPrompt + transition?, files?, delivery?
  # PromptDecision/effect-decide + rememberTransition?; panel state + transitions[], uploadRoots?
  # control frames: upload-consent-request (host→worker), upload-consent-result (worker→host)
  # link frames: upload-roots-list (worker→relay), upload-roots (relay→worker), upload-roots-remove (worker→relay)
  # pair-result + features?: ["upload-consent"]; response frame + notice? (or hint, R-187 §6)
  # panel messages: ui.agent.session-interrupt, ui.agent.transition-clear, ui.agent.upload-root-clear
  # descriptions: file_upload, navigate, click (one sentence each)
apps/extension/src/service-worker/
├── agent-tools/stop.ts                  # reason on the flag; interruptSession(sessionId); handle.reason()
├── agent-tools/transitions.ts           # NEW: rules (loopback, known, decided, allowed, named, pending), per-tab state, session/persisted allowances
├── transition-store.ts                  # NEW: storage.session (pending/known per session+tab) + storage.local (allowances)
├── agent-tools/prompts.ts               # decision "interrupted"; kinds transition / upload-directory
├── agent-tools/batch.ts                 # stop-before-step on pending transition; interrupted report
├── agent-tools/tabs.ts                  # navigate registers requested origin (expectation) before it moves
├── agent-tools/upload.ts                # delivery field on the upload_image card
├── agent-runtime.ts                     # dispatcher race + late-result discard + marker-aware hint; tab-update feed → transitions; ask before tab calls; notice on the causing call; interruptSession; noteUpload for both tools; RECORDED_TOOLS + viewport; projection: inFlight, transitions, uploadRoots
├── agent-bridge.ts                      # upload-consent-request → runtime; upload-consent-result; upload-roots-list/remove; upload-roots → runtime; features on pair-result
├── agent-panel-port.ts                  # session-interrupt, transition-clear, upload-root-clear, effect-decide.rememberTransition
└── recording overlay label              # viewport WxH / cleared
apps/extension/src/side-panel/agent/
├── SessionCard.tsx                      # 中斷 button (enabled by inFlight), interrupt activity line
├── PromptCard.tsx                       # kinds transition (繼續 / 一律允許 / 拒絕) and upload-directory (這次 / 以後都可以 / 不准); upload_image delivery sentence
└── SiteList.tsx                         # sections: sites / transition pairs (last used, revoke) / upload directories (revoke)
apps/extension/src/locales/{en-US,zh-TW}.ts
packages/agent-host/src/
├── upload-config-store.ts               # NEW: read-merge-write, temp+rename, validation (absolute, existing directory)
├── upload-policy.ts                     # allowFiles parameter; refusal code reaches the reason for outside-roots
├── mcp-server.ts                        # consent flow on outside-roots when the worker advertised the feature; reasons; notice → text
├── relay-mux.ts / native-host.ts        # upload-roots-list / remove → store → upload-roots
└── tool-offering.ts                     # SERVER_VERSION 0.6.0; descriptions
apps/extension/src/build-config.ts       # 0.6.0
tests/unit/**                            # stop reason, dispatcher race, transitions rules, stores, host consent flow, config store
tests/contract/agent-tools-014.contract.test.ts   # NEW; counts 33; additive frames; no roots request in the MCP surface
tests/harness/page-fixtures.ts           # + redirect page (A → B), second origin or test switch (R-186 §6)
tests/e2e/packaged/agent-interrupt.spec.ts · agent-transitions.spec.ts · agent-upload-directory.spec.ts   # NEW
tests/acceptance/probe-004/scenarios/s14-transition.json
README.md · README.zh-TW.md · docs/zh-TW/operations-guide.md · docs/zh-TW/qa-guide.html · docs/design-notes.md
```

**Structure Decision**: one new worker module (`transitions.ts`, pure rules so the six-rule
table is unit-tested without a browser) and one new host module (`upload-config-store.ts`, the
single writer of the config file). Interrupt lives in the existing stop registry and the
dispatcher; the directory question lives where the policy already is (the host's interception).
No new panel view: two new card kinds and two new row kinds.

## Slice ordering

| Slice | Content | Closes | Writer | Evidence |
| --- | --- | --- | --- | --- |
| **S1 interrupt** | `stop.ts` reason + `interruptSession` (RED: flag reason, session scope, batch step ids); dispatcher race in `agent-runtime.ts` (RED: answers within bound with `owner-interrupted` + hint; marker present → "may have taken effect" hint; late result discarded + logged; nothing in flight → no-op); prompts `interrupted` decision + card withdrawal; batch report + plan clear; panel `ui.agent.session-interrupt`, `inFlight` in projection, 中斷 button, activity line, locales; contracts (reason, message); gate `agent-interrupt.spec.ts` (SC-100, SC-101: wait, batch at step 3, card withdrawn, worker-kill race, following click succeeds, group/viewport/recording unchanged) | FR-178..184 | implementer | unit + gate |
| **S2 transitions** | contracts (kinds, fields, decision, storage shapes, reasons, notice-or-hint per R-187 §6 measurement done first); `transitions.ts` + store (RED: the six rules in order, collapse, return-to-known, release drops, session vs persisted allowance, lastUsed touch); runtime feed from `watchTabUpdates`, seed on claim/create, navigate expectation, ask-before-tab-call for every tab tool, batch stop-before-step, notice on the causing call; panel card kind + `rememberTransition`, `SiteList` pair rows + `transition-clear`; test switch for loopback (R-186 §6) or second origin; fixtures (A with a link to a redirect that lands on B; B undecided) + gate `agent-transitions.spec.ts` (SC-102, SC-103) | FR-185..190, FR-191/192 (pair rows) | implementer, then **code-reviewer** (consent surface: rule order, storage keys, per-tab scope, batch interaction, honesty of the causing call) | unit + gate + review |
| **S3 upload directory** | strictness measurement (R-187 §6, first task); contracts (2 control frames, 3 link frames, `features` on pair-result, reasons, prompt kind + `files`, panel `uploadRoots`, messages); host `upload-config-store.ts` (RED: atomic write, merge, validation, malformed file → empty), `upload-policy.ts` `allowFiles` + code → reason, `mcp-server.ts` consent flow with a fake link (RED: once / always / deny / timed-out / interrupted / no-feature → 0.5.0 refusal / other codes unchanged); relay list/remove; worker bridge + runtime card + result frame + roots for projection; panel card kind + `SiteList` directory rows + `upload-root-clear`; contract: no MCP request touches roots; fixtures (private host data dir, temp directory) + gate `agent-upload-directory.spec.ts` (SC-104 directory half, SC-105) | FR-191/192 (directory rows), FR-193..195 | implementer, then **code-reviewer** (file-access allow-list: path canonicalisation, prefix containment, temp+rename, two writers, feature-flag gating, that no agent path can reach the store) | unit + contract + gate + review |
| **S4 tails + release** | `noteUpload` for both tools, `delivery` on the card + locale keys, `viewport` recorded with label (RED each); descriptions + contract test; version 0.6.0 (R-189); FR-195 wording (R-190); docs (README ×2, zh-TW guides, design notes §3); `coverage.md`; branded-Chrome run of the three gates + regression; probe `s14-transition` (SC-107); 功能拆解 artifact refresh (012/013/014, corrected row, 設定頁 → 刻意不做) | FR-196..199, SC-106..108 | implementer (tails, descriptions, docs), main session (version, branded run, probe, artifact, coverage) | unit + contract + gate + probe |

S1 → S2 → S3 → S4. S1 and S2 touch the dispatcher; S2 goes second so its ask-before-call sits
on the raced dispatcher. The two reviews are the risk-axis reviews of the feature (a new consent
surface each); everything else is visible on the gate.

## Completion Contract

- **Scope**: FR-178..199; non-goals per spec Out of Scope (no settings page, no read gating in
  general, no sub-frame transitions, no pairing change).
- **Claims and evidence**: interrupt (unit + gate SC-100/101); transitions (unit + gate SC-102/103
  + review); directory (unit + contract + gate SC-104/105 + review); tails (unit + gate SC-106);
  probe SC-107; final verification SC-108.
- **Pre-selected roles**: implementer ×4 slices; code-reviewer after S2 and after S3; no
  architecture review (no exposed interface changes shape; frames are additive).
- **Final verification (one)**: `npm run typecheck && npm run test:unit && npm run test:contract
  && npm run snapshot:check` green, then the three new gates + regression on the owner's branded
  Chrome, numbers into `coverage.md`; then report.

## Complexity Tracking

No constitution violation.

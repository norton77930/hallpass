# Coverage: Consent per Site for Embedded Frames

Written 2026-11-07 for tasks T885-T907. Test paths are relative to the repository root; unit files sit in
`apps/extension/tests/` unless a path says otherwise. "Packaged" means
`tests/e2e/packaged/agent-frame-consent.spec.ts` (the T905 gate, Story rows of the quickstart).
Nothing here was run for this document: the run results are recorded under "Runs" at the bottom, and are
empty until T906 has been done.

## Requirements

| Requirement | Tasks | Evidence |
| --- | --- | --- |
| FR-450 (decided by the site of the frame that holds the target; the top site only for the top frame or an inheriting frame) | T892, T894, T895, T897, T898 | `agent-effects.test.ts` "030 pre-gate claim" ("finds the frame before the gate without scrolling...", "gives the gate the frame site's mode and plan...", "runs a click in a frame whose own site is skip-checks while the page's site asks"); `agent-batch.test.ts` "030 a batch step in another site's frame"; `agent-upload.test.ts` "030 upload into a frame from another site"; `computer.test.ts` "030 a coordinate action is decided by the frame under its point"; packaged Story 1, Story 2; `agent-input.spec.ts` (the click and the typing into the other-site child answer that frame's card) |
| FR-451 (the site is the browser's sender origin; the frame's own report is never consulted, for coordinates too) | T889, T891, T897, T899 | `frame-site.test.ts` "030 decideFrameSite" ("gives the sender's site when the body claims the page's site", "never reads the message body"); `frame-sender-probe.test.ts` "030 frame sender probe" (3); `agent-effects.test.ts` "T899 a frame's own report never decides" (3); `frame-site.test.ts` "030 resolvePointSite hit-test walk" ("decides a sandboxed frame by its opaque sender origin, never by its securityOrigin", nonce read-back); packaged Story 3 |
| FR-452 (`about:blank` and inline frames take the holder's site; sandboxed or unestablished is unknown) | T889, T897, T899 | `frame-site.test.ts` "030 decideFrameSite" (srcdoc, about:blank, sandboxed, missing/empty/non-web sender origin); "hit-test walk" ("gives a srcdoc frame its holder's site from the sender..."); `agent-effects.test.ts` "asks with frame unknown when the browser gives the frame an opaque origin..."; packaged Story 3 (sandboxed unknown; srcdoc and about:blank follow the page) |
| FR-453 (full origin: scheme, host, port) | T889 | `frame-site.test.ts` "matches by full origin: another port, host, scheme or subdomain is another site", "canonicalises the sender origin before comparing"; the second-site fixture is another host name in the packaged gate; `agent-input.spec.ts` (a child on another port is another site) |
| FR-454 (ref actions in a child frame, `browser_batch` steps, `file_upload`, `upload_image`) | T892, T894, T895 | `agent-effects.test.ts` "030 pre-gate claim"; `agent-batch.test.ts` "asks for the frame's site at that step, while the earlier step on the page's site runs"; `agent-upload.test.ts` "030 upload into a frame from another site" (8); packaged Story 1. Tool-by-tool: click is exercised in the unit and packaged gates; `type` in Story 1 and `agent-input.spec.ts`; `drag` and `hover` by point in `agent-effects.test.ts` "asks for a drag whose point endpoints are over the frame, and a hover over it". **Gap**: no 030 test names `double_click`, `triple_click`, `right_click` or `key` in a frame; they share the one gated path (see Gaps) |
| FR-455 (coordinate action: the innermost frame under the point; unfindable is unknown) | T897, T898 | `frame-site.test.ts` "030 resolvePointSite hit-test walk" (22: top, same-process frame, out-of-process descent with the shifted point, two processes, whole pixels, nonce, every failure gives unknown, bound); `computer.test.ts` "030 a coordinate action is decided by the frame under its point" (8, incl. "asks about a frame whose site cannot be established..."); `agent-effects.test.ts` "T898 a point target is decided by the frame under it" (4); `agent-upload.test.ts` "030 a drop point is decided by the frame under it" (6); packaged Story 2 |
| FR-456 (`form_input` and `evaluate` stay top-frame only, consent unchanged) | none | **Gap**: no 030 test. The existing `form_input` suites in `agent-effects.test.ts` are unchanged (their T906 run is owed); nothing asserts that these two tools do no frame lookup |
| FR-457 (the card names both sites; Allow once, Allow always, Refuse apply to the frame's site only) | T893, T896 | `prompt-card.test.tsx` "030 frame card" ("names the frame's site and the page, and the answers are for the frame's site"), "030 upload frame card" (4); `agent-effects.test.ts` "stores Allow always for the frame's site and leaves the page's site as it was (T893)"; `agent-upload.test.ts` "stores Allow always under the frame's site and leaves the page's mode as it was"; contracts `packages/contracts/src/agent-tools.test.ts` "030" ("frame takes a site or unknown: true"); packaged Story 1, Story 1.3 |
| FR-458 (unknown: say so, no Allow always) | T887, T896, T899, T900 | `prompt-card.test.tsx` "says the frame's site is unknown, names the page, and offers no Always allow", "says an upload's frame site is unknown and offers no Always allow"; `agent-effects.test.ts` "refuses an answer to an unknown-site card that asks to remember a mode: nothing stored, nothing sent"; `agent-upload.test.ts` "asks about a frame whose site could not be established, and stores nothing for it"; packaged Story 3 |
| FR-459 (a plan covers only its own site) | T904 | `site-mode-gate.test.ts` "030 a plan covers only its own site" (2); `agent-batch.test.ts` "asks at the frame's step though the owner approved the top site's plan naming it", "runs the frame's step without a card when its site was approved as follow-a-plan with its own plan"; packaged Story 6 |
| FR-460 (re-read the frame's site right before the gesture; mismatch cancels, nothing reaches the page, agent told) | T901 | `agent-effects.test.ts` "T901 the frame re-check right before the gesture" (5); "cancels with the frame-moved answer when the delivery claim lands in another frame...", "...in the same frame but another document"; `computer.test.ts` (4 "cancels..." cases and "runs an unchanged frame's action exactly once"); `agent-upload.test.ts` "cancels with the frame-moved answer when the claim after the gate lands in another document or frame", "cancels when the browser names another document or site for the frame after the gate", "cancels with the frame-moved answer when the frame changed after the answer, and drops nothing"; `frame-site.test.ts` "030 sameDecidingSite" (2); packaged Story 4 |
| FR-461 (refused or cancelled names the site and one reason) | T890, T893, T901 | `agent-site-recheck.test.ts` "030 frame answers" (8: each reason, four distinct texts, `FrameMovedBeforeDispatch`, the existing site-moved texts unchanged); `agent-effects.test.ts` "delivers nothing on Refuse or on no answer, and names the frame's site (T893)"; `agent-upload.test.ts` "answers a refusal and a timeout with the frame's site and the reason, and writes nothing"; packaged Story 4 |
| FR-462 (`read_page` names each frame's site; nodes and `find` matches from another site are marked; reads stay ungated) | T887, T902 | `frame-merge.test.ts` "030 frame sites in the merge" (4); `frame-read-wiring.test.ts` "030 read labels" (4); contracts "030" (read_page frame requires site; node and find site optional); packaged Story 5. "Reads stay ungated": no read test raises a card, and Story 5 answers without one |
| FR-463 (`propose_sites` accepts a frame's site; approval stores it as for any site) | T903, T904 | `tests/contract/agent-tools-030.contract.test.ts` "propose_sites says an embedded frame's site may be proposed like any site"; `site-mode-gate.test.ts` "runs the step without asking under the frame site's own follow-a-plan plan"; `agent-batch.test.ts` frame-site plan case. **Gap**: no packaged row proposes the frame's site; R-449 says no code change was needed, so the storage path is the existing one |
| FR-464 (unknown site always asks; never the top site's mode) | T888, T899 | `site-mode-gate.test.ts` "030 unknown deciding site" (5: every mode prompts, follow-a-plan with a plan still prompts, a site plan does not cover it, an ungated tool is still refused, a known site is as before); `agent-effects.test.ts` "asks with frame unknown when the browser gives the frame an opaque origin, whatever the page's mode"; `computer.test.ts` "asks about a frame whose site cannot be established..."; packaged Story 3 |
| FR-465 (top or same-site targets behave exactly as before) | T892, T895, T898 | `agent-effects.test.ts` "asks about a same-site ref exactly as before, with no frame field and no probe", "adds no probe for a ref in the top document"; `computer.test.ts` "keeps the page's decision outside every frame, with no nonce or probe before or after the gate"; `agent-upload.test.ts` "decides a top-frame ref and a same-site frame by the page's site, with no frame on the card", "keeps the top frame's decision, card and text exactly as before outside every frame (SC-206)"; `agent-runtime-site-plan.test.ts` "asks about a drop point under the page's site when the page has one document (030 SC-206)"; `prompt-card.test.tsx` "renders a prompt without a frame exactly as before"; `frame-read-wiring.test.ts` "reads a page whose frames all share its site exactly as before"; contracts "a prompt without frame parses unchanged" |
| FR-466 (tool descriptions say it) | T903 | `tests/contract/agent-tools-030.contract.test.ts` "T903 frame-site wording in the tool descriptions" (the action tools, `read_page` and `find`, `propose_sites`) |

## Success criteria

| Criterion | Tasks | Evidence |
| --- | --- | --- |
| SC-202 (type, click, drag, keys in an undecided site's frame raise a card; nothing changes before the answer) | T892, T899, T905 | packaged Story 1 (the field stays empty until Allow once; read from the fixture frame itself); `agent-effects.test.ts` "finds the frame before the gate without scrolling, and asks for the frame's site before any input". Keys and drag: unit only (drag by point; keys see the gap under FR-454) |
| SC-203 (coordinate clicks over another site's frame decided by that frame, unknown points asked) | T897, T898, T905 | packaged Story 2; `computer.test.ts` (asks; unknown asks); `frame-site.test.ts` hit-test walk |
| SC-204 (a frame whose report disagrees with the browser never acts under the reported site) | T889, T899, T905 | `agent-effects.test.ts` "T899 a frame's own report never decides" (3); `frame-site.test.ts` "gives the sender's site when the body claims the page's site"; `frame-read-wiring.test.ts` "takes the site from the browser, never from what the frame says about itself"; packaged Story 3 (sandboxed frame whose own origin is the page's). **Gap**: the packaged gate has no frame that lies in a message body (R-449's test hook was not built; the browser-attached sender is the only source, which the unit tests pin) |
| SC-205 (a frame that navigates between answer and gesture: 0 actions reach the new page, the agent is told) | T901, T905 | packaged Story 4 (the frame moves while the card is up; nothing reaches the new page); the T901 unit cases listed under FR-460 |
| SC-206 (pages without other-site frames show no change; existing gates pass unchanged) | T906 | The unit side: the FR-465 cases above and the existing suites, which run unchanged. The packaged side: `agent-frames`, `agent-input`, `agent-reads`, `agent-press-outcomes` specs. **Not recorded here**: T906 had not run when this was written. `agent-input.spec.ts` was edited by this feature (see Follow-ups), so "unchanged" holds for the three others only |
| SC-207 (the card alone says which site is asked about and which page holds it) | T896, T900, T905 | `prompt-card.test.tsx` "030 frame card", "030 upload frame card"; packaged Story 1 and Story 3 take `frame-card-known.png` and `frame-card-unknown.png` from the panel's own CDP session into the run's output directory. The pictures are run artefacts, not in the repository |

## Research decisions

| Decision | Tasks | Evidence |
| --- | --- | --- |
| R-440 (sender origin, frame id and document id from the browser) | T886, T889, T891 | `frame-sender-probe.test.ts` (3); `frame-site.test.ts` "gives no site when the sender frame id is missing or not the claimed one", "...document id..."; measurements in research.md "Measured 2026-11-07 (T886)" (the throwaway measuring spec was deleted, as T886 required) |
| R-441 (opaque is unknown; inline and blank inherit) | T886, T889, T899 | `frame-site.test.ts` "030 decideFrameSite" (srcdoc, about:blank, sandboxed, sender-origin shapes); `agent-effects.test.ts` "asks with frame unknown when the browser gives the frame an opaque origin..."; packaged Story 3. The 2,000 ms "frame does not answer" bound: `frame-merge.test.ts` "names a frame unknown when its lookup fails, outlasts the bound, or the browser forbids scripts there" |
| R-442 (hit-test finds the frame; nonce names it; sender origin decides) | T886, T897 | `frame-site.test.ts` "030 resolvePointSite hit-test walk"; packaged Story 2 (a real out-of-process frame, one level) |
| R-443 (scroll-free claim before the gate; the second claim after the gate cancels on a different frame) | T892 | `agent-effects.test.ts` "finds the frame before the gate without scrolling...", "cancels with the frame-moved answer when the delivery claim lands in another frame, and sends nothing", "cancels a ref no frame claimed before the gate that the delivery then finds inside a frame" |
| R-444 (`GateInput.site` is the deciding site or `null`) | T888 | `site-mode-gate.test.ts` "030 unknown deciding site" (5) |
| R-445 (optional `frame` on the prompt; Allow always stores the frame's site; unknown refuses `rememberMode`) | T887, T893, T896, T899 | contracts "030" (6); `prompt-card.test.tsx` "030 frame card"; `agent-effects.test.ts` T893 cases and "refuses an answer to an unknown-site card that asks to remember a mode..." |
| R-446 (re-check inside `beforeDispatch`) | T901 | see FR-460 |
| R-447 (the frame answer family) | T890 | `agent-site-recheck.test.ts` "030 frame answers" (8) |
| R-448 (read labels: frame `site`, node and match `site` only when different) | T887, T902 | see FR-462 |
| R-449 (`propose_sites` needs only text; fixtures) | T885, T903 | `tests/harness/page-fixtures.test.ts` "T885 frame fixtures" (6); `tests/contract/agent-tools-030.contract.test.ts`. The "unit-level test hook" R-449 mentions for a lying frame was not built; the unit tests fake the sender instead (see the SC-204 gap) |

## Task map

| Task | Where it is covered |
| --- | --- |
| T885 | `tests/harness/page-fixtures.test.ts` "T885 frame fixtures" |
| T886 | research.md "Measured 2026-11-07 (T886)"; no test (a measurement) |
| T887 | contracts `packages/contracts/src/agent-tools.test.ts` "030" |
| T888 | `site-mode-gate.test.ts` "030 unknown deciding site" |
| T889 | `frame-site.test.ts` "030 decideFrameSite" |
| T890 | `agent-site-recheck.test.ts` "030 frame answers" |
| T891 | `frame-sender-probe.test.ts` (the probe moved to `chrome-adapters/frame-sender.ts`; the test is not in `content-runtime-contract.test.ts` as the task text planned) |
| T892, T893 | `agent-effects.test.ts` "030 pre-gate claim" |
| T894 | `agent-batch.test.ts` "030 a batch step in another site's frame" |
| T895 | `agent-upload.test.ts` "030 upload into a frame from another site" and "030 a drop point is decided by the frame under it" |
| T896, T900 | `prompt-card.test.tsx` "030 frame card", "030 upload frame card" |
| T897 | `frame-site.test.ts` "030 resolvePointSite hit-test walk" |
| T898 | `computer.test.ts` "030 a coordinate action is decided by the frame under its point"; `agent-effects.test.ts` "T898 a point target is decided by the frame under it" |
| T899 | `agent-effects.test.ts` "T899 a frame's own report never decides" |
| T901 | `agent-effects.test.ts` "T901 ..."; `computer.test.ts`; `agent-upload.test.ts`; `frame-site.test.ts` "030 sameDecidingSite" |
| T902 | `frame-merge.test.ts` "030 frame sites in the merge"; `frame-read-wiring.test.ts` "030 read labels" |
| T903 | `tests/contract/agent-tools-030.contract.test.ts` |
| T904 | `site-mode-gate.test.ts` "030 a plan covers only its own site"; `agent-batch.test.ts` |
| T905 | `tests/e2e/packaged/agent-frame-consent.spec.ts` (Stories 1, 1.3, 2, 3, 4, 5, 6) |
| T906 | owed: the four SC-206 gates unchanged, then typecheck, `npm test`, build, `test:contract`, `snapshot:check` |
| T907 | this file; then the two reviews |
| T908 | `agent-effects.test.ts` "T908 keys sent to focus are decided by the frame that holds it"; `frame-site.test.ts` (focus walk); `frame-focus.test.tsx` (depth cap, embed/object, path past the cap); packaged Story 7 |
| T909 | `agent-upload.test.ts` (Allow always refused on an unknown card); `packages/contracts/src/agent-tools.test.ts` (prompt frame equal to the page refused) |

## Runs

Packaged gates on Playwright Chromium 151, attach recipe, en-US (2026-11-07). After both review rounds,
on one code tree:

| Spec | Result |
| --- | --- |
| `agent-frame-consent` (Stories 1-7) | 7/8 in one run, with Story 1 stopped at setup by a stale bundle in the browser (`stale-extension-build`) before any 030 step; Story 1 then 1/1 alone |
| `agent-frames` | 1/1 |
| `agent-reads` | 3/3 |
| `agent-press-outcomes` | 2/2 |
| `agent-input` | 2/2, with the two clicks into another site's frame now answering the frame's card |

Before the reviews, on the earlier tree: the same specs passed, and `agent-upload-image`,
`agent-computer`, `agent-site-plan`, `agent-batch-upload` passed 6/6, 1/1, 4/4, 3/3.

The first gate run measured one defect, fixed before these runs: the debugger's hit-test takes whole
pixels only, so a point at an element's centre or shifted by a frame holder at a fractional offset was
refused, and every out-of-process frame was decided as unknown.

The planned final verification (typecheck, `npm test`, build, `test:contract`, `snapshot:check`) is
recorded with the release.

## Gaps

Listed so that none of them reads as covered above.

1. FR-456: no test pins that `form_input` and `evaluate` skip the frame lookup.
2. FR-454: `double_click`, `triple_click`, `right_click` and `key` in a frame have no test of their own.
3. FR-463: no packaged row proposes a frame's site.
4. SC-204: the packaged gate has no frame that lies in a message body (the unit tests cover it with a faked sender).
5. SC-206: not yet run (T906); `agent-input.spec.ts` changed on purpose.
6. SC-207: the card pictures exist only as run artefacts.

## Follow-ups

Not part of this feature. Each is a candidate for its own issue.

- **Sibling-order frame pairing.** The offsets for a click inside a nested same-process frame are found by
  pairing the page's frame list with the debugger's frame tree in sibling order. When a frame does not
  answer, or a frame has many siblings, the pairing can misalign and misplace the click. It does not
  touch consent: the site is decided from the browser's sender data, not from this pairing (research.md,
  "Not in scope, noted").
- **Shared ask-and-apply step.** Review round 1 moved the frame pieces into `frame-consent.ts`, but the
  order `decideGate` → ask → answer → re-read ownership → refuse Allow always on unknown → store is
  still written out in both `effects.ts` and `upload.ts`. `HINT_MAX_CHARS` is also repeated in
  `site-plan.ts` and `transitions.ts`; a contracts-exported constant would keep them in step.
- **`frame-focus.ts` placement.** The focus read belongs in `chrome-adapters/` beside `frame-sender.ts`
  and `main-world-marks.ts`, with its own answer type. One predicate for "page decision from the top
  document" would also replace three inline checks.
- **Focus read edges.** `<fencedframe>` is not in the focus read's list of frame holders, so focus a
  user clicked into one may be read as the page's. The read also falls back to `element.shadowRoot`
  when `chrome.dom` is missing, which only happens in tests; closed roots are missed if it ever ran
  in the extension. Both should answer unknown.
- **Card wording.** The card's first line names the page's site as the action's site, and "Always allow
  on this site" does not name which site. A drag between two known sites is shown as "could not be
  established" rather than "two sites".
- **`askUploadDirectory` cards do not carry `frame`.** The card that asks for an upload directory can show
  the frame line (`prompt-card.test.tsx` "shows the frame line on the directory card too"), but the
  worker never sets `frame` on it, so it names the page and not the frame holding the target. The
  `file_upload` and `upload_image` effect cards do carry it.
- **Nested out-of-process frames.** The walk into a frame inside a frame, both in their own process, is
  checked only by unit fakes. The packaged gate covers one level.
- **Points outside the viewport.** A point target outside the viewport asks as an unknown site before the
  page refuses it, so the owner is asked about an action that was never going to run.
- **SC-206 and the agent-input gate.** The `agent-input` packaged gate's two clicks into another site's
  frame now answer that frame's card, which is the behaviour of this spec (FR-450). This is an intended
  change to SC-206's "unchanged" for that one gate, and the spec's wording should be read that way.

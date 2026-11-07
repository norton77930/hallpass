# Tasks: Consent per Site for Embedded Frames

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/prompt-and-reads.md](contracts/prompt-and-reads.md), [quickstart.md](quickstart.md)

Every behaviour task starts with its failing test (project rule, CLAUDE.md; it overrides the "tests are
optional" default). IDs continue from 029 (T884). `[P]` marks a task in a different file with no open
dependency. Paths under `agent-tools/` mean `apps/extension/src/service-worker/agent-tools/`.

## Phase 1: Setup and measurements (decide R-441 and R-442)

- [x] T885 [P] Add page fixtures in `tests/harness/page-fixtures.ts` and its pages directory. Each
      embeds a frame from the second site (`__OOPIF_ORIGIN__`) unless noted otherwise:
      - `frame-consent.html`: a form (text field, button) in a frame from the second site;
      - `frame-sandboxed.html`: a sandboxed frame without `allow-same-origin`;
      - `frame-srcdoc.html`: a `srcdoc` frame (top site);
      - `frame-blank.html`: an `about:blank` frame the parent writes into (top site);
      - `frame-nested.html`: second site inside a same-site frame;
      - `frame-navigating.html`: a frame that moves to a third origin when the page receives
        `postMessage("go")`.

      Test first in the existing fixture test: each page is served, and its frame source is the expected
      origin.
- [x] T886 Measurement M1 and M2. Add a throwaway spec
      `tests/e2e/packaged/measure-frame-site.spec.ts` that is not part of any gate and is deleted after this
      task. It records:
      - the sender origin, frame id and document id that the content runtime's reply carries, for each
        T885 frame;
      - for a point over each frame, `DOM.getNodeForLocation` with its frame id;
      - the target id of an out-of-process frame, compared with its frame id;
      - `Page.getFrameTree` `securityOrigin` for the sandboxed frame.

      Write the measured values into research.md under "Measurements before code" and settle R-441 and
      R-442. If a measurement changes a decision, stop and report to the owner before T888.

## Phase 2: Foundational (blocks every story)

- [x] T887 [P] Test first in `packages/contracts/src/agent-tools.test.ts` ("030"):
      - `agentEffectPromptSchema.frame` takes `{site}` or `{unknown: true}`, and nothing else;
      - a prompt without `frame` parses unchanged;
      - `agentReadPageFrameSchema.site` is required;
      - node and `find` match `site` are optional.

      Then the schemas in `packages/contracts/src/agent-tools.ts`, including the corrected `url` comment.
      Contract: prompt-and-reads.md. FR-457, FR-458, FR-462, R-445, R-448.
- [x] T888 Test first in `apps/extension/tests/site-mode-gate.test.ts`: with `site: null`, every mode
      (`ask`, `follow-a-plan` with any plan, `skip-checks`) prompts, and a known site decides exactly as
      today. Then `GateInput.site: SiteOrigin | null` in `agent-tools/gate.ts`. FR-464, R-444.
- [x] T889 Test first in a new `apps/extension/tests/frame-site.test.ts`, then implement in a new
      `agent-tools/frame-site.ts`: `decideFrameSite(reply, claimed, pageSite)`. It returns `page`,
      `frame` or `unknown` (data-model DecidingSite):
      - an opaque origin gives `unknown`;
      - a sender frame id or document id other than the claimed one gives `unknown`;
      - the frame's self-reported origin is ignored: a reply whose body claims the page site but whose
        sender origin is another site gives `frame` with the sender's site;
      - the sender origin equal to the page site gives `page`;
      - for inline frames, the inheritance rule that T886 settled.

      FR-451, FR-452, FR-453, R-440, R-441.
- [x] T890 Test first in `apps/extension/tests/agent-site-recheck.test.ts`, then add a frame answer family
      in `agent-tools/site-recheck.ts`. It names the frame's site and one reason: refused, undecided, frame
      moved, or unknown site. The existing site-moved texts stay byte-for-byte the same. FR-461, R-447.

## Phase 3: User Story 1 - A payment frame is asked about separately (P1) MVP

**Goal**: element-reference actions in a frame from another site are decided by that site.
**Independent test**: quickstart rows Story 1 and 1.3.

- [x] T891 [US1] In `apps/extension/src/content-runtime/index.ts`, answer a
      new site-probe message with its frame's own report only. Test first in
      `apps/extension/tests/content-runtime-contract.test.ts`.
      The worker reads the sender fields from the browser, never from the reply body.
- [x] T892 [US1] Test first in `apps/extension/tests/agent-effects.test.ts` ("030 pre-gate claim"). For a
      ref inside a frame from another site:
      - the frame is found before the gate, without any scroll message;
      - the gate receives the frame's site, mode and plan;
      - the prompt carries `frame: {site}`;
      - nothing is delivered before the answer.

      Then implement the scroll-free claim (`refs.ts` discovery without scrolling) and the deciding-site
      lookup in `agent-tools/effects.ts`, before `decideGate`. FR-450, FR-454, R-443.
- [x] T893 [US1] Test first (same file): Allow always on a frame prompt stores the frame's site and leaves
      the top site's mode unchanged; Refuse delivers nothing and returns the T890 refused answer. Then the
      store key in `effects.ts`, the code that today stores the top site at line 2456. FR-457, R-445.
- [x] T894 [US1] Test first in `apps/extension/tests/agent-batch.test.ts`: a `browser_batch` step that
      types into another site's frame asks for that site, while earlier steps on the top site run. Then the
      batch wiring. FR-454.
- [x] T895 [P] [US1] Test first in `apps/extension/tests/agent-upload.test.ts`: `file_upload` and `upload_image` into a frame from another site are decided by that site
      before anything is written. Then move the discovery in `agent-tools/upload.ts` before `admit()`.
      FR-454 (O-030-1).
- [x] T896 [US1] Test first in `apps/extension/tests/prompt-card.test.tsx`: a prompt with `frame.site`
      names the frame site and the page, and its buttons answer for the frame site. A prompt without
      `frame` renders exactly as today. Then `apps/extension/src/side-panel/agent/PromptCard.tsx`. FR-457,
      SC-207.

## Phase 4: User Story 2 - A coordinate click over a frame is gated by that frame (P1)

**Goal**: coordinate actions are decided by the innermost frame under the point.
**Independent test**: quickstart row Story 2.

- [x] T897 [US2] Test first in `apps/extension/tests/frame-site.test.ts` ("hit-test walk") with a fake
      debugger:
      - a point in the top document gives `page`;
      - a point over a same-process frame gives that frame's origin;
      - a point over an out-of-process frame descends into its session with the shifted point (T886: the
        holder `IFRAME`'s child frame id equals that frame's target id);
      - the frame found is identified by a one-time nonce, written through CDP and read back with
        `executeScript`, then cleared. Its site is the sender origin, never `securityOrigin`;
      - any failed step gives `unknown`.

      Then `resolvePointSite` in `agent-tools/frame-site.ts`, per R-442 as settled by T886. FR-455.
- [x] T898 [US2] Test first in `apps/extension/tests/computer.test.ts`: a `computer` left click over another
      site's frame asks for that site before any input event, and a click outside every frame keeps today's
      top-site decision. The same applies to element tools given a point target (`click`, `hover`,
      `drag` and so on with `{target: {x, y}}`), which today resolve in the top document after the gate
      (a gap found in T892). Then call `resolvePointSite` from the coordinate preflight in
      `agent-tools/effects.ts`, and from the point-target path of the element tools, before `decideGate`.
      FR-455, SC-203.

## Phase 5: User Story 3 - A frame that lies about its site does not borrow trust (P1)

**Goal**: a lying frame is decided by its true site; an unknown frame always asks, and never offers Allow
always.
**Independent test**: quickstart rows Story 3 and 3.2.

- [x] T899 [US3] Test first in `apps/extension/tests/agent-effects.test.ts`:
      - a frame whose own report claims the top site, while its sender origin is the second site, prompts
        with `frame: {site: <second site>}` while the top site is in skip-checks;
      - a sandboxed frame (sender origin `null`) prompts with `frame: {unknown: true}`;
      - a reply carrying `rememberMode` to an unknown prompt is refused and stores nothing.

      Then the answer handling in `effects.ts`. FR-451, FR-458, FR-464, SC-204.
- [x] T900 [P] [US3] Test first in `apps/extension/tests/prompt-card.test.tsx`: a prompt with
      `frame.unknown` says the frame's site is unknown and has no Allow always button. Then
      `PromptCard.tsx`. FR-458.

## Phase 6: User Story 4 - The frame moves to another site after the owner agreed (P2)

**Goal**: the frame is re-checked right before the gesture.
**Independent test**: quickstart row Story 4.

- [x] T901 [US4] Test first in `apps/extension/tests/agent-effects.test.ts` and `computer.test.ts`:
      - after the answer, a changed sender origin or document id, or a changed site at the point, cancels
        with the T890 frame-moved answer and no input event;
      - an unchanged frame runs exactly once.

      Then add the frame re-check to the `beforeDispatch` closure (`effects.ts` around 1273-1284) for both
      paths. Also cancel when the post-gate delivery claim lands in a different frame or document. FR-460,
      R-446, SC-205.

## Phase 7: User Story 5 - The agent can see which site a frame belongs to (P2)

**Goal**: reads label frames and references from other sites.
**Independent test**: quickstart row Story 5.

- [x] T902 [P] [US5] Test first in `apps/extension/tests/frame-read-wiring.test.ts`: each listed frame
      carries `site` (or `"unknown"`), taken from the sender origin. Nodes and `find` matches carry `site`
      only when it differs from the page's site. A page with only same-site frames reads byte-for-byte as
      before. Then `agent-tools/frames.ts`, `reads.ts` and `refs.ts`. FR-462, R-448.
- [x] T903 [P] [US5] Test first in a new `tests/contract/agent-tools-030.contract.test.ts`: the texts of `click`,
      `double_click`, `triple_click`, `right_click`, `hover`, `drag`, `type`, `key`, `computer`,
      `browser_batch`, `file_upload`, `upload_image`, `read_page`, `find` and `propose_sites` carry the
      contract wording. Then the descriptions in `packages/contracts/src/agent-tools.ts`. FR-463, FR-466.

## Phase 8: User Story 6 - Plans do not reach into other sites' frames (P3)

**Goal**: a plan covers only its own site.
**Independent test**: quickstart row Story 6.

- [x] T904 [US6] Test first in `apps/extension/tests/agent-batch.test.ts` and `site-mode-gate.test.ts`:
      - with an approved top-site plan, a step whose target is in another site's frame asks;
      - with the frame site proposed and approved as follow-a-plan with its own plan, the covered step runs
        without asking.

      This should pass from T888 and T892 alone. If not, fix the plan lookup in `effects.ts` so it uses the
      deciding site. FR-459, FR-463.

## Phase 9: Polish and gates

- [x] T905 Packaged gate `tests/e2e/packaged/agent-frame-consent.spec.ts` covering every quickstart row,
      with a screenshot of each frame card in `test-results/<run-id>/`. SC-202..205, SC-207.
- [x] T906 Regression gates (SC-206): run `agent-frames`, `agent-input`, `agent-reads` and
      `agent-press-outcomes` unchanged. Then run the planned final verification: typecheck, `npm test`,
      build, `test:contract` and `snapshot:check`.
- [x] T907 Fill `specs/030-frame-site-consent/coverage.md` (FR, SC and R to tasks and tests). Add the
      sibling-order pairing defect (research.md) to the follow-up list. Then `code-reviewer` reviews the
      whole diff, and `architecture-reviewer` reviews the gate input and prompt contract.
- [x] T908 (review CR-I1) Test first in `apps/extension/tests/agent-effects.test.ts` and `frame-site.test.ts`:
      keys sent with no target, and `computer` type or key without a coordinate, are decided by the frame
      that holds focus (`resolveFocusSite`, `frame-focus.ts`). Focus in the top document keeps the page's
      decision. A frame that cannot be named asks as unknown. Focus is read again before the first key. (review round 2: depth cap and frame-like holders without contentWindow answer unknown)
- [x] T909 (review CR-I2, Arch-I1, Arch-N5) Test first in `apps/extension/tests/agent-upload.test.ts`: an
      unknown-site upload card answered with `rememberMode` is refused, as in the effects. The shared
      frame-consent steps move to `agent-tools/frame-consent.ts`, and `upload.ts` uses `sameDecidingSite`.
      `agentEffectPromptSchema` refuses a `frame.site` equal to `site`.

## Dependencies

- T885 → T886 → T888 and T889 (T887 can run in parallel with T886).
- Phase 2 → every story.
- US1 (T891-T896) → US3 (T899 reuses the claim) and US4 (T901 reuses the claim).
- US2 (T897-T898) → US4's coordinate half.
- T892, T893, T898, T899 and T901 all edit `effects.ts`, so they are serialized.
- US5 (T902, T903) and T895, T896 and T900 can run in parallel with the `effects.ts` chain.
- US6 (T904) after T892.
- T905-T907 last.

## Parallel examples

- After Phase 2: one writer on the `effects.ts` chain (T892 → T893 → T894 → T898 → T899 → T901), and a
  second on T896, T900, T902 and T903, which touch the card, reads and contracts.
- T895 (`upload.ts`) can take the second writer's slot between its tasks.

## Implementation strategy

MVP = Phases 1-3 (US1): element-reference actions in another site's frame ask under that site. Then US2
and US3 (P1), US4 and US5 (P2), and US6 (P3). The release waits for 0.19.0 to ship first (D-030-14) and
for the owner's approval.

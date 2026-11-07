# Research: Consent per Site for Embedded Frames

Facts were read on 2026-11-07 from private main 60c1115 (paths relative to the repository root). Each
decision says what was chosen, why, and what else was weighed. R-440 and R-441 rest on browser behaviour
that has not been measured yet. The first tasks measure them, and the design stands or changes on those
measurements (see "Measurements before code").

## R-440 - Where a frame's site comes from for an element-reference action

**Decision**: when the frame holding a reference is found (the claim), the worker asks that frame to send it one
message back. The deciding site is the **origin the browser attaches to that message as its sender**. It
is not anything the frame writes into the message. The reply must come from the same frame and document
the worker addressed. The browser's sender frame id and document id are compared with the claimed ones.
Otherwise the site is unknown.

**Rationale**: the browser fills in the sender's origin, frame id and document id itself. A page or the frame's own
code cannot change them. They map exactly to the frame the claim came from, with no ordering guesswork.
The extension already sends and receives these messages, so no new permission is needed (Principle V,
FR-451). The debugger route would also need a frame-to-frame mapping that today is built by sibling order
(`frames.ts:558-578`). That mapping misaligns when a frame does not answer, and when a frame has 11 or more
siblings (`scripting.ts:200-201`).

**Relation to D-030-5**: the owner chose "the browser decides, through access the extension already has".
Round 2 recommended the debugger frame tree. This route also takes the site from the browser, through
messaging the extension already has. The debugger stays the source for coordinate actions (R-442), where
there is no claiming frame to message. The owner is told about this choice when the plan is reported.

**Alternatives**: (a) The debugger frame tree's per-frame origin, mapped from the claimed frame by sibling
order. Rejected for the misalignment above. (b) A nonce written into the frame and read back through the
debugger, as the out-of-process frame resolver does (`effects.ts:947-1002`). It is exact, but needs a
debugger session per frame and still takes its expected origin from the self-report today. (c) The
navigation-events permission. Rejected because spec 004 deliberately left it out.

## R-441 - Inherited, sandboxed and blank frames

**Decision**: the deciding site is the sender origin as the browser reports it. An opaque origin
(`"null"`, which a sandboxed frame without same-origin access has) means the site is unknown. A frame
that shows `about:blank` or `srcdoc` content reports its holder's origin, so it inherits with no special
code (FR-452). A frame whose content runtime does not answer within the existing 2,000 ms frame bound
counts as unknown.

**To measure first (M1)**: the sender origin for a sandboxed frame, a `srcdoc` frame, an `about:blank`
frame written by its parent, a frame from another site in its own process, and a frame from the same site
on another port. If the browser does not give `about:blank` or `srcdoc` the holder's origin, the plan
changes to "inherit from the parent frame's sender origin". That is decided by measurement, not by
guessing.

## R-442 - Which frame is under a coordinate point

**Decision**: before the gate, a coordinate action asks the browser through the debugger which node is
under the point (`DOM.getNodeForLocation`). The returned frame id is the frame whose document holds that
node. If the node is the holder element of a frame that runs in its own process, the search continues in
that frame's session. The point is shifted by the holder's content box, and the walk ends at the innermost
frame. The walk names the frame only. Its site comes from the sender origin of that frame, which is identified to
the extension by a one-time nonce: written through CDP in the frame's main world, read back with
`executeScript` across all frames, then cleared. This was amended after T886: `securityOrigin` names a
sandboxed frame by its holder's site. Any failed step means the site is unknown (FR-455, FR-464).

**Note (review, 2026-11-07)**: the point mark is written in the frame's main world, so the page can see it,
unlike the sender probe, which runs in the isolated world. A page that copies or removes the mark only makes
the site unknown, so it fails closed. The hit-test floors the point to whole pixels; the gesture is still
delivered at the fractional point.

**Rationale**: the gesture is delivered on the tab's top-level session and the browser does the hit-test
(`computer.ts:168-191`). Asking the browser the same question beforehand decides on the frame the click
will reach. The input session is already attached before the gate (`effects.ts:2125-2154`). `DOM.enable`
is already sent on demand (`frames.ts:650-658`).

**To measure first (M2)**: (1) what `DOM.getNodeForLocation` returns over a frame running in its own
process; (2) whether that frame's target id is its frame id; (3) what `securityOrigin` says for a
sandboxed frame. The fallback is "unknown", which asks, so a wrong guess fails closed.

**Alternatives**: the content runtime's own point lookup (`content-runtime/index.ts:338-348`,
`files.ts:270-307`). It cannot cross into another site's frame, and it is a self-report.

## R-443 - Finding the target frame before the gate

**Decision**: today the claim runs after the gate (`effects.ts:1693-1736`). It scrolls the target into
view (`effects.ts:1708`). The order changes: before the gate, a **scroll-free** claim finds the frame that
holds the reference (the same question as `discoverRefFrame`, `refs.ts:95-134`, asked without scrolling).
R-440 then sets the deciding site, and the gate decides. After the gate, delivery claims again as it does
today. If the second claim lands in a different frame or document, the action is cancelled with "the
frame moved to another site" (FR-460).

**Rationale**: nothing moves on the page before the owner answers. The precedent is `file_upload`, which
already discovers the frame after `admit()` (`upload.ts:199-205`). Here it is moved in front.

## R-444 - The gate's input

**Decision**: `GateInput.site` becomes the **deciding site**: a known site, or `null` for an unknown
frame site. The caller looks up that site's mode and plan (`statedPlan`, `sitePlanCovers`) and passes
them. With `site: null` the gate never admits without a prompt, whatever mode is passed. `decideGate`
stays pure. The top-level re-check (`stillOnOrigin`) keeps using the page's site.

**Rationale**: the smallest change that keeps the decision in one pure function (`gate.ts:134-171`). Plans
then work as FR-459 requires with no plan-specific code. A plan for the top site does not match a frame
site, so that step is asked about.

## R-445 - The consent card

**Decision**: `agentEffectPromptSchema` gains an optional `frame` field:
`{ site: SiteOrigin } | { unknown: true }`. It is present only when the deciding site differs from the
page's site. The existing `site` field stays the page's site, so older readers of the field keep their
meaning. With `frame` present, the card says that the action is inside an embedded frame, and names the
frame's site (or "unknown site") and the page. Allow always stores the frame's site
(`siteModes.set(frame.site)`, today `binding.site` at `effects.ts:2456`). With `frame.unknown`, the card
offers no Allow always, and the worker refuses a `rememberMode` for that prompt.
A drag between two known sites that differ is shown as unknown. This fails closed; clearer wording for
that card is a follow-up.

**Rationale**: one optional field and one store target. Prompts for same-site actions are byte-for-byte
unchanged (FR-465, SC-206).

## R-446 - Re-check right before the gesture

**Decision**: the closure every gesture passes as `beforeDispatch` (`effects.ts:1273-1284`) gains a
frame re-check after the existing top-site check:
- for an element-reference action, the R-440 message is sent again to the claimed frame, and the same
  document must answer with the same site;
- for a coordinate action, the R-442 lookup is run again at the delivery point, and it must give the same
  site.

A mismatch cancels the action with the frame-moved answer (FR-460, FR-461).

## R-447 - Answers to the agent

**Decision**: a new answer family next to `SITE_MOVED_HINT` (`site-recheck.ts:63-87`) names the frame's
site and one reason: refused by the owner, no decision yet (a timeout), the frame moved to another site,
or the frame's site is unknown. The same-site answers are unchanged.

## R-448 - Read labels

**Decision**: `read_page` adds `site` to each listed frame. It is the R-440 sender origin, collected in
the same frame round-trip the read already makes, or `"unknown"`. `read_page` nodes and `find` matches
gain `site` only when their frame's site differs from the page's site. The schema comment that says
`url` is browser-reported (`agent-tools.ts:1017`) is corrected: it is the frame's own report.

**Rationale**: FR-462. The agent can see the boundary before acting, and pages without frames from other
sites read exactly as before.

## R-449 - Proposals and fixtures

**Decision**: `propose_sites` already takes any http(s) origin and does not require an open tab
(`agent-tools.ts:1787-1830`, `agent-runtime.ts:2009-2030`). FR-463 needs only the tool text. The packaged
gate uses the existing second-site origin (`oopifOrigin`, `https://localhost:<port>`,
`page-fixtures.ts:174-176`). It adds pages for a sandboxed frame, a `srcdoc` frame, an `about:blank`
frame, a nested frame from another site, and a frame that navigates when asked. A unit-level test hook
makes a frame's own report disagree with its sender origin (Story 3).

## Measurements before code

| Id | Question | Where | Changes the design if |
| --- | --- | --- | --- |
| M1 | Sender origin for sandboxed, `srcdoc`, `about:blank`, cross-site and same-site-other-port frames | Playwright Chromium, the packaged attach recipe | `srcdoc` or `about:blank` do not inherit: R-441 switches to inheriting from the parent's sender origin |
| M2 | `DOM.getNodeForLocation` over a cross-process frame; target id equals frame id; `securityOrigin` of a sandboxed frame | same | the walk cannot descend: coordinate actions over such frames count as unknown (asked), and the spec text says so |

### Measured 2026-11-07 (T886)

The measurements ran on Playwright Chromium 151 with the attach recipe and the T885 fixtures. The top site
was `https://127.0.0.1:19443`, the second site `https://localhost:19443`, and the third origin
`https://127.0.0.1:19445`. The "sender" values are what the browser attached to a message the frame sent.
The "self" value is the frame's own `location.origin`.

| Frame | Sender origin | Self | CDP `securityOrigin` (own session) | Own process |
| --- | --- | --- | --- | --- |
| second site | `https://localhost:19443` | same | `https://localhost:19443` | yes |
| sandboxed (`allow-scripts`) | **`null`** | `https://127.0.0.1:19443` | **`https://127.0.0.1:19443`** | yes |
| `srcdoc` | `https://127.0.0.1:19443` | **`null`** | **`://`** (from the parent's tree) | no |
| `about:blank`, written by the parent | `https://127.0.0.1:19443` | same | `https://127.0.0.1:19443` | no |
| nested second site | `https://localhost:19443` | same | `https://localhost:19443` | yes |
| navigated to the third origin | `https://127.0.0.1:19445`, **new `documentId`** | same | - | - |

- The sender frame id and document id always equal the ones `executeScript` reported for the same frame.
- **M2, hit test:**
  - Over a frame in its own process, `DOM.getNodeForLocation` in the parent returns the holder
    `IFRAME`. `DOM.describeNode` gives its child frame id, and that id **equals** the child's target id.
  - A second `DOM.getNodeForLocation` in the child's own session, at the point shifted into the frame,
    returns the node inside it, with that frame's id.
  - Over a frame in the same process (`srcdoc`, `about:blank`), the first call already returns the node
    inside the frame, with the child frame's id.
- Frames in their own process do not appear in the parent's `Page.getFrameTree`.

**What this changes (the owner approved both on 2026-11-07; they override R-440's self-report check,
R-441's measurement note and R-442's `securityOrigin` step)**:
1. **Self-report rule.** A `srcdoc` frame reports `null` for itself, while the browser gives it the
   holder's site. Under the spec's "a self-report that disagrees counts as unknown" (FR-451, Story 3.1),
   every `srcdoc` frame would be unknown, against FR-452. Proposed: the browser's sender origin alone
   decides, and the frame's own report is never consulted for consent. A frame that lies is then decided
   by its true site.
2. **Coordinate path (R-442).** The CDP `securityOrigin` cannot decide: it names a sandboxed frame by
   its holder's site and an inline frame as `://`. Proposed:
   - the CDP hit-test only finds **which** frame is under the point;
   - that frame is then identified to the extension through a one-time nonce, written through CDP and
     read back with `executeScript`. This is the reverse of the existing out-of-process round trip, and
     the nonce is cleared afterwards;
   - its site is the sender origin, as for element references.

   Element references and coordinates then share one source of truth.

## Not in scope, noted

- `file_upload` and `upload_image` into a child frame: **O-030-1, resolved 2026-11-07**. The owner put
  both under FR-454. They already find the frame after `admit()` (`upload.ts:199-205`). That discovery
  moves before the gate and follows R-440, R-443 and R-446.
- The sibling-order pairing used for frame offsets (`frames.ts:558-578`) is a pre-existing defect that can
  misplace a click inside a nested same-process frame. It is not consent, so it is a follow-up.

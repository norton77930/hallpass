# Feature Specification: Consent per Site for Embedded Frames

**Feature Branch**: not created yet (spec written on `narrow-originless-downloads`, private main 60c1115)

**Feature Directory**: `specs/030-frame-site-consent`

**Created**: 2026-11-07

**Status**: Draft. D-030-1..14 were put to the owner in three rounds on 2026-11-07, and the owner accepted
every recommendation. The rest are the main session's defaults, listed under Assumptions.

**Input**: Issue #35. A page can embed frames from other sites, such as a payment form, a sign-in box or
an advert. Today the owner's consent covers the top-level site only. An action whose target sits inside
another site's frame runs under the top site's mode. So an owner who set a shop to skip-checks also lets
the agent type into the payment provider's frame on that page without being asked.

**Facts checked 2026-11-07** (this repository's own code, read at private main b1b2a49):

- The effect gate decides on one site: the top-level site of the tab. Its input carries no frame and no
  frame site.
- Each frame's content runtime reports a frame's site. Only the top frame's report is checked against the
  tab's address. A child frame's report is accepted as given.
- These actions can reach elements inside child frames, including frames from other sites:
  - a click, hover, drag, type or key on an element reference from `read_page` or `find`;
  - a coordinate action (`computer`) whose point lies over a frame. It is delivered to the tab, and the
    gate sees only the top site.
- `form_input` and `evaluate` act in the top frame only.
- Reads (`read_page`, `get_page_text`, `find`) are not gated for any site. They merge the content of every
  frame the extension may read.
- The consent card names the top site only. "Allow always" stores skip-checks for that site.
- Before each gesture the site is re-checked, but only from the tab's own address. A child frame that
  navigates after the owner agreed is not noticed.
- Sites are stored and matched by full origin (scheme, host, port). No registrable-domain grouping
  exists.
- The extension already has browser-side data on every frame's address (the debugger session used for
  input and frame offsets). It does not use that data to check what a child frame says about itself.
- The project deliberately does not request the browser's navigation-events permission (spec 004).

**Decisions (D-030-n)**, all confirmed by the owner on 2026-11-07:

- **D-030-1 - consent per frame site**: an action whose target is inside a frame passes the gate under
  that frame's own site and that site's mode, not the top site's.
- **D-030-2 - full origin**: a frame site is matched by scheme, host and port. `a.example.com` and
  `b.example.com` are different sites, as they are for top-level pages today.
- **D-030-3 - new spec**: this is a new feature (030), not an amendment of spec 004.
- **D-030-4 - frames that inherit**: a frame showing `about:blank` or inline content (`srcdoc`) has the
  site of the frame that holds it. A sandboxed frame, or a frame whose site cannot be established, counts
  as another site with no decision.
- **D-030-5 - the browser decides a frame's site**: a frame's site comes from what the browser reports
  about that frame, through access the extension already has. What the frame reports about itself is
  never consulted for consent, so a frame that lies is decided by its true site. No new browser
  permission is requested. (Amended 2026-11-07 after measurement T886: an inline frame reports an opaque
  site for itself, while the browser gives it the holder's site.)
- **D-030-6 - which actions are gated per frame**: element-reference click, double, triple and right
  click, hover, drag, type and key are gated by the target frame's site. `form_input` and `evaluate`
  stay top-frame only and are out of scope.
- **D-030-7 - coordinate actions**: the extension finds the frame under the point and gates by its site.
  If that frame cannot be found, or cannot be read, the action counts as acting on another site with no
  decision, and the owner is asked.
- **D-030-8 - reads stay ungated but labelled**: reads are not gated, as today. `read_page` and `find`
  name each frame's site and the site of every element reference inside another site's frame.
- **D-030-9 - the card**: when the target is inside another site's frame, the card says so and names both
  sites. Allow once, Allow always and Refuse apply to the frame's site. With nested frames, the site that
  counts is the innermost frame actually acted on.
- **D-030-10 - plans**: a follow-a-plan plan covers only its own site. A step that lands in another
  site's frame is asked about.
- **D-030-11 - re-check before acting**: right before the gesture, the target frame's site is read again
  from the browser. If it differs from the site the decision was made for, the action is cancelled and the
  agent is told why.
- **D-030-12 - proposals**: `propose_sites` may name a frame's site like any other site, with the same
  rules.
- **D-030-13 - refusal text**: a refusal or cancellation caused by a frame site names that site and the
  reason (refused by the owner, no decision yet, the frame moved to another site).
- **D-030-14 - release order**: 0.19.0 ships the fixes already on main first. This feature ships later as
  its own release.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A payment frame is asked about separately (Priority: P1)

The owner set `https://shop.example` to skip-checks. The checkout page embeds a card form from
`https://pay.example` that the owner has never decided on. The agent types the card number into that form.
The side panel shows a consent card naming `https://pay.example` as the frame's site and
`https://shop.example` as the page. Nothing is typed until the owner answers.

**Why this priority**: this closes the gap issue #35 reports. A trusted page no longer lends its trust to
the sites it embeds.

**Independent Test**: on a fixture page from one test origin that embeds a form from a second test
origin, set the top site to skip-checks. Ask the agent stand-in to type into the embedded field. Confirm
that a card appears for the frame's site, and that the field is still empty until the card is answered.

**Acceptance Scenarios**:

1. **Given** the top site is in skip-checks and the frame site has no decision, **When** the agent types
   into an element of the frame, **Then** a card is raised for the frame site and the field stays
   unchanged until the owner answers.
2. **Given** that card, **When** the owner presses Allow once, **Then** the text is typed, and the next
   action in that frame asks again.
3. **Given** that card, **When** the owner presses Allow always, **Then** the frame's site is stored as
   skip-checks, and the site list shows it as its own site.
4. **Given** that card, **When** the owner presses Refuse, **Then** nothing is typed, and the agent is told
   that the owner refused `https://pay.example`.
5. **Given** the frame's site is in skip-checks and the top site is in ask, **When** the agent clicks
   inside the frame, **Then** the click runs without a card, because the frame's site decides.

---

### User Story 2 - A coordinate click over a frame is gated by that frame (Priority: P1)

The agent works from screenshots and clicks at a point that lies over an embedded frame from another site.
The click is gated by the frame's site, exactly as an element-reference click into that frame would be.

**Why this priority**: otherwise a coordinate click would bypass Story 1.

**Independent Test**: on the same fixture, send a coordinate click at the centre of the embedded button.
Then send one at a point outside every frame. Confirm that the first raises a card for the frame's site
and the second follows the top site's mode.

**Acceptance Scenarios**:

1. **Given** a point over a frame from another site with no decision, **When** the agent sends a
   coordinate click there, **Then** a card is raised for the frame's site.
2. **Given** a point over a frame whose site cannot be established, **When** the agent clicks there,
   **Then** the card says the frame's site is unknown, and Allow always is not offered.
3. **Given** a point outside every child frame, **When** the agent clicks there, **Then** the top site's
   mode decides, as today.

---

### User Story 3 - A frame that lies about its site does not borrow trust (Priority: P1)

A frame from another site reports a site that is not its own, for example the top site's. The extension
does not read that report. It decides by the site the browser gives the frame, so the frame never acts
under the top site's decision.

**Why this priority**: issue #35's second claim. A frame's own report must not decide consent.

**Independent Test**: with a test hook that makes a child frame's report disagree with the browser's view
of that frame, act in the frame. Confirm that a card is raised for the browser's site, and that it does
not name the reported site.

**Acceptance Scenarios**:

1. **Given** a child frame whose report disagrees with the browser, **When** the agent acts in it,
   **Then** the action is decided by the site the browser gives the frame, never by the reported site.
2. **Given** a frame showing `about:blank` inside the top frame, **When** the agent acts in it, **Then**
   the top site's mode decides.
3. **Given** a sandboxed frame, **When** the agent acts in it, **Then** it is treated as another site with
   no decision.

---

### User Story 4 - The frame moves to another site after the owner agreed (Priority: P2)

The owner allowed an action in a frame from `https://pay.example`. Before the action runs, the frame
navigates to `https://other.example`. The action is cancelled, and the agent is told that the frame moved
to another site.

**Why this priority**: the same protection the top site already has, extended to frames.

**Independent Test**: make the fixture frame navigate between the answer and the gesture. Confirm that
nothing reaches the new page and that the agent's error names the frame move.

**Acceptance Scenarios**:

1. **Given** an allowed frame action, **When** the frame's site changes before the gesture, **Then** the
   action is cancelled and the agent is told that the frame moved to another site.
2. **Given** an allowed frame action, **When** the frame is unchanged, **Then** the action runs once.

---

### User Story 5 - The agent can see which site a frame belongs to (Priority: P2)

When the agent reads a page with an embedded frame from another site, the read shows which site each frame
belongs to. Element references inside such a frame are marked with that site. The agent can then tell the
owner, or use `propose_sites`, before it acts.

**Why this priority**: it avoids surprise cards and blind retries.

**Independent Test**: `read_page` and `find` on the fixture page. Confirm that the embedded frame names
its site and that its references carry that site.

**Acceptance Scenarios**:

1. **Given** a page with a frame from another site, **When** the agent reads it, **Then** the frame is
   listed with its site, and references inside it carry that site.
2. **Given** a page with only same-site frames, **When** the agent reads it, **Then** the output is as it
   is today.
3. **Given** the agent's `propose_sites` lists the frame's site, **When** the owner approves the proposal,
   **Then** that site gets the proposed mode like any other site.

---

### User Story 6 - Plans do not reach into other sites' frames (Priority: P3)

The owner approved a follow-a-plan plan for `https://shop.example`. A step lands in the embedded
`https://pay.example` frame. That step is asked about. The rest of the plan runs as approved.

**Independent Test**: approve a plan for the top site whose second step types into the embedded frame.
Confirm that step one runs without a card, and step two raises a card for the frame's site.

**Acceptance Scenarios**:

1. **Given** an approved plan for the top site, **When** a step's target is in another site's frame,
   **Then** that step is asked about.
2. **Given** the frame site was itself proposed and approved as follow-a-plan with a plan, **When** the
   step matches that plan, **Then** it runs without a card.

---

### Edge Cases

- **Nested frames**: a frame inside another site's frame. The innermost frame actually acted on decides,
  and the card names that frame's site.
- **Same-site frames**: a child frame with the same site as the top site behaves exactly as today. No new
  card and no new labels.
- **Frames the extension cannot read** (forbidden schemes, frames that do not answer): they have no
  element references, so only a coordinate action can land in them, and that counts as unknown
  (Story 2, scenario 2).
- **A frame's site cannot be decided because the browser data is unavailable**, for example while the
  debugger session is being re-attached: the action counts as acting on an unknown site and is asked
  about. It is never let through under the top site.
- **The owner answers a frame card after the frame is gone**: the action is cancelled with "the frame
  moved to another site" or "the target is gone", never run elsewhere.
- **Downloads and dialogs started by a frame action**: they follow their existing rules (spec 005 FR-077
  and the dialog rules). This feature does not change them.
- **Unknown-site card**: Allow always cannot store a decision for a site that is not known. Only Allow once
  and Refuse are offered.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-450**: Before an action runs, the system MUST decide its consent under the site of the frame that
  holds the action's target. The top site decides only when the target is in the top frame or in a frame
  that inherits the top site (FR-452).
- **FR-451**: A frame's site MUST come from the browser's own data about that frame, not from what the
  page or the frame's content runtime reports. The frame's own report MUST NOT be consulted for consent.
  This applies to coordinate actions too: the frame under the point is decided by the same browser data
  as an element reference, not by the debugger's description of the frame.
- **FR-452**: A frame showing `about:blank` or inline content MUST have the site of the frame that holds
  it. A sandboxed frame, or one whose site cannot be established, MUST count as an unknown site with no
  decision.
- **FR-453**: Sites MUST be matched by full origin (scheme, host, port), as for top-level sites today.
- **FR-454**: These MUST be gated by the target frame's site when the target is inside a child frame:
  element-reference click, double click, triple click, right click, hover, drag, type and key, including
  steps of `browser_batch`, and `file_upload` and `upload_image` into an element inside a child frame.
- **FR-455**: For a coordinate action, the system MUST find the innermost frame under the point and gate
  by that frame's site. If the frame cannot be found or cannot be read, the action MUST count as acting
  on an unknown site with no decision.
- **FR-456**: `form_input` and `evaluate` MUST keep acting in the top frame only. Their consent is
  unchanged.
- **FR-457**: When the deciding site differs from the top site, the consent card MUST name both: the
  frame's site, and the page's site. Allow once, Allow always and Refuse MUST apply to the frame's site
  only.
- **FR-458**: For an unknown frame site, the card MUST say the frame's site is unknown and MUST NOT offer
  Allow always.
- **FR-459**: A follow-a-plan plan MUST cover only its own site. A step whose deciding site is another
  site MUST be decided under that site's own mode and plan.
- **FR-460**: Right before the gesture, the system MUST read the target frame's site from the browser
  again. If it differs from the site the decision was made for, the action MUST be cancelled, nothing may
  reach the page, and the agent MUST be told that the frame moved to another site.
- **FR-461**: An action refused or cancelled because of a frame site MUST name that site in the agent's
  answer and give one reason: refused by the owner, no decision yet, the frame moved to another site, or
  the frame's site is unknown.
- **FR-462**: `read_page` MUST name the site of each frame it lists. `read_page` and `find` MUST mark
  every element reference inside a frame whose site differs from the top site with that frame's site.
  Reads MUST stay ungated.
- **FR-463**: `propose_sites` MUST accept a frame's site like any other site. The owner's approval MUST
  store it the same way.
- **FR-464**: When the frame's site cannot be established at decision time, the system MUST treat the
  action as acting on an unknown site. It MUST NOT fall back to the top site's mode.
- **FR-465**: Actions whose target is in the top frame or in a same-site frame MUST behave exactly as
  before this feature, with the same cards and the same text.
- **FR-466**: The tool descriptions MUST say that actions inside another site's frame are decided by that
  site, and that reads mark such frames.

### Key Entities

- **Frame site**: the full origin the browser reports for a frame, or "inherits the holder's site", or
  "unknown". It belongs to one frame in one tab at one moment.
- **Deciding site**: the site whose mode and plan decide one action. It is the innermost target frame's
  site (FR-450, FR-452).
- **Frame consent prompt**: the existing consent card, with the deciding site and the page's site when
  they differ.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-202**: On a fixture page whose top site is in skip-checks, 100% of attempts to type, click, drag
  or press keys in an embedded frame from an undecided site raise a card, and change nothing on the page
  before the owner answers.
- **SC-203**: Coordinate clicks over another site's frame are decided by that frame's site in 100% of
  runs. That includes points over frames whose site cannot be established, which are asked about.
- **SC-204**: A frame whose own report disagrees with the browser never acts under the reported site, in
  100% of runs.
- **SC-205**: When a frame navigates between the owner's answer and the gesture, 0 actions reach the new
  page, and the agent is told why every time.
- **SC-206**: Pages without frames from other sites show no change: the existing consent, read and plan
  tests pass unchanged, and no new card appears in their runs.
- **SC-207**: A reviewer reading only the card can say which site is being asked about and which page
  holds it, for every frame-site card in the gate screenshots.

## Assumptions

- The test page server can serve a second origin for the embedded frame, for example another host name
  or port under the existing test certificate. If it cannot, adding one is part of this feature's tests.
- The browser's view of every frame, including frames in their own process, is available through the
  debugger access the extension already uses for input. Frame data that is temporarily unavailable is
  handled as unknown (FR-464). It is not waited for indefinitely.
- The card's wording is the main session's choice within FR-457 and FR-458. It will be shown to the owner
  in the gate screenshots before release.
- Dialogs and downloads that a frame action triggers keep their current rules.
- This feature changes how consent decides, so it needs a fresh-context security review
  (`code-reviewer`) before it is released. It probably also needs an architecture review, because the
  gate's input changes.

## Out of scope

- `form_input` and `evaluate` inside child frames.
- Plans that cover more than one site.
- Grouping sites by registrable domain.
- Gating reads.

## Change log

- 2026-11-07: created from issue #35 after three rounds of questions. The owner accepted D-030-1..14.
- 2026-11-07: the owner put `file_upload` and `upload_image` into child frames under FR-454 (plan item
  O-030-1).
- 2026-11-07: after measurement T886, the owner approved two changes:
  - the browser's site decides, and a frame's own report is never consulted (D-030-5, FR-451, Story 3);
  - coordinate actions take the frame's site from the same browser data, not from the debugger's
    description (FR-451).
- 2026-11-07 (review CR-I1, T908): keys sent with no target (`type` or `key` without a target, `computer`
  type or key without a coordinate) are decided by the frame that holds focus, and no longer by the page's
  site. Every frame is asked where focus is. The browser's frame and document ids name the frame found, and
  its sender origin gives its site. Focus in the top document, or in a child the browser gives the page's
  site, is decided by the page as before. A frame that cannot be named is unknown and asks. Focus is read
  again right before the first key, and a change gives the frame-moved answer.

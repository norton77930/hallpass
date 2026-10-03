# Feature Specification: A Session Site Plan — The Agent Names Its Sites Up Front, the Owner Approves Once

**Feature Branch**: `017-session-site-plan` (git: `worktree-relay-no-cross-browser-supersede`, from
`main` at 701c333 plus the two-browser relay fix 8ff9ee8)

**Feature Directory**: `specs/017-session-site-plan`

**Created**: 2026-10-02

**Status**: Approved by the owner 2026-10-02 (FR-257 answered: D-017-9); planning

**Input**: Owner discussion on 2026-10-02 after the reference gap review: "讓 agent 事先聲明要用哪些網站
… 感覺可以先作吧? 你分析及評估看看", followed by the main session's analysis and the owner's "C 照你的建議做".
The reference reading behind this feature is the private evidence for 017.

**Owner decisions (2026-10-02)**:

- **D-017-1 — The agent proposes, only the owner approves.** A new tool lets the agent name the sites
  it intends to work on and why; nothing is granted until the owner approves it in the side panel. No
  caller-side switch, setting or argument can approve on the owner's behalf.
- **D-017-2 — One card, untick per site.** The proposal is shown as one card listing every site with
  the stated purpose (and steps, if given). The owner can untick individual sites and then approve
  the rest, or decline the whole proposal.
- **D-017-3 — The approval belongs to one agent session.** It ends when that session ends, when the
  owner unpairs that agent, or when the browser restarts. It is never written to the remembered site
  list. Interrupting a step keeps it.
- **D-017-4 — What it covers.** On an approved site, the session's page actions (pressing, typing,
  keys, scrolling, hovering, dragging, filling fields, accepting a dialog, and the same steps inside a
  batch) run without a per-action consent card.
- **D-017-5 — What still asks.** Running page JavaScript and putting files into a page keep their own
  consent even on an approved site.
- **D-017-6 — Unlisted sites are unchanged.** A site outside the approved list behaves exactly as
  today (its site mode applies; the default still asks). It is not refused outright.
- **D-017-7 — Sites are exact origins**, as everywhere else in Hallpass: scheme, host and port. A
  proposal holds at most 10 sites.
- **D-017-8 — Version 0.10.0.** Authorization change: code review and architecture review before
  release (owner's R2 path).
- **D-017-9 — "Follow a plan" sites are covered by an approved session plan** (owner, 2026-10-02,
  option A): the owner has just approved the site for this session, so no per-batch card on top.

## Why this feature exists

Today, on a site left at the default mode, every page action raises its own consent card. A task that
touches four sites ("check the issue on the tracker, look up the package, read the docs, update the
form") raises a card for every press on every site, or the owner has to change four site modes in the
panel — which are remembered for every future agent and every future task, a far wider grant than this
one task needs. The existing "follow a plan" mode approves one batch on one site, which does not match
a task that moves between sites.

The reference products let the agent state its sites up front and the user approve once (private
evidence 017 §1–§3). Hallpass takes the idea with its own consent model: the owner, not the caller,
approves; the approval is narrower than a remembered mode (one session, the listed origins, page
actions only); and anything outside the list keeps asking as it does today.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner approves a multi-site task once (Priority: P1)

An agent is about to work across three sites. Before acting, it proposes the three sites and a
one-line purpose. The panel shows one card listing them; the owner approves. The agent then presses,
types and fills fields on those three sites without any further card.

**Why this priority**: it is the whole value of the feature — one decision instead of one per action.

**Independent Test**: with all three sites at the default mode, the agent proposes them, the owner
approves, and a scripted run of ten page actions spread over the three sites raises zero consent
cards; the proposal answer lists exactly the three approved sites.

**Acceptance Scenarios**:

1. **Given** a paired session and three sites at the default mode, **When** the agent proposes them
   with a purpose, **Then** the panel shows one card naming the agent's session, every site, and the
   purpose, and the agent's call waits for the owner.
2. **Given** that card, **When** the owner approves, **Then** the agent's call answers with the list
   of approved sites, and the session card shows that a site plan is active.
3. **Given** an approved plan, **When** the agent presses, types or fills a field on a listed site,
   **Then** no consent card appears and the action runs as it would under the owner's allow.
4. **Given** an approved plan, **When** the agent runs a batch whose steps are all on listed sites,
   **Then** no per-step or per-batch card appears.

---

### User Story 2 - The owner keeps control of what is in the list (Priority: P1)

The owner sees every proposed site before approving, can untick any of them, or can decline the whole
proposal. The card warns that a web page can try to steer an agent into asking for more than the task
needs.

**Why this priority**: an approval that hides part of what it grants is not consent; this is the
safety half of story 1.

**Independent Test**: the agent proposes four sites; the owner unticks one and approves; the answer
lists three; an action on the unticked site raises a card as before. A second proposal declined
answers "declined" and grants nothing.

**Acceptance Scenarios**:

1. **Given** a proposal of four sites, **When** the owner unticks one and approves, **Then** only the
   three ticked sites are approved and the answer says which one was left out.
2. **Given** a proposal, **When** the owner declines, **Then** the answer says it was declined and the
   session's consent behaviour is unchanged.
3. **Given** a proposal with no site ticked, **Then** approve is not available.
4. **Given** any proposal, **Then** the card says, in the owner's language, that web pages can try to
   steer an agent and that only sites expected for the task should be approved.

---

### User Story 3 - The approval ends with the session and can be withdrawn (Priority: P2)

The approval never outlives the work it was given for. It disappears when the session ends, when the
agent is unpaired, or when the browser restarts. While it is active the owner can withdraw it from the
session card.

**Why this priority**: a narrow grant is only narrow if it reliably ends.

**Independent Test**: approve a plan; end the session; a new session of the same agent acting on the
same site raises a card. Approve again; withdraw it on the session card; the next action raises a
card. Approve again; interrupt a step; the following action raises no card.

**Acceptance Scenarios**:

1. **Given** an approved plan, **When** the session ends (agent closes, owner stops it, relay drops
   it), **Then** the approval is gone and a later session's actions on those sites ask as before.
2. **Given** an approved plan, **When** the owner unpairs the agent, **Then** the approval is gone.
3. **Given** an approved plan, **When** the browser restarts, **Then** the approval is gone.
4. **Given** an approved plan, **When** the owner presses "withdraw site plan" on the session card,
   **Then** it is gone at once and the next action on a listed site asks.
5. **Given** an approved plan, **When** the owner interrupts a step, **Then** the plan stays.

---

### User Story 4 - Everything outside the plan behaves as before (Priority: P2)

Page JavaScript and file uploads still ask on listed sites; unlisted sites follow their site mode;
other sessions are not affected; the cross-site checks added in 014 still apply.

**Why this priority**: the feature must not widen anything it does not name.

**Independent Test**: with a plan approved for site A only, `evaluate` on A raises its card, a file
upload on A raises its card, a press on unlisted site B raises its card, and a second session pressing
on A raises its card.

**Acceptance Scenarios**:

1. **Given** a plan covering A, **When** the agent runs page JavaScript on A, **Then** its consent card
   appears as today.
2. **Given** a plan covering A, **When** the agent puts a file or a screenshot into a page on A,
   **Then** the upload's own consent applies as today (directory and site).
3. **Given** a plan covering A, **When** the agent acts on B (not listed, default mode), **Then** B's
   consent card appears.
4. **Given** a plan in session 1, **When** session 2 acts on A, **Then** session 2 is asked.
5. **Given** a plan covering A, **When** a page on A moves the tab to unlisted B, **Then** the 014
   cross-site confirmation behaves as today.

### Edge Cases

- **Panel closed when the proposal arrives**: the card waits the same way other questions do (the
  agent is told the panel is closed, the toolbar shows the waiting mark, the longer first-run wait
  applies — 011).
- **Owner never answers**: the call ends the way other unanswered cards end, with "no answer"; nothing
  is granted.
- **A second proposal while a plan is active**: shown as a new card listing the new sites, marked
  against what is already approved; approving it **replaces** the active plan; declining it keeps the
  active plan.
- **Invalid entries**: a non-web scheme, an address that is not an origin (path, wildcard, opaque
  origin), more than 10 sites or duplicates are refused before any card, with the reason named.
- **A listed site the owner set to "do not ask"**: unchanged; the plan adds nothing there.
- **A listed loopback address**: allowed like any other origin (the owner sees it on the card).
- **The agent proposes, then the session ends before the owner answers**: the card is withdrawn.
- **Worker restarts while a plan is active**: the plan survives (it lives as long as the browser run).
- **Two browsers**: the plan belongs to the browser in which it was approved.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-249**: The agent tool set MUST include a tool by which an agent proposes a site plan: a list of
  1–10 web origins, a short purpose (required, ≤ 200 characters), and optionally up to 10 short step
  descriptions. The tool's description MUST tell the agent that the owner decides and that page
  JavaScript and uploads still ask.
- **FR-250**: Origins MUST be validated before any card: http or https only, exact origin form (no
  path, query, fragment, wildcard or opaque origin), no duplicates, at most 10. A refused proposal
  MUST name the first offending entry and the rule it broke.
- **FR-251**: A valid proposal MUST raise exactly one side-panel card that names the session (as the
  session card does, 016), lists every proposed site with a tick box (all ticked initially), shows the
  purpose and steps, and states that web pages can try to steer an agent so only sites expected for
  the task should be approved.
- **FR-252**: The card MUST offer Approve (enabled only when at least one site is ticked) and Decline.
  The agent's call MUST answer with the approved origins and the ones left out, or with "declined",
  or with the ordinary no-answer outcome.
- **FR-253**: No input from the agent, the MCP server or the host MUST be able to approve a plan; only
  the owner's action in the side panel can.
- **FR-254**: While a plan is approved for a session, a page action by **that session** on a tab whose
  current top-level origin is in the plan MUST be admitted without a consent card. Page actions here
  are: press (all click variants and the coordinate equivalents), type, key, scroll, hover, drag, form
  filling, accepting a page dialog, and the same steps inside a batch.
- **FR-255**: Running page JavaScript and putting files or screenshots into a page MUST keep their own
  consent unchanged on approved sites.
- **FR-256**: Actions on origins not in the plan, and actions by any other session, MUST behave
  exactly as without the plan.
- **FR-257**: Interaction with remembered site modes: a site set to "do not ask" is unchanged; a site
  left at the default is covered by FR-254; a site set to "follow a plan" that is in the approved list
  is covered too — its page actions and batches run without the per-batch plan card for that session
  (D-017-9).
- **FR-258**: The approval MUST end when the session ends (any cause), when the owner unpairs the
  agent, and when the browser restarts. It MUST survive an interrupt and a worker restart. It MUST
  never be written to the remembered site list.
- **FR-259**: While a plan is active, the session card MUST show it (number of sites, expandable to
  the list) with a "withdraw site plan" action that ends it at once.
- **FR-260**: A new proposal while a plan is active MUST be shown as a new card that marks which sites
  are already approved; approving it replaces the active plan; declining leaves the active plan.
- **FR-261**: A proposal pending when its session ends MUST have its card withdrawn.
- **FR-262**: The 014 cross-site confirmation and the transition rules MUST be unchanged by a plan.
- **FR-263**: Approving, replacing, withdrawing and the end of a plan MUST each add one line to the
  session's activity list (008 FR-114 style).
- **FR-264**: The card and the session-card summary MUST exist in en-US and zh-TW, meet the panel's
  existing contrast and keyboard rules (006), and render in light and dark.
- **FR-265**: An older extension paired with a newer host (or the reverse) MUST degrade cleanly. The
  agent's tool list is fixed when the agent starts, before any pairing says which extension is on the
  other side, so the tool is always listed; a call that reaches an extension that has not said it
  supports site plans MUST answer a named "unavailable" outcome whose hint says to reload the
  extension, and MUST raise no card and grant nothing (the 014 upload-directory precedent). An older
  host never offers the tool. (Amended 2026-10-02 during planning, R-251.)

### Key Entities

- **Site plan proposal**: the agent's request — session, origins (1–10), purpose, optional steps,
  received time; pending until the owner answers, the call ends, or the session ends.
- **Session site plan**: the owner's approval — session, approved origins, approved time; lives for
  the session within one browser run; never persisted beyond it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-121**: A scripted task with ten page actions over three default-mode sites raises exactly one
  card (the plan) instead of ten.
- **SC-122**: With a plan for one site, page JavaScript, a file upload, an action on an unlisted site,
  and an action by a second session on the listed site each still raise their card (4 of 4).
- **SC-123**: After a session ends, an unpair, a browser restart, or a withdraw, the next action on a
  formerly listed site raises a card (4 of 4 cases).
- **SC-124**: In every approval the owner sees the complete site list before the approve control is
  usable, and an unticked site is never approved (verified on the packaged extension).
- **SC-125**: No combination of agent arguments approves a plan without the owner's press (contract
  and unit tests over the tool's argument space and the panel command set).
- **SC-126**: A real agent session (paid probe S17) given a three-site task proposes a plan first and
  completes the task with one owner decision.

## Assumptions

- "Site" means exact origin, matching how every other Hallpass site rule works (014 decision); the
  owner lists `https://github.com` and `https://gist.github.com` separately if both are needed.
- A plan is per session and per browser run, stored for the browser run only, like the 014 per-session
  transition allowances; unpair clearing it is new behaviour for this store (the 014 store is not
  cleared on unpair — not changed here).
- Reading pages (read_page, find, get_page_text, screenshots, console/network with their own grant)
  is unaffected: reads never needed a card.
- `navigate` stays as today: the agent's own named navigation is not gated, and the plan does not
  change the transition rules.
- The tool is offered to every agent; agents that do not use it see no change.
- One paid probe (S17) at release; everything else is verified free (unit, contract, packaged gate on
  Playwright Chromium in attach mode with a real side panel, plus the owner's branded Chrome run).

## Out of Scope

- Refusing actions outside the plan (the reference's behaviour) — deliberately not adopted (D-017-6).
- A caller-side way to pre-approve sites, or any approval outside the panel.
- Wildcards, subdomain or registrable-domain matching.
- Remembering a plan across sessions or browser restarts; a settings page (D-014-3).
- Changing what page JavaScript or uploads require.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-10-03 | Reading recorded, no FR text changed: FR-251/FR-259's "lists every site" is shown in the owner's script when an origin has an internationalised label - the panel renders `https://例え.jp (xn--r8jz45g.jp)`, Unicode first and the ASCII host always beside it, so a look-alike label cannot pass as a familiar name; a label that does not decode cleanly (or decodes to control, format or space characters) is shown as the ASCII origin alone. Display only: the stored plan, the gate and every panel command keep the canonical ASCII origin. The same rule covers the per-action consent card, the plan card, activity lines and the site and transition lists. | 017 coverage follow-up, code review 2026-10-03 |
| 2026-10-03 | Reading recorded, no FR text changed: FR-259/FR-260 read the session's plan the way FR-254 admits under it - only while the session still belongs to the agent the plan was approved for; a session id re-announced by another agent shows no plan and marks nothing already approved. Unticked sites on the card survive the card leaving and regaining the question slot (R-247). | 017 coverage follow-ups (review M1) |

# Feature Specification: First-Run Visibility

**Feature Branch**: `011-first-run-visibility` (git: `feature-011-first-run-visibility` in the
`feature-008-spec` worktree, from `main` at fc8831e)

**Feature Directory**: `specs/011-first-run-visibility`

**Created**: 2026-09-21

**Status**: Implemented 2026-09-21 (see coverage.md); owner decisions D-011-1 to D-011-5 taken 2026-09-21 (below);
(D-011-5, the pointer upgrade) after the owner has watched the current pointer; ready for
`/speckit-plan`, whose research must include two measurements (R-160, R-161) before implementation.

**Input**: Owner observation of 2026-09-21: "the first time the agent opens the browser, the side
panel on the right is not open; the person has no idea they must go there and click Accept, and the
call times out." And: "I want the pointer to move to the target before acting" — which the reading
below shows already exists in a first form the owner has not yet seen.

**Owner decisions (2026-09-21)**:

- **D-011-1** — Feature 011 = side-panel discoverability + the pointer's approach; the viewport /
  zoom / upload_image work moves to 012.
- **D-011-2** — Attention mechanisms: **A** (the agent is told, in words it will relay to the person
  at the terminal, that the side panel is closed and how to open it) and **B** (the toolbar icon
  carries a badge and a title while a prompt waits). **C** (an in-page banner) is recorded as a
  follow-up if consent cards are still missed later; **D** (system notifications) is not done: it
  needs a new permission the zero-permission forms make unnecessary (Constitution V).
- **D-011-3** — While no panel is connected, a pairing or consent request waits up to **2 minutes**
  with a progress notice every 5 seconds; while a panel is connected the existing bounds stay (45 s
  pairing, 25 s consent).
- **D-011-4** — The pointer: the owner watches the current glide on a real site first; the upgrade
  to a curved path with a spring settle is specified below but gated on D-011-5.

**Amendment (2026-09-24, owner-reported defect, fixed in bfae830)**:

- **D-011-6** — "No panel is connected" in D-011-3, FR-146, FR-147, FR-148 and the Attention state
  means **no Hallpass panel is open in the window the person is using** — the browser's last-focused
  normal window — not "no panel document exists anywhere". Observed 2026-09-23 during an owner demo:
  a panel open in another window counted as connected, so the pairing card was drawn where nobody was
  looking, the badge stayed off, the 45 s bound applied and the calls ended `not-paired: no answer`.
  The panel reports its own window when it connects; the worker follows window focus. A panel whose
  window is not yet known counts as not visible (the person is told rather than left waiting).
  Cards are still delivered to every connected panel. Live-verified on branded Chrome 2026-09-24:
  panel closed → bound 120 s with the closed-panel sentence and the badge shown. Not yet exercised
  live: the panel-in-another-window arrangement itself (unit-tested). *Live-verified 2026-09-24:*
  panel in window B, owner in window A → 120 s, closed-panel sentence and badge.
- **D-011-7 (2026-09-24, owner-approved follow-up)** — The bound was chosen once, when the question
  was raised: a card raised while the person was in the panel's window kept the 45 s / 25 s bound even
  after they moved to another window, so the badge came on but the wait stayed short (observed live
  2026-09-24). When the panel stops being visible while a pairing or consent question waits, that
  question MUST from then on behave as one raised with no panel visible: the progress notice with the
  where-to-click sentence starts, and the wait is extended to 2 minutes counted from when the question
  was raised. The reverse is unchanged: a panel becoming visible never shortens a running bound
  (edge case above).

**Authoritative Source Order**: Constitution (IV explicit uncertainty, V least privilege, VII
observable, XI defined failure) → `docs/product-requirements-draft.md` PR-020 (pairing) and the
draft candidate FR-017 (attention-required notification, chosen here in its in-product,
zero-permission form) → the owner's decisions → `docs/design-notes.md` §8 (read
2026-09-21) → the repository's own code as read on 2026-09-21 (facts cited inline).

## Why this feature exists

Pairing and every consent question are answered in the side panel, and Chrome opens the side panel
only in response to a user gesture — a click on the toolbar icon or the keyboard shortcut. The
first time an agent calls a tool, nothing has happened in the browser that counts as a gesture, so
the worker cannot open the panel itself; the pairing card is drawn into a panel nobody has opened,
the agent waits 45 seconds, and the call ends in `not-paired: no answer`. The person at the
terminal sees a timeout and no instruction. The same happens later for a consent card whenever the
panel has been closed.

The two reference extensions have the same structure and no answer to it (design notes §8): their
pairing and permission UI lives in the panel bundle and runs only while the panel is open. So this
feature designs the answer: make the waiting request visible where the person is looking (the
terminal, through the agent; the toolbar, through the icon), give them time to act, and make sure
the request does not die on the way.

The second half is smaller. The pointer that shows "where the agent is about to act" already
glides between targets and the click waits for it to arrive (004/T127). The owner asked for that
behaviour believing it absent; the right next step is to watch it, then decide whether the
reference's curved path and spring settle are worth adding.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The first call tells the person where to click (Priority: P1)

A person starts a coding agent that uses Hallpass for the first time on this browser. The side
panel is closed. The agent's first tool call raises the pairing request; within seconds the agent
tells the person, in its own reply, that Hallpass is waiting for them to accept the pairing in
Chrome's side panel and how to open it (click the Hallpass icon in the toolbar, or press Alt+A).
The toolbar icon shows a badge. The person opens the panel, sees the pairing card already there,
clicks Accept, and the same tool call completes.

**Why this priority**: it is the observed failure, and it happens to every new user on their very
first call.

**Independent Test**: with no panel open, start `claude -p` (or any MCP client) and call one
tool; assert the agent's reply names the side panel and the two ways to open it, the toolbar badge
is set, and the call succeeds once the panel is opened and Accept is pressed within two minutes.

**Acceptance Scenarios**:

1. **Given** no side panel document is connected to the worker and the agent is not yet paired,
   **When** the agent calls any tool, **Then** within 6 seconds the agent receives a message that
   says the side panel is closed, that the pairing needs an answer, and how to open the panel
   (toolbar icon or Alt+A); the message is one the agent will relay verbatim.
2. **Given** the same, **When** the person opens the panel within 2 minutes and presses Accept,
   **Then** the original call completes with the tool's normal result — it is not answered
   `timed-out` and it is not necessary to call again.
3. **Given** the same, **When** nobody opens the panel for 2 minutes, **Then** the call ends
   `timed-out` with a reason that repeats where to click, and the next call raises the pairing
   again (today's behaviour, FR-059).
4. **Given** a panel is already connected, **When** the agent's first call raises the pairing,
   **Then** the existing 45-second bound applies and no "panel closed" message is sent.

---

### User Story 2 - A consent card the person cannot see is not silently lost (Priority: P1)

A paired agent is working; the person has closed the side panel. The agent's next effect on an
`ask` site raises a consent card. The agent is told the panel is closed and how to open it; the
icon shows the badge; the card waits up to 2 minutes; when the panel opens the card is the first
thing shown; the badge clears when the card is answered, expires, or the panel opens.

**Why this priority**: identical mechanism to story 1, and it recurs for the whole life of a
session, not only at the start.

**Independent Test**: pair, close the panel, call `click` on an `ask` site; assert the message,
the badge, the wait, the card's presence on opening the panel, and the badge clearing.

**Acceptance Scenarios**:

1. **Given** no panel is connected and a session holds a tab on an `ask` site, **When** the agent
   calls an effect tool, **Then** the agent receives the "panel closed" message within 6 seconds and
   the toolbar badge is set.
2. **Given** the card is waiting, **When** the person opens the panel, **Then** the card is shown at
   the top immediately (no reload, no second call), and the badge clears.
3. **Given** the card is waiting, **When** the person answers it, **Then** the call completes with
   the effect's normal result and the badge clears.
4. **Given** the card is waiting and nobody opens the panel, **When** 2 minutes pass, **Then** the
   call ends `timed-out` / `no-answer` and the badge clears; a later Allow is refused as today
   (a timed-out prompt is dead).
5. **Given** a panel is connected, **When** a consent card is raised, **Then** the 25-second bound
   applies, no badge is set and no "panel closed" message is sent.
6. **Given** the badge is set, **When** the person opens the panel by clicking the icon, **Then**
   the click opens the panel as it does today; the badge never replaces the icon's ordinary
   behaviour.

---

### User Story 3 - The pointer's approach reads as an approach (Priority: P3)

A person watching the browser sees, before every click, hover, drag or keystroke, a pointer arrive
at the target and pause there, so the page's reaction always follows a visible cause. The owner
first watches the present form on a real site; if it is judged too abrupt, the pointer follows a
gently curved path whose duration grows with the distance, settles with a small overshoot, and the
action waits for the settle.

**Why this priority**: the present form already satisfies the observable requirement (visible
pointer, arrival before the press); the upgrade is a matter of feel that the owner has to judge.

**Independent Test**: on the packaged gate, record a GIF of three clicks at increasing distances;
assert a pointer is drawn before each press and that press timestamps follow the pointer's
arrival; for the upgraded form, assert the path is not a straight segment and the duration scales.

**Acceptance Scenarios**:

1. **Given** a held tab, **When** the agent clicks two targets 800 px apart, **Then** the pointer
   is visible, moves from the first to the second, and the second press is dispatched only after
   the movement ended (already true today; pinned as the baseline).
2. **Given** D-011-5 = upgrade, **When** the same click happens, **Then** the pointer's path is
   curved, its travel time is between 200 ms and 600 ms depending on the distance, it overshoots
   and settles within 100 ms, and the press follows the settle.
3. **Given** D-011-5 = keep, **Then** no change; the evidence and the comparison page are corrected
   to say the glide exists.

---

### Edge Cases

- The panel is connected in another window than the one holding the tab: it counts as connected
  (every panel document receives every projection since 2026-09-16); the ordinary bounds apply.
- The panel opens after the "panel closed" message was sent but before the person answers: the
  message is not retracted; the card is there; the bound already running continues to its 2-minute
  end (it does not shrink to 25 s mid-wait).
- The MCP client enforces its own per-call bound (the host's code notes 60 s for Claude Code): the
  design MUST NOT let that bound expire the call while the person is still within the 2 minutes —
  see FR-150 and R-161.
- Two sessions raise prompts while the panel is closed: each gets its own message; the badge is one
  badge (a count is unnecessary).
- The worker is recycled while the badge is set: the badge is browser state and survives; the
  worker re-derives "is a prompt pending" on wake and clears a stale badge.
- The person has no toolbar icon pinned: the message still names Alt+A; nothing else can be done
  without a new permission (D-011-2).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-146**: When a pairing request or a consent prompt (ask, plan, dialog accept, diagnostics
  grant) is raised while no side-panel document is connected, the worker MUST send, within
  6 seconds (the first notice is sent at 5 s), a fixed sentence saying that the panel is closed, what
  is waiting, and how to open the panel (toolbar icon, Alt+A). The sentence reaches the **MCP
  client** as a progress message (a client may show it to the person; none hands it to the model
  mid-call — a model receives text only when a tool call ends, which is a property of every LLM
  tool loop, not of one client, as the owner observed on 2026-09-21) and reaches the **agent** at the
  latest when the call ends: as the normal result if the person answered in time, as `hint` on the
  `timed-out` outcome if not — in a form the agent can relay verbatim.
- **FR-147**: In the same state the extension MUST set a toolbar badge and title that say a
  question is waiting, and MUST clear them when the prompt is answered, expires, or a panel connects.
- **FR-148**: In the same state the request MUST wait up to 2 minutes for an answer, with a progress
  notice to the agent at least every 5 seconds; when a panel is connected the existing bounds
  (45 s pairing, 25 s consent) apply unchanged.
- **FR-149**: A panel that connects while a request is waiting MUST show that request first, without
  a second call from the agent.
- **FR-150**: The design MUST NOT let the MCP client's own per-call bound end the call before the
  2-minute wait does; the plan chooses between keeping the client's bound alive with progress
  notifications and answering early with a "waiting, call again" outcome, on the basis of a
  measurement (R-161), and the chosen form is recorded here before implementation.
  **Resolved 2026-09-21 (R-161)**: the call is held; Claude Code's bound is hours, not 60 s; the
  host's own 30 s backstop is extended by the worker's `prompt-waiting` frames (plan R-162).
- **FR-151**: The badge, the title text and the relayed message MUST NOT carry page content or the
  agent's arguments — only that a question of a named kind is waiting.
- **FR-152**: If Chrome accepts a worker-initiated `sidePanel.open()` on this event (R-160 measures
  it), the worker MUST open the panel and FR-146/147 become the fallback for when it refuses; if
  Chrome refuses, FR-146/147 are the behaviour and no further attempt is made.
  **Resolved 2026-09-21 (R-160)**: refused on Chromium 151 ("may only be called in response to a
  user gesture") for every form tried; FR-146/147 are the behaviour.
- **FR-153**: Before every pointer effect on a held tab, a pointer MUST be visible at the target and
  the effect MUST be dispatched only after the pointer's movement ended (baseline, already true).
- **FR-154** *(only if D-011-5 = upgrade)*: The pointer's movement MUST follow a curved path, last
  between 200 ms and 600 ms scaled by distance, and settle with a short overshoot; the effect waits
  for the settle. The reduced-motion preference MUST shorten the movement to the present 200 ms
  straight glide.
- **FR-155**: The comparison page and the design notes MUST describe the pointer's actual behaviour
  (the glide exists since 004; the upgrade if done).

### Key Entities

- **Pending question**: kind (pairing | ask | plan | dialog | diagnostics), session, raised-at,
  bound (25 s / 45 s / 120 s), whether a panel was connected when raised.
- **Attention state**: badge text + title, derived from "any pending question and no panel
  visible" (D-011-6); cleared on answer, expiry, or a panel becoming visible (connecting in, or focus
  moving to, the person's window).
- **Panel presence**: the set of connected panel documents, each with the window it reported;
  *visible* = one of them is in the last-focused normal window (D-011-6). Wherever this spec says
  "no panel connected" / "panel closed", read "no panel visible".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-078**: In a probe with the panel closed (`claude -p`, real MCP), the agent's reply to its
  first call names the side panel and both ways to open it, within 6 s of the call (1/1; the first notice is sent at 5 s).
- **SC-079**: The same call completes successfully when the panel is opened and Accept pressed at
  90 s (1/1); it ends `timed-out` with the where-to-click reason at 120 s when nobody acts (1/1).
- **SC-080**: The toolbar badge is set while a question waits with the panel closed and cleared on
  answer / expiry / panel connect (gate: 3/3 transitions).
- **SC-081**: With a panel connected, bounds are unchanged: pairing 45 s, consent 25 s (existing
  tests stay green; one case pins that no message is sent).
- **SC-082**: R-160 and R-161 each have a recorded measurement with the Chrome version and the
  client used, before any implementation of FR-150/FR-152.
- **SC-083**: A GIF of three clicks shows the pointer before each press; press timestamps follow
  arrival (gate: 3/3). If upgraded: path curvature and duration scaling asserted (3/3).
- **SC-084**: Unit, contract and snapshot check stay green; no new manifest permission.

## Assumptions

- Chrome's user-gesture rule for `sidePanel.open()` holds on Chrome 153 unless R-160 shows
  otherwise; the reference bundles calling it programmatically is a hint, not evidence.
- The MCP progress notification is delivered by Claude Code; whether it extends the client's bound
  is R-161's question. **Corrected by the T299 probe (2026-09-21)**: Claude Code does not surface
  MCP progress messages to the model at all (only its own elapsed-time heartbeats), so in Claude Code
  the sentence reaches the person at expiry through `hint`; the badge is the cue during the wait.
  SC-078's "within 6 s" holds at the MCP layer (gate) and is not observable at the model layer in
  Claude Code.
- The badge text is short ASCII (`!`) and the title is a fixed sentence; both are zero-permission
  (`action` API).
- The person can always reach the panel via Alt+A even without a pinned icon.
- The pointer baseline is the 2026-09-16 form (200 ms eased glide, arrival wait).

## Out of Scope

- In-page banner (C), system notifications (D), a popup window for consent.
- Any change to the consent model, the site modes or what a card says.
- Viewport / zoom / upload_image (012).

## Decisions owed

- **D-011-5** — **decided 2026-09-21: keep** the present glide (the owner has seen it and is satisfied for now); the upgrade below stays specified but unscheduled. Original wording: *keep* the present glide or *upgrade*
  to the curved-path spring form (FR-154). Until decided, the plan implements US1–US2 and prepares
  US3's GIF measurement only.

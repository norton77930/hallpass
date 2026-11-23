# Feature Specification: 043 page scripts on a local dev site: say how to stop the questions, then offer "this session" on loopback

**Feature Branch**: `worktree-spec-evaluate-consent`
**Created**: 2026-11-23
**Status**: Approved (US1 owner 2026-11-23 "開始, 但應該要用spec-kit流程"; US2 and FR-623 owner 2026-11-23 "Q1 : A / Q2 : 依照妳建議" - loopback is exactly three hosts, US2 is built and closes only after a code review)
**Input**: Owner report 2026-11-23: testing a local app on `http://localhost:3001`, the terminal asks
"allow claude-code (…) to run a script on the page on http://localhost:3001?" on every `evaluate` call,
offers only *Allow once* and *Deny*, and says nothing about how to stop asking.

Numbering starts at FR-620, SC-280, R-580 and T1200, leaving room above what the unmerged spec 042 uses
(FR-609, SC-275, R-567, T1181).

## What happens today

An agent's `evaluate` call passes two questions:

1. **Diagnostics** (031 D-031-9): may the agent attach debugging to this site at all. The terminal offers
   *once*, *this session*, *deny*. The side-panel card also offers *always* (the site's diagnostics
   checkbox). Answering *this session* stops this question for the session.
2. **The effect question** "run a script on the page" (003 gate, 017 FR-255, 031 D-031-8 / FR-470):
   is asked on **every call** unless the site's mode is *skip checks*. The terminal offers *once* and
   *deny* only. The side-panel card offers *once*, *Always allow on <site>* (which sets *skip checks*)
   and *deny*. No *this session* exists for it anywhere, by design: a script can do everything a click
   can, and more.

The owner, at the terminal, sees only question 2's two answers. The way to stop it - the panel's
*Always allow on <site>* or the settings page's *Skip checks* - is in the browser, and the terminal does
not say so. 031 D-031-2 keeps it that way on purpose: the agent's client is the party being gated, so a
decision that outlives the session is never offered there.

## Decisions

- **D-043-1 (US1)**: the terminal question that offers no *this session* says where the longer decision
  lives. It names the side-panel button and the settings-page mode in the words those screens use. It is
  text in the message, never a choice: D-031-2 is unchanged.
- **D-043-2 (US1)**: the hint is shown only where the browser actually offers that decision: an effect
  question on a known site. A frame whose site is unknown has no *always* (030 FR-458) and gets no hint.
  Questions that already offer *this session* (page actions, diagnostics, a moved tab, a site plan) get
  no hint.
- **D-043-3 (US2, approved)**: on a loopback site only, the effect question for page JavaScript also
  offers *this session*, in the terminal and on the panel card. It is a grant of its own kind (scripts),
  separate from the page-actions grant, so *this session* for clicks never admits a script and the other
  way round. It ends with the session (031 FR-469).
- **D-043-5 (US2, owner chose option A)**: loopback is exactly the hosts `localhost`, `127.0.0.1` and
  `[::1]`. Subdomains of `localhost` and the rest of `127.0.0.0/8` were offered (options B and C) and not
  chosen: the narrowest list is the easiest to check and covers ordinary local development.
- **D-043-4 (US2, approved)**: every other site keeps 017 FR-255 and 031 FR-470 unchanged. File and image
  uploads, a forced leave and closing a tab are unchanged on every site, loopback included.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - the terminal question says how to stop being asked (Priority: P1)

The owner is at the terminal. An agent runs a page script on `http://localhost:3001`. The question in the
terminal still offers *Allow once* and *Deny*, and its text now also says that the side panel's
*Always allow on http://localhost:3001* or the settings page's *Skip checks* stops the questions on that
site, and that this lets every action there run without asking.

**Why this priority**: it removes the dead end with no change to who may decide what. It ships on its own.

**Independent Test**: raise an `evaluate` effect question on a known site with a client that advertises
form elicitation, and read the message the client receives.

**Acceptance Scenarios**:

1. **Given** an `evaluate` effect question on `http://localhost:3001`, **When** the terminal is asked,
   **Then** the message names the action and the site as today, and adds the hint naming
   *Always allow on http://localhost:3001* in the side panel and *Skip checks* on the settings page.
2. **Given** a `file_upload`, `upload_image`, forced `navigate` or `tabs_close` question on a known site,
   **When** the terminal is asked, **Then** the same hint is present (these offer no *this session*
   either).
3. **Given** a click question on a known site (which offers *this session*), **When** the terminal is
   asked, **Then** the message is exactly as today, with no hint.
4. **Given** a diagnostics question, a moved-tab question or a site-plan question, **Then** the message is
   exactly as today, and the moved-tab and site-plan messages still contain no "always".
5. **Given** an effect question for a frame whose site is unknown, **Then** no hint is added.
6. **Given** any question with the hint, **Then** the choices are exactly those the worker offered:
   the hint adds no choice.

### User Story 2 - "this session" for page scripts on a local dev site (Priority: P2, governance)

The owner develops a web app served from their own machine. An agent runs page scripts there many times.
The first `evaluate` effect question on that loopback site offers *Allow on this site for this session*
in the terminal and *This session* on the panel card. After the owner picks it, later `evaluate` calls by
that session on that site run without a question until the session ends.

**Why this priority**: it removes the repeated question where the risk is lowest, without the
all-actions waiver that *skip checks* is. It changes a consent rule, so it waits for the owner's ruling
and a review (R2, REVIEW.md "a change to how consent, a grant or a permission rule decides").

**Independent Test**: with a loopback page and a non-loopback page, answer *this session* to the first
`evaluate` question on each where offered, then call `evaluate` again on both.

**Acceptance Scenarios**:

1. **Given** a session on `http://localhost:3001`, **When** the first `evaluate` effect question is raised,
   **Then** the terminal offers *once*, *this session*, *deny* and the panel card offers *This session*
   beside its existing buttons.
2. **Given** the owner answered *this session* there, **When** the same session calls `evaluate` on any page
   of the same origin, **Then** no effect question is raised and the script runs.
3. **Given** that grant, **When** another session calls `evaluate` on the same origin, or the same session
   calls it on `http://localhost:3002`, **Then** the question is raised as today.
4. **Given** that grant, **When** the same session clicks on the same origin, **Then** the click is asked
   as today (a scripts grant admits no page action).
5. **Given** a page-actions *this session* grant for the origin, **When** the session calls `evaluate`
   there, **Then** the script question is raised as today.
6. **Given** `https://example.com` or a look-alike host such as `http://localhost.example.com`,
   `http://127.0.0.1.nip.io` or `http://[::ffff:7f00:1]`, **When** `evaluate` is asked, **Then** no
   *this session* is offered, and a client that answers `session` anyway gets *once* (031 R-456).
7. **Given** the session ends, **When** a new session calls `evaluate` on the loopback site, **Then** it is
   asked again.

### Edge Cases

- A loopback page that embeds a frame from another site: the deciding site is the frame's (030 R-444), so a
  script in a non-loopback frame is asked as today.
- A loopback tab that navigates to a non-loopback site: the grant is per origin, so the new site asks.
- The diagnostics question is unchanged and is still answered first; US2 changes only the second question.
- A site already in *skip checks* is asked nothing, as today.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-620 (US1)**: A terminal question for an effect on a known site that offers no *this session* MUST
  add a hint that names the side panel's *Always allow on <site>* and the settings page's *Skip checks*,
  and says that either one lets every action on that site run without asking (D-043-1).
- **FR-621 (US1)**: The hint MUST NOT appear on a question that offers *this session*, on a diagnostics,
  moved-tab or site-plan question, or on a question whose frame site is unknown (D-043-2).
- **FR-622 (US1)**: The hint MUST NOT change the offered choices or the answer rules of 031 (FR-468,
  FR-472): it is text only.
- **FR-623 (US2)**: A site is loopback only when its host is exactly `localhost`, `127.0.0.1` or `[::1]`
  (D-043-5), on any port, over http or https. Any other host, including names that contain or resolve to
  those (`app.localhost`, `127.0.0.2`, `[::ffff:7f00:1]`, `localhost.example.com`), is not loopback.
- **FR-624 (US2)**: On a loopback site, the `evaluate` effect question MUST offer *this session* in the
  terminal and on the panel card. On any other site it MUST NOT (017 FR-255, 031 FR-470 unchanged there).
- **FR-625 (US2)**: An Allow with *this session* on that question MUST record a scripts grant for that
  session and that origin, and it MUST admit only `evaluate` effect questions of that session on that
  origin until the session ends.
- **FR-626 (US2)**: A scripts grant and a page-actions grant MUST NOT admit each other's actions.
- **FR-627 (US2)**: A *this session* answer to a script question on a non-loopback site, from either
  place, MUST be treated as *once* and record nothing (031 R-456 holds).
- **FR-628 (US2)**: The session card's list of grants MUST show a scripts grant as its own line, with where
  it was given (031 D-031-7).

### Key Entities

- **Scripts grant (US2)**: one session, one loopback origin, where it was given (terminal or browser). Ends
  with the session. Lives beside the page-actions and diagnostics session grants.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-280**: An owner at the terminal who is asked about a page script on a known site reads, in that same
  question, the two places that stop the questions (FR-620). Pinned by unit tests on the message for each
  tool in US1 scenarios 1-2, and on the unchanged messages of scenarios 3-5.
- **SC-281**: The 031 terminal-consent and 017/031 gate tests still pass unchanged, apart from the message
  strings US1 extends.
- **SC-282 (US2)**: On a loopback site, after one *this session* answer, a run of 20 `evaluate` calls by
  that session raises 0 further effect questions. On a non-loopback site the same run raises 20.
- **SC-283 (US2)**: Every look-alike host in US2 scenario 6 is refused loopback status by a unit test, and a
  `session` answer there records no grant.

## Assumptions

- The terminal message stays English, as every 031 terminal message is today.
- The panel labels quoted by the hint are the en-US ones; the panel itself shows the owner's locale.
- US2 does not add *this session* to uploads, forced leave or tab close on loopback; a later spec can if
  the owner asks.
- Local services that are not the owner's own app (an admin page of a local tool on `127.0.0.1`) are also
  loopback; under US2 a script there still needs the owner's one *this session* answer per session.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-11-23 | Initial specification | owner 2026-11-23 |
| 2026-11-23 | FR-623 resolved to option A (D-043-5); US2 approved (D-043-3, D-043-4) | owner 2026-11-23 |

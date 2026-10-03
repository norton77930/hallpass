# Feature Specification: Several Browsers, One Bridge — the Owner Chooses Which Browser an Agent Uses

**Feature Branch**: `018-multi-browser-selection` (git: `next-round-followups`, from `main` at 9b2cb71
plus the 2026-10-03 follow-ups, which include the two-browser stand-by fixes this feature retires)

**Feature Directory**: `specs/018-multi-browser-selection`

**Created**: 2026-10-03

**Status**: Approved by the owner 2026-10-03 ("照建議": every proposed decision and the proposed answer
to each of the eight questions below, D-018-10 – D-018-14); implementing.

**Input**: Owner, 2026-10-03: asked how the reference products handle several browsers, then "完成後
下階段的任務也可以一併安排規劃及開發". Measured on 2026-10-03: two Hallpass browsers on one machine
today means one serves and the other stands by (stand-by stop-gap, `specs/017-session-site-plan/coverage.md`
"Two-browser stand-by"). The reference reading behind this feature is the private evidence for 004, §3h
(read and measured 2026-10-03).

**Owner decisions (2026-10-03)** — D-018-1 – D-018-9 as proposed, plus the answers to the spec-gate
questions:

- **D-018-10 — Upload directories are the machine user's** (Q4): the "from now on" directory list stays
  one list; it is the owner's file-system boundary, not a browser grant. Each upload still asks in its
  own browser under that browser's rules.
- **D-018-11 — The remembered choice is shared by the agents of one Windows user** (Q5), as pairing is.
- **D-018-12 — A session is bound at its first forwarded call** (Q6), not when it starts.
- **D-018-13 — A remembered browser that is offline is still the choice** (Q7): a new session is refused
  and told to ask, even if exactly one other browser is connected.
- **D-018-14 — Pairing in a browser is enough for an agent to select it itself** (Q8): pairing is the
  per-browser consent, and every site there still follows that browser's own modes.

D-018-1 – D-018-9:

- **D-018-1 — Every connected browser is served.** One bridge on the machine serves every browser that
  runs Hallpass at the same time. No browser stands by; the stand-by behaviour is retired.
- **D-018-2 — A browser has a stable identity and a name the owner chooses.** Each browser profile
  gets its own identifier the first time Hallpass runs there, kept across restarts. The owner can name
  the browser in its side panel ("Work Edge", "Personal Chrome"); until then it is named after the
  browser it is (Chrome, Edge, Brave, Chromium), numbered when two share a name.
- **D-018-3 — With one browser nothing changes.** When exactly one browser is connected, every agent
  uses it without being asked, as today.
- **D-018-4 — With several, the owner decides; the agent never guesses.** When more than one browser
  is connected and the agent has no browser chosen, a browser tool is refused with an answer that
  lists the connected browsers by name and tells the agent to ask the owner which one to use. The
  agent can list the browsers and select one by its identifier once the owner has said which.
- **D-018-5 — The choice is remembered for the agent.** The browser chosen last is used by that agent's
  later sessions too, as long as it is connected. If it is not connected, the agent is in the
  "several, none chosen" (or "one") case again.
- **D-018-6 — The owner can also choose from inside a browser.** The agent can ask for the owner's
  choice in the browsers themselves: every connected browser's side panel shows "Use this browser for
  <agent>?", and the browser where the owner confirms becomes the agent's choice. The request ends
  after two minutes without an answer.
- **D-018-7 — Each browser keeps its own consent.** Pairing, site modes, remembered moves, session site
  plans and the session's tab group belong to the browser where they were given. Choosing another
  browser never carries a grant across: the agent is paired, asked and approved there as if it were
  the first browser.
- **D-018-8 — No silent fallback.** When the chosen browser goes away during a session, the agent's
  calls are refused with an answer saying the browser disconnected; Hallpass does not move the
  session to another browser on its own.
- **D-018-9 — Version 0.11.0, owner's R2 path.** The bridge's routing decides in which browser an
  action runs — an authorization boundary. Architecture review and code review before release.

## Why this feature exists

People run more than one browser: a work profile and a personal one, Chrome and Edge side by side.
Since 0.3.0 Hallpass registers its host for every Chromium-family browser, so all of them can run it.
Until 2026-10-02 two such browsers fought over the bridge and both became unusable; the stop-gap made
the second one stand by. That keeps one browser working, but the agent cannot use the other at all,
and which one serves is decided by start order, not by the owner.

The reference products let the agent see the connected browsers and the user decide which one it
uses (measured 2026-10-03: identity per profile, a user-chosen name, "use the browser picked last",
and a refusal that tells the agent to ask when several are connected and none was chosen). Hallpass
takes the same shape with its own consent model: every grant stays in the browser where the owner gave
it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Two browsers, the owner picks one (Priority: P1)

The owner has Chrome and Edge open, both with Hallpass. A coding agent asks for its tabs. Hallpass
answers that two browsers are connected — "Chrome" and "Work Edge" — and that the agent should ask the
owner which one to use. The agent asks; the owner says "Work Edge"; the agent selects it and works
there. Chrome is untouched.

**Why this priority**: it is the whole feature: both browsers usable, the owner deciding.

**Independent Test**: two browsers connected (packaged gate with two private profiles), a fresh agent:
the first browser tool is refused with both names; after `select` by identifier the call runs in the
chosen browser only, and nothing appears in the other.

**Acceptance Scenarios**:

1. **Given** two connected browsers and an agent that never chose one, **When** it calls any browser
   tool, **Then** the call is refused, the answer names both browsers with their identifiers and tells
   the agent to ask the owner, and nothing happens in either browser.
2. **Given** that refusal, **When** the agent lists the browsers, **Then** it gets each browser's
   identifier, name, kind (Chrome/Edge/Brave/Chromium), when it connected, and which one (if any) the
   agent uses.
3. **Given** the agent selected "Work Edge", **When** it calls browser tools, **Then** every call runs
   in Work Edge; Chrome shows no tab group, no card and no change.
4. **Given** one browser connected, **When** a new agent calls a browser tool, **Then** it runs there
   with no question (today's behaviour).

---

### User Story 2 - The choice sticks, the consent does not travel (Priority: P1)

The agent used Work Edge yesterday. Today it starts a new session; Work Edge is open, so it is used
without asking. Later the owner tells it to use Chrome instead; it selects Chrome and has to be paired
there and asked for each site as if Chrome were its first browser.

**Why this priority**: remembering avoids asking every session; keeping consent per browser is the
safety line.

**Independent Test**: select browser A, end the session, start a new one: calls go to A unasked. Select
B: B shows its own pairing card; a site mode set in A does not admit an action in B.

**Acceptance Scenarios**:

1. **Given** the agent chose browser A in an earlier session and A is connected, **When** a new
   session of that agent calls a browser tool, **Then** it runs in A without a question.
2. **Given** the agent chose A and A is not connected but B and C are, **When** it calls a browser
   tool, **Then** it is refused as in US1 scenario 1.
3. **Given** the agent is paired in A and a site is set to skip checks in A, **When** it selects B and
   acts on the same site, **Then** B asks for pairing first and then follows B's own site mode.
4. **Given** a session site plan approved in A, **When** the agent selects B, **Then** the plan does
   not cover anything in B.

---

### User Story 3 - The owner chooses from inside the browser (Priority: P2)

The owner does not know which name is which. The agent asks Hallpass to let the owner choose in the
browsers; every open side panel shows "Use this browser for Claude Code?"; the owner clicks "Use this
browser" in the window in front of them.

**Why this priority**: names help, but pointing at the right window is the surest way to choose.

**Independent Test**: two browsers, the agent asks for an in-browser choice: both panels show the card;
confirming in B selects B and withdraws the card in A; no answer within two minutes ends the request
and the agent is told.

**Acceptance Scenarios**:

1. **Given** two connected browsers, **When** the agent asks for an in-browser choice, **Then** each
   browser's panel shows one card naming the agent.
2. **Given** the cards, **When** the owner confirms in B, **Then** B becomes the agent's browser, the
   card in A disappears, and the agent's request answers with B's identifier and name.
3. **Given** the cards, **When** the owner declines in every browser or two minutes pass, **Then** the
   request answers that no browser was chosen and the agent's earlier choice (if any) is unchanged.
4. **Given** a closed side panel, **Then** the existing first-run rules apply (badge, the agent told
   where to click), as for any other card.

---

### User Story 4 - The owner names the browser (Priority: P2)

In each browser's side panel the owner sees what this browser is called and can rename it. Agents see
the new name the next time they list browsers.

**Independent Test**: rename in the panel; `list` shows the new name; the name survives a browser
restart.

**Acceptance Scenarios**:

1. **Given** a browser never named, **Then** its panel and the agents' list show the default name (its
   kind, numbered when two connected browsers share it).
2. **When** the owner renames it, **Then** the panel shows the new name and later lists carry it.
3. **Given** a name, **When** the browser restarts, **Then** the name and the identifier are unchanged.

---

### User Story 5 - A browser goes away (Priority: P2)

The owner closes Work Edge while the agent is using it.

**Acceptance Scenarios**:

1. **Given** the agent's chosen browser disconnects, **When** the agent calls a browser tool, **Then**
   the call is refused with an answer saying that browser disconnected and listing the browsers still
   connected; no call runs elsewhere.
2. **Given** the browser comes back (same profile), **When** the agent calls again, **Then** the calls
   run there again without a new choice.
3. **Given** the other browser keeps running, **Then** its own sessions are unaffected by the first
   browser leaving.

### Edge Cases

- Two profiles of the same browser: two identities, two default names ("Chrome", "Chrome 2").
- A profile whose identity store was cleared: it is a new browser (new identifier, default name); the
  agents' remembered choice no longer matches and they are asked again.
- An extension older than this feature connects next to a new one: it is listed as a browser with a
  default name and is usable, but cannot take part in the in-browser choice (the request skips it).
- An agent's host older than this feature: it sees one browser (the one it reaches first); no refusal
  it cannot understand.
- Several agents: each has its own choice; two agents may use different browsers at the same time.
- A call already running when the owner selects another browser for that agent finishes in the
  browser where it started.
- Tab identifiers are per browser: after a switch, identifiers and element references from the
  previous browser are refused as unknown, never resolved in the new browser.
- More than one machine user / remote browsers: out of scope (one Windows user, one machine).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-266**: The bridge MUST serve every connected Hallpass browser on the machine at the same time;
  no browser waits for another to leave.
- **FR-267**: Each browser profile MUST have an identifier created on first run and kept across
  browser restarts and extension updates, and a display name. The default name is the browser's kind;
  when two connected browsers share it, the later one is numbered.
- **FR-268**: The owner MUST be able to see and change the browser's name in that browser's side panel
  (1–40 characters, shown as plain text everywhere). Agents MUST NOT be able to change it.
- **FR-269**: A tool MUST let the agent list the connected browsers: identifier, name, kind, connected
  since, and whether it is the agent's current browser. The list carries nothing else about the
  browser or its tabs.
- **FR-270**: A tool MUST let the agent select a connected browser by identifier. Selecting an
  identifier that is not connected MUST be refused with the list of connected browsers.
- **FR-271**: When exactly one browser is connected and the agent's session has not yet run a call in
  another browser (and, per owner question 7, has no remembered browser that is offline), browser tools
  MUST run in it without a question. A session is bound to a browser by its first forwarded call.
- **FR-272**: When several browsers are connected and the agent has no connected choice, every browser
  tool MUST be refused before anything runs, with an answer that names the connected browsers and
  tells the agent to ask the owner which to use. Hallpass MUST NOT pick one.
- **FR-273**: The browser an agent selected MUST be remembered for that agent across its sessions and
  used whenever it is connected.
- **FR-274**: A tool MUST let the agent ask the owner to choose in the browsers: each connected browser's
  panel shows one card naming the agent; the first confirmation selects that browser and withdraws
  the other cards; declining everywhere or two minutes without an answer ends the request with "no
  browser chosen".
- **FR-275**: Pairing, site modes, remembered moves, session site plans, diagnostics grants, upload
  consent answers and tab groups MUST stay with the browser where they were given; a grant in one
  browser MUST NOT admit anything in another. The "from now on" upload directory list is the machine
  user's (D-018-10) and is not a browser grant.
- **FR-276**: Every call MUST run in the browser the agent's session had chosen when the call began;
  tab identifiers and element references from another browser MUST be refused as unknown.
- **FR-277**: When the browser a session is bound to (or selected) disconnects, its calls MUST be refused
  with an answer that names the browser as disconnected and lists the connected ones — however many
  others are connected, including exactly one; nothing runs elsewhere. A browser that comes back within
  the existing attach bound (a worker restart) MUST NOT cause a refusal. When the same browser
  reconnects, the binding applies again.
- **FR-278**: An extension or host older than this feature MUST keep working as a single browser next
  to new ones; the in-browser choice skips browsers that cannot show the card.
- **FR-279**: The side panel MUST show which agents currently use this browser (existing session
  cards) and, when other browsers are connected, say so ("2 other browsers connected") without
  naming their tabs or sites.
- **FR-280**: The stand-by behaviour (one browser waits while another serves) MUST be removed once
  FR-266 holds, together with its panel text.
- **FR-281**: New and changed text MUST exist in en-US and zh-TW and follow the panel's contrast,
  keyboard and light/dark rules (as 016).

### Key Entities

- **Browser**: one browser profile running Hallpass — identifier, kind, display name, connected since,
  connected or not.
- **Agent's browser choice**: per paired agent, the identifier of the browser chosen last; it never
  holds a grant.
- **Browser choice request**: an agent's request for an in-browser choice — which agent, which
  browsers show the card, when it started, how it ended.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-127**: With two browsers running Hallpass, both serve agents: two agents each use a different
  browser at the same time, each for a full round of work (read, act, consent card) without either
  browser stopping.
- **SC-128**: With several browsers connected and no choice, 100% of browser tool calls are refused
  before any effect, and every refusal names every connected browser.
- **SC-129**: After a choice, 0 actions run in a browser other than the chosen one (gate: two browsers,
  every tool family).
- **SC-130**: A grant given in one browser admits 0 actions in another (pairing, site mode, site plan).
- **SC-131**: With one browser connected, an agent's first call needs no new step compared with 0.10.0.
- **SC-132**: The in-browser choice selects the browser the owner confirmed in, within one second of the
  click, and ends after two minutes without an answer.
- **SC-133**: One paid probe: a coding agent with two browsers connected asks the owner, selects the
  named browser and completes a one-page task there.

## Assumptions

- One Windows user, one machine; every browser runs the same Hallpass version except during an upgrade.
- The stand-by stop-gap ships in the next release first if this feature is not ready; it is retired by
  this feature.
- "Agent" is the paired agent (as in 003); its sessions share the remembered choice.
- The identity is local to the browser profile; it is not a device or account identifier and is never
  sent anywhere but the local bridge.
- The paid probe follows the 004 acceptance standard (owner-branded browser, the coding agent as caller).

## Out of Scope

- Browsers on another machine or another Windows user; a cloud relay.
- A browser identifier on every tool call (the other reference's model) — a remembered choice is used
  instead.
- Moving a running session's tabs from one browser to another.
- Sharing grants between browsers, or a setting to do so.
- macOS and Linux (issue #1).

## Questions for the owner (spec gate) — answered 2026-10-03 as proposed (D-018-10 – D-018-14)

1. **D-018-5 scope**: remember the choice per agent across sessions (proposed, like the reference), or
   only for one session (ask again every session)?
2. **D-018-6 in this feature?** The in-browser choice (cards in every panel) is US3/FR-274. Keep it in
   018 (proposed) or ship the list/select tools first and add it later?
3. **D-018-2 default name**: the browser's kind ("Edge", "Chrome 2", proposed) or a neutral "Browser 1 /
   Browser 2" like the reference?
4. **Uploads (FR-275)**: the "from now on" upload directories are one list for the machine user today.
   Keep it machine-wide and say so in FR-275 (proposed; each upload still asks in its own browser), or
   keep a separate list per browser?
5. **Whose choice**: an agent's identity is one per Windows user today, so every coding agent on the
   machine (Claude Code, Codex, …) shares the remembered browser, as they already share pairing.
   Accept (proposed) or remember per agent and client?
6. **When a session is bound**: at its first forwarded call (proposed), so a browser appearing before
   the first call still makes the agent ask; the alternative binds at start (start order decides).
7. **Remembered browser offline**: a new session whose remembered browser is offline while exactly one
   other is connected — refuse and ask (proposed: the owner wanted the remembered one) or use the one
   that is connected?
8. **Self-selected switch**: once an agent is paired in two browsers, `select` lets it move itself
   between them without the owner doing anything (the refusal text tells it to ask, but cannot make it).
   Is pairing in the target browser enough consent (proposed: yes — pairing is the per-browser consent
   and every site still asks under that browser's own modes), or must a switch to a browser the session
   has not used go through the owner (a card in that browser)?

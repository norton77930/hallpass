# Feature Specification: The Agent Build's Side Panel

**Feature Branch**: `006-side-panel` (logical feature identifier; this workspace has no Git metadata)

**Feature Directory**: `specs/006-side-panel`

**Created**: 2026-09-13

**Status**: Complete 2026-09-14 — T188–T200 done; screenshots approved by the owner (coverage.md "Runs")

**Input**: Owner direction of 2026-09-13: "目前我覺得擴充套件的 UI 有夠醜,而且分割兩個畫面不知道用途" —
after reading both reference extensions' side panels (design-notes §7), make the agent build's side panel a
status, consent and control surface for the owner: one page when nothing is connected, a short status
and a site list while paired and idle, one card per live session while agents work, pending prompts
always on top; remove the archived assistant workspace from this build; give it a real visual system,
both themes, both locales, and an accessible baseline.

**Authoritative Source Order**: Constitution → `docs/product-requirements-draft.md` (PR-005, PR-007,
PR-008, PR-020) → the reference analysis (kept in the private archive; its public summary is `docs/design-notes.md` §7).

## Why this feature exists

The side panel in the agent build stacks two generations: the 003/004 agent card (a projection of the
worker's state, laid out as specification headings) above the 001/002 assistant workspace, which was
archived on 2026-09-07 and in this build is a permanently signed-out shell. Nobody designed the result;
the owner cannot tell what the two halves are for, the card prints fixture tab titles, shows a "connect"
button while connected, and offers no way to change a site's mode or to stop one agent among several.

Both reference extensions were read for this (design-notes §7). Their panels are chats, because their
caller lives in the panel; ours does not — the caller is the coding agent's terminal. What is followable
is their **non-chat** surfaces: a single state page when the paired app is missing, a one-sentence
pairing prompt, a consent card with once / this-site-always / refuse, a flat site list with revoke, and
"where the agent is working" shown by the page (banner, tab group) rather than by a list. The one thing
neither needs and we do is several sessions at once (004 D-004-2): the panel must name each session and
offer stop and release per session.

## Owner decisions recorded before specification

Taken by the product owner on 2026-09-13, binding for this feature.

| ID | Decision |
| --- | --- |
| D-006-1 | The side panel is a **status + consent + control** surface. No conversation with the agent in the panel; the conversation is in the coding agent's terminal. |
| D-006-2 | The archived assistant workspace (001/002 remote path: service panel, sign-in, task workspace) is **not rendered in the agent build**. The narrow build keeps it unchanged (archive guard). A future panel chat, aligned with the references, would be its own feature. |
| D-006-3 | **Not connected / not paired** is one full-panel state page: what happened, what to do, a retry, and expandable technical details. Two copy variants (not paired; bridge lost) on one layout. |
| D-006-4 | **Paired and idle** shows a status row (dot, "connected · agent name", overflow menu with unpair) and the per-site mode list. No tab list, no empty session section. |
| D-006-5 | **Live sessions** are one card each: agent name and session, the sites it is working on (site names only), its state (working / waiting for you), and two actions — **Stop** (ends the session; the agent is told the owner stopped it) and **Release tabs** (hands the session's tabs back to the owner, all at once; the session goes on). No per-tab release. The in-page indicator of 004 stays as is. |
| D-006-6 | **Pending prompts** are always on top of whatever state the panel is in, one at a time: the pairing card (accept / ignore) and the consent card (only this time / always on this site / refuse). |
| D-006-7 | The **site list** lets the owner switch each site among the three modes and revoke a site back to the default (ask). The permissive mode is visually marked. |
| D-006-8 | **Visual system**: a small token set of our own (colour, four type sizes, four spacings, two radii), light and dark following the browser; no UI library or CSS framework added. A neutral ground with one calm accent; semantic colours (success / warning / danger) separate from the accent. |
| D-006-9 | **Name**: the agent build is called "Hallpass" (zh-TW「瀏覽器代理橋接」); the panel title follows. The narrow build keeps its name. |
| D-006-10 | **Acceptance**: unit tests for the states, cards and list; one attached-browser e2e per state; three accessibility assertions (every control has an accessible name, is keyboard operable, and text contrast ≥ 4.5:1); a light and a dark screenshot reviewed by the owner as the last gate; the narrow manifest guard byte-identical. |
| D-006-11 | **Slices**: S1 structure and behaviour (with the e2e), S2 visual system and copy (zh-TW and en-US; the screenshot gate last). Out of scope: moving site modes to an options page, a panel chat, changes to the in-page indicator, any change to the narrow build. |

## Traceability

| Requirement | PR | Evidence |
| --- | --- | --- |
| FR-081–FR-083 (states) | PR-020 | design-notes §7 (state page, status) |
| FR-084–FR-085 (prompts) | PR-005, PR-007, PR-008 | design-notes §7 (pairing prompt, consent card) |
| FR-086 (site list) | PR-008 | design-notes §7 (approved sites, revoke) |
| FR-087 (sessions) | PR-020, 004 D-004-2 | — (ours alone) |
| FR-088–FR-090 (build, name, archive) | — | — |
| FR-091–FR-093 (visual, themes, accessibility) | — | — |

## Acceptance standard *(binding for every requirement below)*

The panel is not reachable by the paid probe (it is not a tool), so the standard is: unit tests prove
the states and the answers; the packaged gate in attach mode on the owner's branded Chrome 152 proves each
state against the real worker and a real `mcp-server.js` session; the accessibility assertions run in the
unit project; two screenshots (light, dark) of the idle state and the live-session state are attached to
`coverage.md` and the owner's "OK" on them closes the visual claim. The narrow build's manifest guard and
the archived suites stay green.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nothing is connected: tell me what to do (Priority: P1)

The owner opens the panel before any coding agent has paired, or after the bridge was lost. The panel is
one page: what happened, what to do next, a retry, and — folded — the technical facts (relay pid, record
path, last disconnect reason from the 004 rings).

**Acceptance scenarios**:
1. **Given** no agent has ever paired, **When** the panel opens, **Then** it shows the not-paired page and
   nothing else: no tab list, no site list, no session section.
2. **Given** an agent was paired and the bridge is currently lost, **Then** it shows the bridge-lost
   variant with the last disconnect reason under "technical details".
3. **Given** the retry control is pressed, **Then** the worker re-checks the bridge and the panel moves to
   the paired-idle state when it is back.

### User Story 2 - Paired and idle: am I connected, what have I allowed (Priority: P1)

**Acceptance scenarios**:
1. **Given** a paired agent and no live session, **Then** the panel shows the status row (dot, connected,
   agent name) and the site list; the overflow menu holds "unpair".
2. **Given** no site has a decision, **Then** the list shows one sentence of empty state.
3. **Given** a site in `follow-a-plan`, **When** the owner switches it to `ask`, **Then** the next effect
   on that site prompts; **When** the owner revokes it, **Then** the row is gone and the default applies.
4. **Given** a site in `skip-checks`, **Then** the row is visibly marked as permissive.

### User Story 3 - Agents are working: which one, where, stop it (Priority: P1)

**Acceptance scenarios**:
1. **Given** two live sessions, **Then** two cards, newest activity first, each naming the agent and the
   session and listing the sites it holds tabs on (site names, not titles).
2. **Given** a session waiting on a consent, **Then** its card says "waiting for you" and the consent card
   is on top of the panel.
3. **Given** Stop is pressed on a card, **Then** that session ends, its agent's in-flight call answers
   `owner-stopped`, its tabs stay open as the owner's, and the other session is untouched.
4. **Given** Release tabs is pressed, **Then** every tab that session held goes back to the owner (group
   marking and indicator removed), the session stays live, and its next read of those tabs is refused.

### User Story 4 - Something needs my answer (Priority: P1)

**Acceptance scenarios**:
1. **Given** a pairing request, **Then** the pairing card is on top: one sentence naming the agent, accept
   / ignore; accept pairs, ignore lets the agent's call time out as today.
2. **Given** an ask-mode effect, **Then** the consent card is on top: "{agent} wants to {action} on
   {site}", with only-this-time / always-on-this-site / refuse; always-on-this-site sets that site's mode
   to `skip-checks` and is marked as permissive in the site list afterwards.
3. **Given** two prompts pending, **Then** one is shown; answering it shows the next.

### User Story 5 - It looks designed and it is usable by keyboard (Priority: P2)

**Acceptance scenarios**:
1. Light and dark follow the browser's scheme; every colour is a token; text contrast ≥ 4.5:1 in both.
2. Every control has an accessible name; the whole panel is operable by keyboard with a visible focus.
3. zh-TW and en-US copy: one sentence says what happened, a control says what it does.

### Edge Cases

- The panel opens while the worker is being evicted: the last projected state is shown until the port
  reconnects; no flash of the not-paired page for a paired browser (the port answers with the stored
  pairing first).
- The worker goes away under an open panel (idles out, restarts, the extension is reloaded): the panel
  reconnects on its own with a short backoff and the worker sends it the whole picture again; the owner
  never has to close and reopen it. If reconnecting keeps failing, the panel shows the not-connected page
  rather than a frozen picture, and the owner's next press tries once more.
- The panel is open more than once at the same time (one per window; a tab-scoped panel keeps its own
  document): every open panel shows the same projection and the same pending prompt, and an answer given
  in any one of them is the owner's answer for all. No panel is ever "the" panel.
- A session ends while its card is focused: focus moves to the next card or the status row.
- More than five live sessions: the list scrolls; nothing is hidden.
- A site name too long for the row wraps; it is never clipped.

## Requirements *(mandatory)*

### Functional Requirements

**States (US1, US2)**

- **FR-081 (MUST)**: The panel has exactly four visible compositions: not-connected page (two copy
  variants), paired-idle, live-sessions, and — over any of them — one pending prompt. Which one is shown
  is derived from the worker's projection alone; the panel keeps no state of its own beyond UI focus.
- **FR-082 (MUST)**: The not-connected page carries: a heading (what happened), one sentence (what to
  do), a retry control that asks the worker to re-check the bridge, and a collapsed "technical details"
  block with the relay pid, the bridge record path, and the last disconnect reason and time from the
  worker's diagnostics ring.
- **FR-083 (MUST)**: The paired-idle composition carries a status row (state dot, "connected", the paired
  agent's name; an overflow menu with "unpair") and the site list. It carries no tab list and no session
  section.

**Prompts (US4)**

- **FR-084 (PR-007 — MUST)**: A pairing request renders as a card on top of the panel: "{agent} wants to
  connect to this browser", accept / ignore. Accept pairs the agent (as today); ignore leaves the request
  to expire (as today).
  **Amended 2026-09-24 (owner decision, with 003 FR-032a)**: ignore answers the waiting agent at once
  as a decline of *this request* - the call ends `denied` with the do-not-retry-unless-asked hint and
  the agent's next call raises a fresh card - instead of leaving the agent waiting out the 45 s /
  2-minute bound. It still pairs nothing and remembers nothing. The original reason for silence (any
  refusal used to be permanent for the session) no longer holds since FR-032a. Reference: Claude in
  Chrome answers a dismissed pairing prompt immediately as dismissed.
- **FR-085 (PR-005, PR-008 — MUST)**: An ask-mode consent renders as a card on top: "{agent} wants to
  {action} on {site}", with three answers — only this time (this effect proceeds), always on this site
  (this effect proceeds and the site's mode becomes `skip-checks`), refuse (the effect answers refused).
  Prompts are shown one at a time in arrival order.

**Site list (US2)**

- **FR-086 (PR-008 — MUST)**: The site list shows every site with a stored mode: site name, current mode
  as a switch among `ask` / `follow-a-plan` / `skip-checks`, and a revoke that removes the entry (the
  default `ask` applies). `skip-checks` rows carry the warning colour. Changes take effect on the next
  effect on that site. A site whose record is set back to what the absence of a record means (`ask`, no
  diagnostics grant) leaves the list exactly as a revoke would: the list shows decisions, never a row that
  looks like one.

**Sessions (US3)**

- **FR-087 (PR-020 — MUST)**: Each live session renders one card: agent name, a short session label, the
  sites it holds tabs on (names), its state (working / waiting for you), and two actions. **Stop** ends
  the session (FR-058 release; the in-flight call, if any, answers `owner-stopped`). **Release tabs**
  releases every tab the session holds (each as `tabs_release` would) and keeps the session alive.

**Build, name, archive (all)**

- **FR-088 (MUST)**: In the `agent` profile the panel renders none of the archived remote-path components
  (service status, sign-in, task workspace). The `narrow` profile renders exactly what it does today.
- **FR-089 (MUST)**: The `agent` profile's manifest name and the panel title are "Hallpass"
  (zh-TW「瀏覽器代理橋接」). The `narrow` profile's name is unchanged.
- **FR-090 (MUST)**: The narrow manifest guard stays byte-identical; the archived 001/002 suites stay
  green.

**Visual, themes, accessibility (US5)**

- **FR-091 (MUST)**: All colour, type size, spacing and radius come from one token set declared once;
  light is the default and dark redefines the tokens under the browser's scheme; no component sets a
  literal colour.
- **FR-092 (MUST)**: Text contrast ≥ 4.5:1 against its surface in both themes (asserted for every
  token pair used for text on surface).
- **FR-093 (MUST)**: Every interactive element has an accessible name; the panel is operable end to end
  by keyboard with a visible focus indicator.

### Key Entities

- **PanelProjection** (existing, worker → panel): bridge state, pairing, sessions with held tabs, pending
  prompts, site modes, diagnostics (relay pid, record path, last disconnect).
- **PanelCommand** (panel → worker): retry-bridge, unpair, answer-pairing, answer-consent, set-site-mode,
  revoke-site, stop-session, release-session-tabs.

## Success Criteria *(mandatory)*

- **SC-044**: On the owner's Chrome 152, with no agent paired, the panel shows the not-paired page and no
  other section (e2e: exactly one landmark region).
- **SC-045**: With one paired agent and no session: status row + site list only; switching a site to
  `ask` makes the next effect prompt (e2e through a real `mcp-server.js` call); revoking removes the row.
- **SC-046**: With two live sessions: two cards; Stop on one answers that session's in-flight `wait`
  with `owner-stopped` and leaves the other's tabs held; Release tabs on the other makes its next
  `read_page` answer `not-yours` while the session stays paired.
- **SC-047**: Pairing card accept pairs within the 45 s bound (existing e2e re-pointed at the card);
  consent card "always on this site" leaves the site in `skip-checks` in the list.
- **SC-048**: The agent build's `dist/agent/manifest.json` name is "Hallpass"; the narrow
  guard is byte-identical.
- **SC-049**: Accessibility assertions pass: 0 controls without a name, tab order covers every control,
  every text/surface token pair ≥ 4.5:1 in both themes.
- **SC-050**: Two screenshots (light, dark) of paired-idle and live-sessions attached to `coverage.md`,
  owner-approved.

## Assumptions

- The worker already projects sessions, held tabs, pending prompts and site modes to the panel (003/004);
  new commands (set-site-mode, revoke-site, release-session-tabs, retry-bridge) are additions on the same
  port.
- The e2e side-panel driver can open the panel page in a tab and operate it (003/004 fixtures).

## Out of scope

- Moving site modes to an options page; a panel chat; changes to the in-page indicator; the narrow
  build; per-tab release; notifications; scheduling, shortcuts, GIF.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-09-16 | Two edge cases added under US1/US2: the panel reconnects on its own when the worker goes away, and every open panel document (one per window, tab-scoped ones included) shows the same projection and prompt with any one's answer counting. Cause: the panel went blind three times on 2026-09-16 — once because it never reconnected a dropped port, and, after that was fixed, because the worker served only the most recently connected panel document while Chrome ordinarily has more than one; the consent card then never appeared and the agent's call timed out with `no-answer`. Both references avoid a single "owner" panel connection | Owner reports 2026-09-15/16, live reproduction on the attached-browser gate |
| 2026-09-16 | FR-086 clarified: a record set back to the default (`ask`, no diagnostics grant) is dropped, so the list never carries a row that only looks like a decision. Cause: two such rows were left behind by a mode switch and a diagnostics toggle during testing | Owner report 2026-09-16 |
| 2026-09-13 | Initial specification; owner decisions D-006-1–11; design-notes §7 | Grilling session 2026-09-13 |

# Feature Specification: Interrupt a Step, Confirm a Site Transition, Ask Before Uploading From a New Directory

**Feature Branch**: `014-interrupt-transition-settings` (git:
`worktree-feature-014-interrupt-domain-settings`, from `main` at 44f03c1 = 0.5.0)

**Feature Directory**: `specs/014-interrupt-transition-settings`

**Created**: 2026-09-22

**Status**: Complete 2026-09-23 — S1–S4 implemented; T390 Chrome 153 run and T391 probe S14 done (see `coverage.md`).
Owner decisions D-014-1 to D-014-6 taken 2026-09-22 afternoon (D-014-2
「依照你的建議」; D-014-3/4 revised after the owner questioned a settings page — 「理論上都由
Coding Agent 控制 … 使用者體驗好嗎?」 — and a survey of the open-source browser-MCP servers:
no settings page, decide in the moment, remember, revoke in the panel). The rulings the two
reviews and the three slices settled are in the change log at the end of this document.

**Input**: Owner discussion of 2026-09-22 after 0.5.0 closed. The owner asked for the remaining
gaps of the 參考套件功能拆解 page and chose "功能面補齊" over the Edge live check, accepting the
recommendation: 中斷但可續, 跨網域轉換時確認, 設定頁, plus three tails left by 013. The reference
reading behind this document is the private evidence file for 014 (§1 interrupt, §2 transitions,
§3 settings page, §4 this repository's own state).

**Owner decisions (2026-09-22)**:

- **D-014-1 (interrupt)** — The session card gets a second control beside 停止: 中斷. It ends
  every call of that session that is in flight and nothing else: tabs, group, leases, attachment,
  viewport emulation, recording, retained screenshots, site decisions and dialog state all stay.
  The cancelled call's answer carries a reason distinct from a stop and says in words that
  nothing refused it, the session is still live and the call may be re-run. No confirmation step
  before either button.
- **D-014-2 (transition)** — A *site transition* is a held tab's top-level document landing on
  an **origin** different from the origin the session last knew for that tab. It asks only when
  the destination has no owner decision, is not loopback, was not the origin the agent named in an
  explicit navigate, and the ordered pair has not already been allowed. The question is put at the
  **next call on that tab**, reads included, on a card whose options are 繼續 (this session, this
  pair) / 一律允許 (this pair, persisted, revocable) / 拒絕 (this call refused, session stays).
  The card also keeps the session's usual 停止. The call that caused the transition answers
  honestly and names the transition. Departure from the reference: identity is origin, not
  hostname; a decline does not end the session.
- **D-014-3 (no settings page)** — There is no options page. The side panel stays the only
  surface for people: decisions are made on a card at the moment they are needed, remembered,
  and revocable from the panel's existing site list, which gains two kinds of row: an allowed
  transition pair (A → B, revoke) and an allowed upload directory (revoke). The owner's
  reasoning: the product is driven by the coding agent; a page nobody opens (the owner never
  opened the reference's) is not a good experience; the survey of open-source browser MCP
  servers shows none has one, and the two vendor products keep decide-in-the-moment in the
  panel.
- **D-014-4 (upload directories, asked in the moment)** — When `file_upload` names a file
  outside the allowed directories, the product no longer refuses outright: the panel shows a
  card naming the file's full path with the options allow this file once / allow this file's
  directory from now on / decline. "From now on" is written by the native host into its config
  file through the extension link only; a paired agent has no way to read or change the list.
  The host validates (absolute, existing directory), writes atomically and answers with the list
  it will use. Hand-editing the file keeps working. An old host that does not understand the
  request keeps today's behaviour (refuse outside the list) and the card says so. Any site
  mode applies as today on top of this card: the directory question is about the disk, the
  site question is about the page.
- **D-014-5 (013 tails)** — `file_upload` gets the same activity line `upload_image` has; the
  `upload_image` consent card states the delivery form derived from the arguments (a reference
  → into a file input; a coordinate → dropped at a point); `viewport` joins the tools that produce
  a recording frame.
- **D-014-6 (version)** — 0.6.0. No new MCP tool; the count stays 33. No new manifest permission.

**Authoritative Source Order**: Constitution (II clean room, IV explicit uncertainty, V least
privilege, VI privacy and consent, VII observable, XI defined failure) →
`docs/product-requirements-draft.md` PR-007 (stop), PR-008 (consent, "page or origin changes
after approval: re-evaluate before continuing"), PR-019 (settings, permission review and
revocation), PR-020 (local agent) → the decisions above → 003 US3 / FR-044–046 (site modes and
consent), 011 FR-153–158 (prompt-waiting) → `docs/design-notes.md` §3 (consent chaining) →
the private reference evidence (014 file) → the repository's own code as read on 2026-09-22.

## Why this feature exists

Three things a person running this product hits that the references answer and we do not:

1. **The only way to stop a wrong step is to end the session.** A person watching the panel sees
   the agent start a 30-second wait or a five-step batch on the wrong element; pressing 停止
   throws away the tabs, the group and every site decision of the session, and the agent has to
   pair, claim and read again. One reference lets a person end the current turn and keep the
   session; the other has only the full stop. We already have the primitive that flags calls
   without ending the session; nothing in the panel reaches it.
2. **A held tab can land on a site nobody decided about, and nobody is told.** A click on a
   trusted site follows a redirect to a login provider, a payment page, a different product.
   Today the next *effect* on the new site asks, as any effect on an undecided site does, but the
   card looks exactly like every other card, reads on the new site ask nothing, and the agent's
   answer for the click does not say it left the site. One reference pauses on any hostname
   change while the agent runs and asks "continue / always / stop"; the other does nothing.
3. **Uploading a file from disk needs a JSON file edited by hand first.** The directories the
   agent may upload from live in a config file under the profile directory; the installer
   writes an empty list, so the first `file_upload` a QA person tries is refused until they find
   and edit the file. Every other boundary in this product is decided on a card at the moment it
   is needed and remembered; this one is the exception, and it is the one QA asked about. One
   reference has an options page for review-and-revoke (which the owner never opened); the
   open-source browser MCP servers have neither a page nor a question. The owner chose: no
   page, ask in the moment, remember, revoke in the panel.

The 013 tails are three small honesty items the 013 close-out left to the owner: an upload from
disk leaves no activity line while an upload of a screenshot does; the consent card for the
screenshot upload cannot say how the picture will be delivered although the arguments already
decide it; and a viewport change alters what the page looks like without a recording frame.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Interrupt the step, keep the session (Priority: P1)

A person watching the session card sees the agent doing the wrong thing — a long wait, a batch
on the wrong form, a click it is about to be asked about — and presses 中斷. The in-flight call
ends at once with an answer that tells the agent the owner interrupted it, nothing refused it,
the session and its tabs are still there, and it may re-run the step. The card stays; the tabs
stay grouped; the agent's next call works as if nothing had been ended.

**Why this priority**: it is the one control a person needs while watching, and the primitive
already exists; only the wiring and the vocabulary are missing.

**Independent Test**: on the gate, start a 20 s `wait` (and, separately, a five-step
`browser_batch` whose third step is a `wait`), press 中斷 from the panel, assert the call answers
within one second with the interrupted reason, that the session still holds its tabs, the group
is still marked, an emulated viewport is still in force, a recording still counts frames, and a
following `click` on the same tab succeeds without a new pairing or claim.

**Acceptance Scenarios**:

1. **Given** a session with a `wait` in flight, **When** the owner presses 中斷, **Then** the wait
   answers with outcome stopped and the interrupted reason within one second, the answer text says
   nothing refused it and the session is still live, and the session card remains with its tabs.
2. **Given** a `browser_batch` at step 3 of 5, **When** the owner presses 中斷, **Then** the batch
   answers with the steps that completed, the step it was on marked interrupted, the remaining
   steps not run, and the stated plan of that batch (on a follow-a-plan site) is discarded.
3. **Given** a consent or transition card waiting for the owner, **When** the owner presses 中斷,
   **Then** the card is withdrawn, the waiting call answers interrupted (not declined), and no
   site decision is recorded.
4. **Given** an effect whose input was already delivered to the page when the interrupt arrived,
   **When** the call answers, **Then** it says the effect may have happened and was not verified,
   never "verified" and never "nothing happened".
5. **Given** a session with nothing in flight, **When** the owner presses 中斷, **Then** nothing
   changes and the panel says there was nothing to interrupt.
6. **Given** an interrupted `wait` whose condition later becomes true, **When** the worker sees
   it, **Then** no second answer is sent and the panel's log names the late result as discarded.
7. **Given** the owner presses 停止 instead, **When** the session ends, **Then** behaviour is
   exactly as before this feature (tabs released, group unmarked, session gone).

---

### User Story 2 - Be asked when the agent lands on a site nobody decided about (Priority: P1)

An agent on a site the owner set to skip-checks clicks a link that redirects to a different
origin the owner has never seen. The click answers normally and adds that the tab moved from A
to B and the next call on that tab will ask. The agent's next call on that tab — a read, a
screenshot, a click — is held while the panel shows a transition card: "this session moved from
A to B". The owner continues (this session), allows the pair for good, or declines. The call then
proceeds, or is refused with the reason, and the session is still there either way.

**Why this priority**: it is the one place the current consent model lets a session act on a
site with no signal to the person; reads are wholly silent today.

**Independent Test**: on the gate with fixture A set to skip-checks and fixture B undecided,
click a link on A that redirects to B; assert the click's answer names the transition; assert
`get_page_text` on that tab is held behind a card; answer 繼續 and assert the read completes;
in a second run answer 一律允許, restart the worker, repeat the transition and assert no card;
in a third run answer 拒絕 and assert the read is refused with the transition reason while the
session and tab remain held.

**Acceptance Scenarios**:

1. **Given** a held tab on origin A, **When** its top-level document commits on undecided,
   non-loopback origin B by a click, a redirect, a form submit, or the person's own typing in
   the address bar, **Then** a pending transition A→B is recorded for that tab and the answer of
   the call in flight (if any) names it.
2. **Given** a pending transition on a tab, **When** the agent's next call targets that tab —
   any tool, reads included — **Then** the call is held behind a transition card naming A and B,
   with 繼續 / 一律允許 / 拒絕 and the session's 停止; the 011 prompt-waiting rules apply (the
   agent is told the owner is being asked, the toolbar badge lights when the panel is closed,
   the call waits up to the prompt-waiting limit).
3. **Given** the owner answers 繼續, **When** the call proceeds, **Then** the pair A→B asks no
   more for this session; a later transition A→B in a new session asks again.
4. **Given** the owner answers 一律允許, **When** any later session moves A→B, **Then** no card
   appears; the allowance is listed in the panel's site list and revocable there; B→A is a different
   pair and is not covered.
5. **Given** the owner answers 拒絕, **When** the call answers, **Then** it is refused with the
   transition reason, nothing on B is read or done, the session and the tab stay held, the
   transition stays pending, and the agent may navigate the tab away (a navigate away is itself
   admitted, since it leaves B).
6. **Given** the agent called `navigate` with a URL on origin B, **When** the tab commits on B,
   **Then** no transition is recorded (the agent named B; B's own mode governs effects there);
   **but** if that navigate was redirected to origin C, a transition to C is recorded.
7. **Given** the destination is loopback, has a stored mode (follow-a-plan or skip-checks), or
   the tab returns to an origin the session already knew for that tab, **When** the document
   commits, **Then** no transition is recorded.
8. **Given** several commits before the agent's next call (A→B→C), **When** the agent calls,
   **Then** one card is shown for A→C (the origin the tab was known on, to where it is now).
9. **Given** the owner has not answered within the prompt-waiting limit, **When** the call
   times out, **Then** it answers not-answered as a consent card would, the transition stays
   pending, and the session stays.

---

### User Story 3 - Revoke what was remembered, from the panel (Priority: P2)

A person opens the side panel's site list and sees, beside the sites already decided, the
transition pairs they allowed for good ("A → B 一律允許") and the directories they allowed uploads
from, each with a revoke control. Revoking a pair makes the next A → B transition ask again;
revoking a directory makes the next upload from it ask again. Nothing else on the panel changes.

**Why this priority**: it is where D-014-2's and D-014-4's "always" answers become reversible
(PR-019); without it a remembered yes would be permanent.

**Independent Test**: with one allowed pair and one allowed directory seeded, open the panel;
assert both rows render with the site rows; revoke each and assert the next transition and the
next upload from that directory are asked again; assert the host's file no longer lists the
directory.

**Acceptance Scenarios**:

1. **Given** allowed pairs and directories, **When** the panel renders, **Then** each appears as
   one row in the site list's section for remembered decisions, in a stable order, with a
   revoke control and, for a pair, the time it was last used.
2. **Given** a revoke of a pair, **When** the next A → B transition happens in any session,
   **Then** the transition card is shown again.
3. **Given** a revoke of a directory, **When** the host has written the change, **Then** the
   row disappears and the next `file_upload` from that directory is asked again; if the host
   cannot be reached the row stays with a note and the revoke is retried on reconnect.
4. **Given** the panel is open in two windows, **When** one revokes, **Then** the other reflects
   it without reload.

---

### User Story 4 - Upload a file from disk without editing JSON first (Priority: P2)

A coding agent calls `file_upload` with a file that is not under any allowed directory. Instead
of a refusal, the panel shows a card naming the file's full path and asking whether to allow
this file once, allow its directory from now on, or decline. On "from now on" the host records
the directory and the upload proceeds; later uploads from that directory ask nothing. The site's
own mode still applies to putting the file into the page, as today.

**Why this priority**: it is the QA complaint behind this half of the feature; today the first
upload anyone tries fails until a JSON file is found and edited.

**Independent Test**: on the gate with a private host data directory and an empty list, call
`file_upload` with a fixture file; assert the card names the path; answer "directory from now
on" and assert the upload succeeds, the host's file lists the directory, and a second upload from
it asks nothing; in a second run answer "once" and assert the second upload asks again; in a
third answer decline and assert the refusal reason; assert by contract that no MCP-session
request can read or change the list.

**Acceptance Scenarios**:

1. **Given** a file outside every allowed directory, **When** the agent calls `file_upload`,
   **Then** a card shows the file's absolute path and the three options; the call waits under
   the 011 prompt-waiting rules and the agent is told the owner is being asked.
2. **Given** the owner answers "this file once", **When** the upload runs, **Then** it proceeds
   for that file only; the list is unchanged; the same file asks again next time.
3. **Given** the owner answers "this directory from now on", **When** the host has written the
   list, **Then** the upload proceeds, the panel shows the directory row, and later uploads from
   that directory (and its subdirectories) are not asked.
4. **Given** the owner declines or does not answer in time, **When** the call answers, **Then**
   it is refused with the reason (declined, or not answered); the list is unchanged.
5. **Given** a file under an already allowed directory, **When** the agent calls `file_upload`,
   **Then** no directory card is shown; behaviour is as in 0.5.0.
6. **Given** a host older than this feature, **When** the file is outside the list, **Then** the
   call is refused as in 0.5.0 and the answer says the host must be reinstalled to be asked.
7. **Given** a site in `ask` mode, **When** the directory card is answered yes, **Then** the
   site's consent card follows as today (two questions, disk then page); on `skip-checks` only
   the disk question is asked.
8. **Given** several files in one call from different directories, **When** some are outside the
   list, **Then** one card lists all of them; "from now on" allows each listed directory.

---

### User Story 5 - The three 013 tails (Priority: P3)

A `file_upload` from disk leaves one activity line on the session card as a screenshot upload
does; the consent card for a screenshot upload says whether it will go into a file input or be
dropped at a point, derived from the arguments before anything runs; a `viewport` change adds a
recording frame labelled as such.

**Why this priority**: small, already-decided honesty items; they ride on the same release.

**Independent Test**: unit checks on the activity log and the card text; a gate run that records
a viewport change and asserts the frame count grew by one with the viewport label.

**Acceptance Scenarios**:

1. **Given** a successful `file_upload`, **When** the card renders, **Then** one activity line
   names the upload into an input.
2. **Given** an `upload_image` call with a reference (or a coordinate), **When** the consent card
   shows, **Then** it says "into a file input" (or "dropped at a point").
3. **Given** a recording in progress, **When** `viewport` sets or clears an override, **Then**
   one frame is added, labelled viewport with the size (or "cleared").

### Edge Cases

- 中斷 while the worker is being recycled: the flag is recorded by the host when the worker
  cannot be reached; on reconnect the call is answered interrupted, not left to time out.
- 中斷 racing with the call's own completion: whichever answer is first is the only answer; a
  completion that lands first is reported as completion.
- 中斷 during a recording export (the session's own `gif_recorder export`): the export is a call
  and is interrupted like any other; the frames stay.
- 中斷 while a page dialog is open: the dialog stays open; the interrupted call answers; the next
  call is blocked-by-dialog as today.
- Two sessions hold tabs on the same origin pair: allowances and pending transitions are per
  session for 繼續 and shared for 一律允許, exactly as site modes are shared.
- A transition on a tab the session then releases: the pending record is dropped with the tab.
- A transition during a `browser_batch` (step 2 navigates by click to B): the batch stops before
  step 3 with the transition named; steps done stay done; the agent may re-issue the rest after
  the card is answered on its next call.
- A transition to an origin whose mode is ask-set-by-the-panel: the store cannot hold an explicit
  ask (a default record is not stored), so an "ask" site is by definition undecided and asks.
- Adding an upload directory that is a parent of an existing one, or a duplicate: accepted once,
  listed once.
- The panel open in two windows: both reflect the stores' change events.

## Requirements *(mandatory)*

### Functional Requirements

Interrupt (D-014-1):

- **FR-178 (PR-007 — MUST)**: The session card MUST offer an interrupt control distinct from
  stop, enabled while the session has at least one call in flight; pressing it with nothing in
  flight MUST change nothing and MUST say so in the panel.
- **FR-179 (MUST)**: Interrupt MUST end every in-flight call of that session — effects, waits,
  reads, diagnostics, uploads, dialog answers, a running batch at its current step, and a call
  waiting on a consent or transition card (the card is withdrawn, no decision recorded) — and
  MUST NOT end the session: its tabs, tab-group marking, leases, debugger attachment, viewport
  emulation, recording and frames, retained screenshots, dialog state, window-restore record and
  site decisions MUST all remain.
- **FR-180 (MUST)**: An interrupted call MUST answer with the stopped outcome and a reason
  distinct from the owner's stop, and its text MUST say that nothing refused it, that the
  session and its tabs are still held, and that the call may be re-run. A batch MUST report the
  steps completed, the step interrupted and the steps not run, and MUST discard its stated plan.
- **FR-181 (Constitution XI — MUST)**: An effect whose input had already been delivered when the
  interrupt arrived MUST answer that it may have taken effect and was not verified; it MUST NOT
  answer verified, and MUST NOT answer as if nothing happened.
- **FR-182 (MUST)**: A result arriving for an interrupted call MUST be discarded (never sent as a
  second answer) and MUST be named as a discarded late result in the session's log; the
  session's activity list MUST show one line for the interrupt.
- **FR-183 (MUST)**: The local MCP server MUST fail only the calls it holds for that session at
  the moment of the interrupt, with the same reason and text, and MUST keep the session usable
  for the next call without re-pairing or re-claiming.
- **FR-184 (MUST)**: The stop control MUST keep its current behaviour in full.

Site transitions (D-014-2):

- **FR-185 (PR-008 — MUST)**: The product MUST record a pending site transition for a held tab
  when its top-level document commits on an origin that differs from the origin the session last
  knew for that tab, whatever caused the commit (agent effect, redirect, form submission, the
  person's own navigation), unless the destination is loopback, has a stored site mode, is the
  origin the agent named in the `navigate` call that produced this commit, is an origin the
  session already knew for that tab, or the ordered pair is already allowed for this session or
  persistently.
- **FR-186 (MUST)**: The answer of the call during which the commit happened MUST name the
  transition (from, to) and say that the next call on that tab will ask the owner; the call's own
  outcome MUST be reported honestly regardless.
- **FR-187 (MUST)**: The next call that targets a tab with a pending transition — any tool,
  reads included — MUST be held behind a transition card naming both origins, with the options
  continue (this session, this pair), always allow (this pair, persisted), decline (this call),
  and the session's stop; the prompt-waiting rules of 011 (agent told, badge, waiting limit,
  not-answered outcome) MUST apply as to a consent card. Calls on the session's other tabs MUST
  NOT be held.
- **FR-188 (MUST)**: Continue MUST clear the pending transition and allow the pair for the rest
  of this session; always MUST additionally persist the ordered pair with the time it was last
  used; decline MUST refuse the call with a transition reason, keep the transition pending, keep
  the session and the tab, and MUST still admit a `navigate` that leaves the destination origin.
- **FR-189 (MUST)**: Successive commits before the next call MUST collapse into one transition
  from the last known origin to the current one; a return to a known origin MUST clear it.
- **FR-190 (Constitution VI — MUST)**: Persisted allowances MUST be listed and revocable in the
  panel's site list; revoking one MUST take effect at the next transition without restart. Only the
  origins are stored, never URLs or page content.

Remembered decisions in the panel (D-014-3):

- **FR-191 (PR-019 — MUST)**: The panel's site list MUST show every persisted transition pair
  (with when it was last used) and every allowed upload directory as rows with a revoke control,
  reflecting the stores without reload in every open panel; there MUST be no separate settings
  page.
- **FR-192 (MUST)**: Revoking a pair MUST take effect at the next transition in any session;
  revoking a directory MUST be written by the host before the row disappears, and a host that
  cannot be reached MUST leave the row with a note and retry on reconnect.

Upload directory asked in the moment (D-014-4):

- **FR-193 (PR-020, Constitution V, VI — MUST)**: When `file_upload` names one or more files
  outside every allowed directory, the product MUST ask the owner on a panel card naming each
  file's absolute path, with the options allow these files once / allow their directories from
  now on / decline; the prompt-waiting rules of 011 MUST apply. A file inside an allowed
  directory MUST NOT be asked about.
- **FR-194 (MUST)**: "Once" MUST allow exactly the named files for that call and leave the list
  unchanged; "from now on" MUST be recorded by the native host (absolute, existing directory,
  written atomically, answered with the list it will use) before the upload proceeds; decline
  and not-answered MUST refuse the call with the distinguishing reason and leave the list
  unchanged. The directory question MUST precede, and never replace, the site's own consent.
- **FR-195 (Constitution V — MUST)**: The list MUST be readable and writable only over the
  extension link; a paired agent's request surface MUST contain no way to read or change it,
  asserted by a contract check. A host that predates this feature refuses such a file as in 0.5.0
  (`upload-not-allowed`); the 0.6.0 documentation says what that answer means and that
  reinstalling the host enables the question (amended in S4, R-190: an old host is 0.5.0 code and
  the descriptions the agent reads are its own, so it cannot say anything new — only the
  documentation can). No manifest permission is added.

013 tails (D-014-5):

- **FR-196 (MUST)**: A successful `file_upload` MUST add one activity line naming an upload into
  an input, as `upload_image` does.
- **FR-197 (MUST)**: The `upload_image` consent card MUST state the delivery form derived from
  the arguments — into a file input when a reference is given, dropped at a point when a
  coordinate is given.
- **FR-198 (MUST)**: `viewport` MUST produce one recording frame per call, labelled viewport
  with the size set or "cleared".

Release (D-014-6):

- **FR-199 (MUST)**: Version 0.6.0; tool count 33 unchanged; README, zh-TW guides, design notes
  and the 參考套件功能拆解 page updated (the page's transition row corrected: the agent path never
  had "document change revokes").

### Key Entities

- **Interrupt**: an owner action on one session at one instant; affects the calls in flight at
  that instant and nothing after.
- **Site transition**: per held tab: the origin the session last knew, the origin it is on now,
  and whether the question is pending; cleared by continue, by leaving, or by releasing the tab.
- **Transition allowance**: an ordered origin pair (from → to); session-scoped when answered
  continue, persisted with a last-used time when answered always; revocable.
- **Upload directory list**: the host's list of absolute directories; owned by the host's config
  file; grown only by the owner's "from now on" answer and shrunk only by a panel revoke, both
  over the extension link.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-100**: On the gate, an in-flight `wait` and a batch at step 3 answer interrupted within
  one second of the panel action (2/2); afterwards the same session's `click` succeeds without
  re-pairing (1/1); the group marking, viewport emulation and recording frame count are unchanged
  (3/3 assertions).
- **SC-101**: A call waiting on a consent card is interrupted with the card withdrawn and no
  site decision stored (1/1); a late result for an interrupted wait is discarded and logged (1/1);
  an effect already delivered answers "may have happened" (1/1).
- **SC-102**: A click on a skip-checks fixture that redirects to an undecided fixture names the
  transition in its answer (1/1); the next read on that tab shows the card (1/1); continue, always
  and decline each behave as specified (3/3); after always and a worker restart the pair asks no
  more (1/1); loopback, stored-mode, named-navigate and return-to-known destinations ask nothing
  (4/4).
- **SC-103**: Unit checks cover the collapse of successive commits, the per-tab scope, and the
  release-drops-pending rule (3/3).
- **SC-104**: The panel shows seeded pair and directory rows beside site rows (1/1); revoking a
  pair makes the next transition ask (1/1); revoking a directory changes the host's file and the
  next upload asks (1/1); two open panels agree without reload (1/1).
- **SC-105**: A `file_upload` outside the list shows the card with the path (1/1); "once",
  "from now on" and decline each behave as specified (3/3), with the host's file changed only
  by "from now on" (1/1); a file inside the list asks nothing (1/1); the agent's request surface
  has no list request (contract 1/1); an old host refuses with the reinstall note (1/1).
- **SC-106**: The three tails hold (activity line 1/1, card text 2/2, viewport frame 1/1).
- **SC-107**: A paid probe told "the page moved to a login provider; check with me before reading
  it" sees the transition in the click's answer and reports the card to the person rather than
  proceeding (1/1, model recorded).
- **SC-108**: Unit, contract and snapshot checks stay green; manifest permissions unchanged;
  version 0.6.0 and tool count 33 appear in README, guides and package; the 功能拆解 page shows
  013 and 014.

## Assumptions

- The interrupt reaches calls through the existing per-session stop flagging; the distinct
  reason is the only new vocabulary the agent sees.
- Origin is the identity for transitions because it is already the identity for site modes;
  the reference's hostname granularity is not copied.
- A transition card is a new kind of the existing consent card, rendered by the panel with its
  own wording; no new panel section.
- The upload directory read/write is an additive message on the extension↔host link; an old
  host answering "unknown request" (or not at all within the link's timeout) keeps 0.5.0's
  refusal, with the reinstall note in the answer.
- The directory card is a new kind of the existing consent card; the panel's site list gains a
  section for remembered decisions, no new panel view.
- The gate runs on Chromium in attach mode as for 013; the owner's branded Chrome is used for
  the final run; the paid probe runs once for SC-107.

## Out of Scope

- Editing a batch's steps after it was stated (編輯計畫); an audit trail beyond today's logs;
  favicon badges; the cursor's spring motion; the `find` role vocabulary.
- A settings or options page of any kind (D-014-3); pre-deciding a site before the agent first
  reaches it; scheduling, saved shortcuts, microphone, notifications.
- Gating reads by site mode in general: reads stay free; only a pending transition holds them.
- A transition for frames below the top level.
- Any change to the stop control or to pairing.

## Traceability

| Reference feature | Destination |
| --- | --- |
| End the current turn, keep session, leases, group, attachment (one reference) | FR-178–FR-183 |
| Refuse a late command for an ended turn by name (one reference) | FR-182 |
| "Nothing refused it; re-run if still needed" wording (one reference) | FR-180 |
| Stop ends the turn and detaches (both) | FR-184 (unchanged) |
| Pause on top-level hostname change while running; continue / always / stop (one reference) | FR-185–FR-189 (origin; decline keeps session) |
| Loopback destination never asks; plan-approved and skip modes bypass (one reference) | FR-185 |
| Transition pairs persisted, revocable with last-used (one reference: options page) | FR-188, FR-190, FR-191 (panel rows instead) |
| Options page: approved sites, transitions, revoke (one reference) | Not adopted (D-014-3); revoke lives in the panel |
| Upload directory allow-list asked in the moment (neither reference) | FR-193–FR-195 — own design |
| Scheduling, shortcuts, microphone, notifications (one reference) | Out of scope |
| Per-workspace approval mode (the other reference) | Not a per-site concept; REFERENCE-ONLY |

## Change log — what the three slices and the two reviews settled

Rulings taken while this was built, recorded here because each one narrows a requirement above and
the contracts under `contracts/` carry the detail.

- **The batch convention is kept** (S1, 2026-09-22). An interrupted or transition-stopped
  `browser_batch` answers `ok` — its own outcome says it ran — and the interruption is in the
  results: the step that was cut carries `stopped / owner-interrupted` (or `stopped /
  site-transition`), the steps not run carry `stopped / not-run`, and the result lists `completed`,
  `interruptedAt` / `stoppedAt` and `notRun`. The host reports a non-`ok` call as outcome and reason
  alone, so a top-level `stopped` would throw those three lists away.
- **"Nobody answered" has one vocabulary** (S2). A transition or directory question that runs out
  its 011 bound answers `timed-out / no-answer` with the 011 hint, exactly as a consent card does —
  never a `denied` of its own. The pending transition stays; the question is asked again by the next
  call.
- **Calls that leave the site are admitted** (owner's ruling, S2). A pending transition holds every
  tool that names the tab except the ones that go: a `navigate` whose requested origin is not the
  undecided one, `tabs_close` and `tabs_release`. An agent that has landed where it should not be
  must be able to leave without a person answering a card first.
- **繼續 is spent on the move it was asked about, and the re-ask loop is bounded at three** (S2
  review). A tab that moved on again while the card stood is asked about again, at where it actually
  is; after three rounds the call is refused `denied / site-transition-declined` with a hint saying
  the tab kept moving and nobody declined it, and the question stays standing for the next call.
- **The roots rule is the last of the three checks, not the first** (S3). Too many files and too
  many bytes are decided before the directories are, so the owner is never shown a card about a file
  that would be refused for its size anyway — a question that cannot lead anywhere except to a wider
  list and a failed call. All three still happen before anything is opened.
- **A root directory is never remembered** (S3 review F7). "From now on" adds the directory each
  file sits in, and the card names that directory under each path; when it is a drive or a share
  root the files ride that one call's yes instead and the answer says why
  (`UPLOAD_HINTS.rootNotRemembered`). The worker applies the same contract helper, so it does not
  report such a directory as one the host failed to record.
- **`busy` is the answer to a second question** (S3 review F3). A worker already holding a card
  answers the host `busy`, which the call reports as `busy / prompt-pending`; a session holding no
  tab to raise a card on answers `interrupted`, because nobody declined anything.
- **`upload-directory-not-recorded`** (S3 review F2). The owner said "from now on" and the store
  could not write it: the call is denied with that reason and the store's own refusal as `hint`, and
  the panel names the directory that never reached the list. The decision is not silently downgraded
  to a one-call yes.
- **An unreadable `config.json` is preserved, not overwritten** (S3 review F4). It is moved to
  `config.json.invalid` before anything is written in its place, the listing says so and the panel
  says where it went — the file is the owner's, and a corrupt one may still be the only record of
  what they had allowed.
- **FR-195's old-host clause is amended** (S4, R-190): see the requirement itself. An old host
  cannot say anything new, so the reinstall note is documentation.

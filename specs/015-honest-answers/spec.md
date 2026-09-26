# Feature Specification: Honest Answers — Link Clicks, False "Stale", Every Download, Uploads in a Batch, Withdrawn Pairing

**Feature Branch**: `015-honest-answers` (git: `feature-015-honest-answers`, from
`worktree-fix-attention-and-indicator` at 334841e = 0.7.0 + the 2026-09-25 follow-ups)

**Feature Directory**: `specs/015-honest-answers`

**Created**: 2026-09-25

**Status**: Implemented 2026-09-27 (0.8.0; branded-browser runs T426 owner-run, see coverage.md)

**Input**: Owner discussion of 2026-09-25 after 0.7.0 and its follow-ups closed. Offered four
directions (honest answers / publish and more browsers / macOS-Linux / QA feedback first), the owner
chose **honest answers**, with the 0.8.0 public release and the Edge live check done at close-out.
The reference reading and the measurements behind this document are the private evidence file for
015 (§1 link clicks and the false `stale`, §2 downloads, §3 uploads in a batch, §4 prompts whose
caller stopped waiting).

**Owner decisions (2026-09-25)**:

- **D-015-1 (link clicks)** — Measure first; fix a root cause if one exists; in every case the
  answer to a press says what the press did — this tab moved, a new tab opened, a download started,
  or nothing that could be observed. (The 014 record "a link click answered verified and the tab did
  not move" did not reproduce in five variants on the current build; a different defect did — see
  User Story 2.)
- **D-015-2 (downloads)** — `wait` for a finished download answers **any** completion the session
  has not been told about yet, oldest first, each exactly once. Today only the newest download is
  looked at.
- **D-015-3 (uploads in a batch)** — `file_upload` and `upload_image` work as steps of a batch. The
  owner overrode the recommendation to refuse them. Because deciding which local files may reach a
  page is an authorization boundary, the owner accepted three conditions: it is its own slice; each
  step goes through **the same** host checks as a standalone call, never a second copy of them; and
  the slice is not done until a fresh-context code review has passed it.
- **D-015-4 (pairing)** — When the host gives up waiting for a pairing answer, it tells the
  extension to withdraw that session's request, so a card nobody is waiting on does not stay up.
- **D-015-5 (when a batch's upload checks run)** — Before the batch's first step: the host resolves
  every upload step, asks the owner where needed, reads the content, and only then sends the batch;
  a "no" refuses the batch before anything happens on the page. Chosen over refusing the whole batch
  whenever a question is needed (the reference's generic rule — its batches never ask anything) and
  over asking mid-batch (largest change, and with our host-side screenshot store it would not make a
  same-batch screenshot uploadable either). Our batches already ask per step under `ask` and once
  under `follow-a-plan`, so asking about an upload is consistent with them.

## Why this feature exists

Since 004 the recurring defect in this project has been a tool that says something other than what
happened: a click reported as landed that missed, a type reported as done that went elsewhere, an
export reported under a name the browser did not use. Each was found late — by a probe, a review or
the owner — because the answer looked plausible. The agent acts on these answers; a wrong one does
not fail, it misleads.

Four such gaps remain on the agent path:

1. A press can do something other than change the document of the tab it was sent to — open a new
   tab, start a download, be swallowed by the page — and the answer today only says whether *this*
   tab's document changed. The agent is left to guess the rest.
2. After a tab has gone to another origin and come back, the agent's reads and presses on it can
   answer `stale` although the page is intact and visible (measured 3 of 4 runs). The agent is told
   the page moved when it did not.
3. When a page starts two downloads and the second finishes first, the first one's completion is
   never reported. A multi-file export looks as if it never finished.
4. `file_upload` and `upload_image` are listed as allowed inside a batch but always fail there; and a
   pairing card can stay on screen after the agent has already been told its request timed out.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The answer to a press says what the press did (Priority: P1)

An agent clicks a link, a button or a point. The answer tells it which of these happened: this
tab's document was replaced (and to what address, if known in time), a new tab opened (which one),
a download started (which one), or none of these could be observed. When the thing pressed was a
link with an address and nothing followed, the answer says so in words, so the agent does not read
"landed on the element" as "the link was followed".

**Why this priority**: every multi-page task starts with a click; an agent that misreads its result
wanders or stops. It is also the item the owner asked to be measured before anything is changed.

**Independent Test**: on fixture pages, press — through every press-type tool and as a batch step —
a same-origin link, a cross-origin link, a link to a redirect, a link opening a new tab, a link that
downloads a file, and a link whose page cancels the default action; compare each answer with what
the browser actually did.

**Acceptance Scenarios**:

1. **Given** a held tab showing a page with an ordinary link, **When** the agent clicks the link,
   **Then** the answer reports that this tab's document changed and, if the new address is known
   within the observation window, names it.
2. **Given** a link that opens its target in a new tab, **When** the agent clicks it, **Then** the
   answer reports that a new tab opened, names that tab and its address, and says whether the
   session now holds it; it does not report "this tab changed".
3. **Given** a link whose target is a file the browser downloads, **When** the agent clicks it,
   **Then** the answer reports that a download started and identifies it the way the downloads tool
   does.
4. **Given** a link whose page cancels the default action, **When** the agent clicks it, **Then**
   the answer reports that the press landed and that no navigation, new tab or download followed
   within the observation window, and says that the page may have handled the press itself.
5. **Given** the 014 observation (a link press answered as landed while the tab did not move),
   **When** the measurement of this feature is repeated on the developer browser and on the owner's
   branded browser, **Then** the result is recorded; if it reproduces, its root cause is fixed and a
   test that failed before the fix passes after it.

---

### User Story 2 - A page that did not move is not called stale (Priority: P1)

An agent works on a tab that went to another site and came back (by a link, a redirect or the
agent's own `navigate`). Its next read and its next press on that tab work; they do not answer
`stale` while the page is intact.

**Why this priority**: a false `stale` makes the agent re-read, re-navigate or give up on a page that
is fine — the same class of defect as a false success, pointing the other way. It was observed in 3
of 4 runs of the measurement for User Story 1.

**Independent Test**: a reproduction that moves a held tab to another origin and back, then reads,
finds and presses on it, repeated until the false `stale` has either shown itself or not in a fixed
number of runs; red before the fix, green after.

**Acceptance Scenarios**:

1. **Given** a held tab that went to another origin and was brought back with `navigate`, **When**
   the agent calls `find`, a read or a press on it, **Then** the call works as on a freshly opened
   tab.
2. **Given** a tab that truly cannot be acted on (closed, or a page the extension may not touch),
   **When** the agent calls a tool on it, **Then** the answer names which of these it is and whether
   trying again could help, instead of a bare `stale`.
3. **Given** a reference minted before a navigation, **When** the agent uses it after the tab moved,
   **Then** the answer says the reference belongs to a page that is gone (the existing, correct
   `stale`), not that the tab is unusable.

---

### User Story 3 - Every finished download is reported, once (Priority: P2)

A page starts several downloads. Each time the agent waits for a finished download, it is told about
the earliest-finished one it has not been told about yet, until none is left; then the wait waits for
the next one.

**Why this priority**: multi-file exports are common in the QA team's work; a missed completion makes
the agent think a file never arrived. Smaller than P1 because a single download already works.

**Independent Test**: a fixture page starts download A then B, with B finishing first; two waits in
a row answer B then A; a third wait times out.

**Acceptance Scenarios**:

1. **Given** two downloads started in the order A, B that finish in the order B, A, **When** the
   agent waits for a finished download twice, **Then** the first wait answers B and the second A.
2. **Given** a completion the agent has already been told about, **When** it waits again, **Then**
   that completion is not answered a second time.
3. **Given** a download that failed or was cancelled, **When** it is the earliest un-answered one,
   **Then** it is answered with its final state, as today for a single download.
4. **Given** two sessions that each started a download, **When** each waits, **Then** each is told
   only about its own.

---

### User Story 4 - Uploads work inside a batch, under the same checks (Priority: P1)

An agent sends one batch that fills a form, attaches a file from disk and a screenshot it took, and
submits. The file and the image reach the page exactly as they would through standalone calls, and
every check that guards a standalone upload guards the step: files outside the allowed directories
are asked about in the moment (once / remember this directory / no), a disk or share root is never
remembered, an unknown or expired screenshot id is refused with its reason, and nothing reaches the
page without the check having passed.

**Why this priority**: the owner chose to make this work rather than refuse it; batches are how an
agent fills a form in one call. It is also the one item in this feature that touches an
authorization boundary.

**Independent Test**: the same check matrix run once as standalone calls and once as batch steps,
with identical outcomes, plus a batch whose upload step is declined and a batch whose earlier step
fails.

**Acceptance Scenarios**:

1. **Given** a file inside an allowed directory, **When** a batch contains a `file_upload` step for
   it, **Then** the file reaches the page and the step's answer matches the standalone answer.
2. **Given** a file outside every allowed directory, **When** a batch contains a `file_upload` step
   for it, **Then** the owner is asked exactly as for a standalone call **before any step of the
   batch runs**; on "once" or "remember" the whole batch runs; on "no" the batch is refused with the
   standalone reason naming that step and nothing happens on the page.
3. **Given** a screenshot the session took and still holds, **When** a batch contains an
   `upload_image` step naming it, **Then** the image reaches the page; **Given** an unknown or expired
   id, **Then** the step is refused with the same named reason as a standalone call.
4. **Given** any batch, **When** it contains upload steps, **Then** no file outside the allowed
   directories reaches a page without the owner's yes for that file's directory, and no disk or share
   root is ever remembered.
5. **Given** a change to the standalone upload check, **When** the batch path is exercised, **Then**
   it shows the same change — there is one check, not two.

---

### User Story 5 - A pairing card nobody is waiting on goes away (Priority: P2)

A coding agent asks to pair; the owner does not answer in time; the agent is told its request timed
out. The card for that request leaves the panel — unless another agent session is still waiting on
the same card, in which case it stays for that one. An answer given to a card after a session's
request was withdrawn is not credited to that session's later request.

**Why this priority**: a card that stays after its caller gave up invites an answer that goes
nowhere, and today a late answer can be taken by a different pairing exchange than the one the owner
saw. Rare, but it is the last place where the panel and the agent disagree about a question.

**Independent Test**: one session asks, its host bound expires, the card disappears within the
stated time; two sessions ask on one card, one expires, the card stays for the other.

**Acceptance Scenarios**:

1. **Given** a single session waiting on a pairing card, **When** the host gives up on it, **Then**
   the card leaves the panel within 2 seconds and the toolbar icon stops asking for attention.
2. **Given** two sessions waiting on one card, **When** one session's request is withdrawn, **Then**
   the card stays, shows one fewer waiting connection, and an answer settles only the session still
   waiting.
3. **Given** a request that was withdrawn, **When** the same session asks again later, **Then** a new
   request is raised for it and only an answer to that new request settles it.
4. **Given** an extension that does not know the withdrawal message, **When** it receives one,
   **Then** nothing breaks and the card falls back to today's behaviour (it expires on its own bound).

---

### User Story 6 - 0.8.0, published, and seen working in Edge (Priority: P3)

The owner gets a 0.8.0 package, a public release snapshot ready to publish on their go-ahead, and a
recorded run of the agent path in Microsoft Edge (issue #2).

**Why this priority**: close-out work that ships the feature and retires an open issue; it adds no
behaviour.

**Independent Test**: the package builds as 0.8.0; the snapshot check passes; the Edge run's results
are recorded on the issue.

**Acceptance Scenarios**:

1. **Given** the finished feature, **When** it is packaged, **Then** every place that states the
   version states 0.8.0.
2. **Given** the snapshot for the public repository, **When** it is checked, **Then** it contains no
   forbidden path or identifier; it is pushed, tagged and released only after the owner says so.
3. **Given** Edge with the extension loaded and the host registered for it, **When** pairing, a
   read, a press and an upload are run, **Then** each result is recorded on issue #2.

---

### Edge Cases

- A press that both opens a new tab and changes this tab (a page script doing both): the answer
  reports both.
- A new tab that opens after the observation window closes: not reported by the press; it is still
  visible to `tabs_context`, and the answer says what the window was.
- A press on a link to a page the owner's site mode refuses: the navigation happens (the press is
  allowed on this page); the existing transition rule decides what the next call on that tab asks.
- A new tab opened by a press on a held tab: whether it joins the session follows the existing rule
  for tabs opened from a held tab; the answer only reports what happened.
- A download completion evicted from the session's list (it keeps the latest 20) before it was
  answered: it cannot be answered; `downloads_context` shows the list as it is.
- A batch with two upload steps outside the allowed directories: both are asked about before the
  batch starts, in step order; "remember" from the first counts for the second if they share a
  directory, so the second is not asked.
- A batch interrupted (中斷) or stopped (停止) while its upload question waits for the owner: the
  question is withdrawn exactly like a standalone upload question, and no step has run.
- An `upload_image` step naming a screenshot taken by an earlier step of the same batch: refused as
  an unknown id before the batch starts, with a sentence saying to upload it in a later call
  (FR-210). (The reference supports this chain because its screenshot store lives in the extension;
  ours lives in the host by an earlier decision, so it is out of scope here.)
- The host gives up on a pairing request at the same moment the owner answers: whichever is
  processed first wins; the other is a no-op and is logged, never applied to another exchange.

## Requirements *(mandatory)*

### Functional Requirements

**Link clicks and press outcomes (D-015-1)**

- **FR-200**: The answer to every press — `click`, `double_click`, `triple_click`, `right_click`,
  the pressing actions of `computer`, and the same actions as batch steps — MUST report, besides the
  existing landed/verified facts, which of these the press caused within its observation window:
  this tab's document replaced (with the new address when committed in time), one or more new tabs
  opened (each named with its tab id and address, and whether the session holds it), one or more
  downloads started (each identified as `downloads_context` identifies it), or none of these.
- **FR-201**: When the pressed element is a link with an address and none of the outcomes in FR-200
  followed, the answer MUST say so in a sentence the agent can act on (the press landed; no
  navigation, new tab or download followed within the window; the page may have handled it).
- **FR-202**: The observation window MUST be stated in the answer when nothing was observed, and
  MUST NOT make a press that caused nothing slower to answer than today by more than the window.
- **FR-203**: Before any change to how a press is delivered, the 014 observation MUST be measured on
  the developer browser and on the owner's branded browser, and the result recorded in research. If
  it reproduces, its root cause MUST be fixed with a test that fails before the fix; if it does not,
  delivery MUST stay unchanged.

**False `stale` (D-015-1, found by its measurement)**

- **FR-204**: A red-capable reproduction of the false `stale` after a cross-origin round trip MUST
  exist before any fix, and MUST fail on the starting commit of this feature.
- **FR-205**: A tab whose page is intact and reachable MUST NOT answer `stale` to a read, `find` or
  press, whatever navigations preceded the call.
- **FR-206**: When a tab truly cannot be bound, the answer MUST name the reason (the tab is gone; the
  page is one the extension may not act on; the page's runtime did not answer) and whether a retry
  may help. A reference minted on a document that has since been replaced keeps answering the
  existing "stale reference" outcome.

**Downloads (D-015-2)**

- **FR-207**: `wait` with the finished-download condition MUST answer the earliest-finished
  completion (finished, failed or cancelled) among the session's downloads that has not yet been
  answered to that session, and MUST answer each completion at most once.
- **FR-208**: A completion that happened before the wait began and has not been answered MUST be
  answered at once; with none pending the wait MUST wait for the next completion as today.
- **FR-209**: Completions MUST stay per session: a session is never told about another session's
  downloads.

**Uploads in a batch (D-015-3 — authorization boundary)**

- **FR-210**: `file_upload` and `upload_image` MUST work as batch steps, with the same outcomes as
  standalone calls given the same arguments and state. The host checks for every upload step MUST
  run **before the batch's first step runs** (D-015-5): each step's files are resolved, the owner is
  asked about any directory that needs it — in step order, one question at a time — and the content
  is read; only then is the batch sent to the extension. A "no" to any step refuses the whole batch
  before anything happens on the page, with the standalone reason naming that step. An
  `upload_image` step can therefore only name a screenshot that existed before the batch; one taken
  by an earlier step of the same batch is refused as an unknown id, and the refusal says to upload it
  in a later call.
- **FR-211**: The checks applied to an upload step MUST be the very checks applied to a standalone
  call — allowed-directory resolution, the in-the-moment directory question (once / remember / no),
  never remembering a disk or share root, reading paths into content on the host, the screenshot
  cache lookup with its named refusals, and the size bounds — implemented once and used by both.
  A test MUST fail if the batch path and the standalone path can diverge.
- **FR-212**: A declined upload step, or one whose host check fails, MUST refuse the batch before
  its first step runs (FR-210). An upload step that passed the host checks but fails in the page
  (for example the target is not a file input) MUST stop the batch at that step with the standalone
  reason; steps after it MUST NOT run; steps before it keep their answers.
- **FR-213**: No path read on the host for an upload step MAY be sent to the extension as a path;
  only content crosses to the extension, as for a standalone call.
- **FR-214**: Interrupt and stop MUST withdraw a pending upload question raised by a batch step
  exactly as for a standalone upload.
- **FR-215**: The contract's list of batchable tools and the behaviour MUST agree: both uploads are
  listed and work; the note in 013 that they are listed but unusable is closed.

**Pairing withdrawal (D-015-4)**

- **FR-216**: When the host stops waiting for a session's pairing answer (its bound expired, or the
  session ended), it MUST tell the extension that session's request is withdrawn.
- **FR-217**: On a withdrawal the extension MUST remove that session from the card's waiting list;
  the card MUST leave the panel, and the toolbar attention MUST clear, when no session is left.
- **FR-218**: An answer to a card MUST settle only the sessions still waiting on it at the moment of
  the answer; a withdrawn session's later request MUST be settled only by an answer to that later
  request.
- **FR-219**: The withdrawal message MUST be optional on the link (protocol version unchanged): an
  extension that does not know it ignores it and keeps today's behaviour; a host that does not send
  it leaves today's behaviour.

**Close-out**

- **FR-220**: Every place that states the version MUST state 0.8.0 (manifest, host self-report,
  package name, watermark).
- **FR-221**: A public snapshot of 0.8.0 MUST pass the snapshot check; pushing, tagging, releasing
  and changing the repository's visibility MUST wait for the owner's go-ahead at that time.
- **FR-222**: An agent-path run in Microsoft Edge (pair, read, press, upload) MUST be performed and
  its results recorded on issue #2. A failure there is recorded as a finding; it blocks 015 only if
  it is in behaviour this feature changed.

### Key Entities

- **Press outcome**: what one press caused within its observation window — this tab's document
  replaced (new address), new tabs (tab id, address, held or not), downloads started (download
  identity), or nothing observed (with the window length).
- **Binding failure reason**: why a tab could not be acted on — tab gone, page not actionable,
  runtime not answering — plus whether a retry may help.
- **Download completion**: a download of one session that reached a final state, with its finish
  time and whether it has been answered to that session.
- **Upload step**: a batch step naming files or a screenshot, carried through the one host check
  and turned into content before it reaches the extension.
- **Pairing withdrawal**: the host's statement that a session no longer waits for a pairing answer;
  removes that session from a card's waiting list.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-109**: Across the six link variants of User Story 1 (same origin, cross origin, redirect, new
  tab, download, page-cancelled), pressed through each press-type tool and as a batch step, 100% of
  answers name what the browser actually did.
- **SC-110**: The false-`stale` reproduction shows 0 false `stale` answers in 20 consecutive runs
  after the fix (it showed 3 in 4 before).
- **SC-111**: In the two-download scenario, both completions are answered exactly once, in finishing
  order, in 10 of 10 runs; 0 completions are missed or repeated.
- **SC-112**: The upload check matrix (inside an allowed directory; outside with once / remember /
  no; a disk root; an unknown and an expired screenshot id; an oversize image) gives identical
  outcomes as standalone calls and as batch steps in 100% of cases, and in 0 cases does a file
  outside the allowed directories reach a page without the owner's yes.
- **SC-113**: A pairing card whose only session's request was withdrawn leaves the panel within 2
  seconds in 10 of 10 runs; with a second session still waiting it stays in 10 of 10.
- **SC-114**: The full unit, contract and snapshot suites pass; the agent browser gate passes on the
  developer browser and on the owner's branded browser; the fresh-context code review of the upload
  slice passes with every finding resolved.
- **SC-115**: The Edge run's results for pair, read, press and upload are recorded on issue #2.

## Assumptions

- The observation window for a press is short (on the order of the existing press verification,
  about one second); the answer states it rather than waiting for page loads. Waiting for a page to
  finish loading stays the job of `wait` and `navigate`.
- "Whether the session holds a new tab" follows the existing rules for tabs opened from a held tab;
  this feature reports, it does not change ownership.
- The session's download list keeps its current size (the latest 20); an evicted, unanswered
  completion is lost, as today.
- The owner's branded Chrome (153) is available for one attached run at close-out, launched by the
  owner; the developer browser (Chromium 151) can be launched unattended.
- Edge is installed on the owner's machine for the close-out run; if it is not, FR-222 is recorded
  as not run with that reason.
- Publishing (push, tag, release, visibility) is an outward action and is always confirmed by the
  owner at the time.

## Out of Scope

- macOS and Linux support (issue #1), the spring-physics cursor, a favicon badge, a settings page.
- Waiting for page load after a press; that remains `wait` / `navigate`.
- New upload sources (anything other than allowed local files and the session's own screenshots).
- Changing which tabs a session holds when a press opens one.
- Brave live check (registration exists since 010; only Edge is run here).

## Traceability

| Decision | Requirements | Success criteria |
| --- | --- | --- |
| D-015-1 link clicks | FR-200 – FR-203 | SC-109 |
| D-015-1 false stale (found by its measurement) | FR-204 – FR-206 | SC-110 |
| D-015-2 downloads | FR-207 – FR-209 | SC-111 |
| D-015-3 uploads in a batch | FR-210 – FR-215 | SC-112, SC-114 (review) |
| D-015-4 pairing withdrawal | FR-216 – FR-219 | SC-113 |
| Close-out | FR-220 – FR-222 | SC-114, SC-115 |

# Feature Specification: Recording, Dialogs and Window Restore

**Feature Branch**: `008-recording-and-dialogs` (logical feature identifier; the spec was written on the
git branch `worktree-feature-008-spec`)

**Feature Directory**: `specs/008-recording-and-dialogs`

**Created**: 2026-09-19

**Status**: Complete 2026-09-19 — gate and probes green on Chromium 151 and on the owner's branded Chrome (153 at run time). Evidence
per requirement in `coverage.md`; owner decisions D-008-1 to D-008-8 taken 2026-09-18/19

**Input**: Owner direction of 2026-09-18, the day the QA team first used the MCP bridge: fill the
"agent drives the browser" scope before anything else, because QA will use it daily; recording the run
as a GIF matters most to them; parity with the reference extensions stays the long-term goal, one step
at a time; the project is to become open source later, so visible output should look finished. Twelve
decisions were taken in a one-question-at-a-time review that evening (recorded below). The owner also
asked for a process change after earlier features lost days to guess-and-retry: read the references'
implementation *before* the specification and cite it from every requirement, so that no task is
briefed without the evidence it needs.

**Authoritative Source Order**: Constitution → `docs/product-requirements-draft.md` (PR-020, PR-013,
PR-005, PR-006, PR-008) → the behaviour analysis (kept in the private archive; its public summary is
`docs/design-notes.md`), written 2026-09-18/19 *before* this document → the owner's two
illustrated decision pages (overlays: <https://claude.ai/artifact/DVp3VxLnsLcX1MqS88Q468>; dialog consent
flow: <https://claude.ai/artifact/HG9bPNBneSbeqsuTWJ6aRN>).

## Why this feature exists

The 29 tools of feature 005 let a coding agent drive real sites on the owner's branded Chrome. Handing
the bridge to a QA team exposed three things a tester needs that no tool gives them:

- **No record of what the agent did.** A tester who asks an agent to walk through a flow gets a text
  transcript and, at best, the screenshots the agent chose to take. Test evidence wants a single file
  that shows every step in order. Claude in Chrome records the run as an animated GIF with the click
  positions and action labels drawn on each frame (design-notes §2); Codex has nothing comparable.
- **A native dialog stalls the run.** When a page opens `alert`, `confirm`, `prompt` or a "leave site?"
  prompt, the tab is modal, every tool call waits until it times out, and the recording (once it exists)
  stops at that frame. Neither reference handles `alert`/`confirm`/`prompt` for the agent; Claude in
  Chrome auto-declines only "leave site?" and lets the agent force through it; Codex exposes an
  accept/dismiss action over the wire (design-notes §3). QA flows are full of "are you sure?" confirms.
- **The tester's window is left un-maximised.** `resize_window` honestly un-maximises a window before
  sizing it (003 FR-045, 2026-09-16) and nothing puts it back; the owner deferred the restore on
  2026-09-16 with a written design. Neither reference restores a window (design-notes §5).

Feature 008 closes exactly these three, plus the one permission the first needs.

## Owner decisions recorded before specification

Taken by the product owner on 2026-09-18 (D-008-1 to D-008-4, D-008-6 to D-008-8) and 2026-09-19
(D-008-5) in the order the questions were asked; each is binding for this feature.

| ID | Decision | Constitution touchpoint |
| --- | --- | --- |
| D-008-1 | **Recording is driven by the agent, not by a panel button** (Q1): the agent starts, stops, exports and clears; a frame is taken after every page-changing action, after every step of a batch and after every explicit screenshot (Q2). If the session ends while a recording is open, the recording is exported anyway so nothing recorded is lost. | PR-013 (visual export), PR-020; design-notes §2 |
| D-008-2 | **A recording never loses its beginning silently** (Q3): the cap is 200 frames; when it is reached the recording stops and every later action's answer says so, so the agent can export or clear. Timing is fixed: 800 ms per frame, the last frame held 2 s longer. Frames leave the worker as they are taken and live in a dedicated off-screen page of the extension for as long as a recording is open, so a worker restart does not lose them (the reference keeps them in worker memory and loses them; design-notes §2). | XI (defined failure), PR-013 |
| D-008-3 | **The exported file goes where the browser puts downloads** (Q4): the agent may choose the *file name* only (never a folder), default `agent-recording-<timestamp>.gif`; the download is attributed to the session so `downloads_context` lists it (005). Frames are drawn on before encoding as in the reference, in full (Q5, option C, chosen for open-source polish): action label, step count, click/drag marker, progress bar, and a watermark that is the extension's name and version read at run time (Q11) — never a fixed brand, since the project's public name is not decided. Two things the reference does not do (design-notes §2): the label is cut at 40 characters, and a password or payment-card value is drawn as `••••`. | VI (data minimisation), II, PR-013 |
| D-008-4 | **Dialogs are part of this feature** (Q6) and **accepting one is an effect under the site's mode** (Q7), with the following made explicit so that `ask` mode does not ask twice for one action: `alert` and *dismiss* never ask; an *accept* that follows an approved effect on the same tab within one second is shown as a notice, not a blocking card; every dialog's text is always recorded in the panel; "leave site?" defaults to staying on the page and telling the agent, and forcing through it is an effect. Neither reference gates dialog handling; this is our consent model, not parity. | VI, PR-008, PR-006; design-notes §2–§3 |
| D-008-5 | **What is on the screen, the agent may see** (decided 2026-09-19): hearing a dialog requires the page-events domain of the browser's debugging facility on the held tab's attachment. 004 promised (FR-071, and the attachment module's stated invariant) that no event-bearing domain is enabled without the site's diagnostics grant, with one stated exception for geometry. This feature adds a **second stated exception on the same three counts**: only dialog events are consumed, nothing else from that domain is buffered or reachable by any tool, and the text a dialog carries is content already on the screen — what a screenshot (ungated since 003) shows. The alternative (type only, text behind the diagnostics grant) was put to the owner and declined: the tester would see the text in the panel while the agent had to guess. The invariant test is extended to pin the exception, and a code-reviewer passes the slice. | VI, PR-008; design-notes §3 (the reference enables this domain unconditionally) |
| D-008-6 | **Window restore is in scope** (Q8); `viewport` override, zoom and image upload are the next feature (009). The 2026-09-16 design stands: remember a window's maximized/full-screen state when `resize_window` leaves it, put it back when the session's last tab in that window is released or the session ends; a window closed meanwhile is forgotten; a window the owner re-maximised by hand is left alone; when two sessions resized the same window the last one to let go restores it; a window the owner resized by hand after the agent is **not** restored (their choice wins). No reference behaviour exists (design-notes §5); this is our design, proven by measurement. | XI, PR-005 |
| D-008-7 | **Acceptance is the 004 standard plus reading the GIF back** (Q9): on the owner's branded Chrome 152 in attach mode, against named public pages, with a scripted non-interactive coding-agent session as caller; the gate decodes the exported GIF and checks frame count and sampled label text. The QA team's feedback is welcome but is **not** a gate on closing this feature; it gets its own list when it arrives. | VII |
| D-008-8 | **Delivered as 0.2.0** (Q10): a new package, two new QA-guide sections (recording, dialogs), and a proven in-place upgrade from 0.1.0 that keeps the pairing and every site's stored mode — never tested in 007. The `offscreen` permission is added to the `agent` build only, traced under D-003-1 to the encoder requirement, and its page is limited to image work: no network, no page access, opened when a recording starts and closed when the last recording is exported or cleared (Q12; the 001 MUST-omit list governs the `narrow` build and is unchanged). | V (traced, not broadened), TC-003 |

## Traceability

| Requirement | PR | Evidence |
| --- | --- | --- |
| FR-100–FR-109 (recording) | PR-013, PR-020 | design-notes §2 (CL pipeline), §2–§3 rows 1–13 |
| FR-110–FR-117 (dialogs) | PR-008, PR-006, PR-020 | design-notes §2–§3 rows 14–18 |
| FR-118–FR-120 (window restore) | PR-005 | design-notes §5 — no reference; own design + measurement |
| FR-121–FR-123 (permission, package, guide) | V, PR-020 | permissions traced in design-notes, Permissions (manifests) |
| SC-054–SC-062 | — | acceptance probe reports under `tests/acceptance/probe-004/reports/` |

## Acceptance standard *(binding for every requirement below)*

Unchanged from 004 (D-004-6) and 005: every claim closes on the owner's branded Chrome 152 in attach
mode, against a named public page or a fixture the packaged gate serves, with a scripted
non-interactive coding-agent session as the caller and a timestamped report. Unit and contract tests
prove the shape; the probe proves the behaviour. Nothing is handed to the owner to verify.

Added for this feature (D-008-7): the gate **decodes** every exported GIF it causes — frame count,
per-frame delay, canvas size, and the presence of the label text on at least two sampled frames — and
the probe's report names the file as `downloads_context` reported it.

Named pages for this feature:

- **Recording**: `https://httpbin.org/forms/post` (a form flow of ≥ 12 actions incl. a batch) and
  `https://www.wikipedia.org/` (navigate + type + click, cross-page).
- **Dialogs**: a fixture page served by the packaged gate with buttons that open `alert`, `confirm`,
  `prompt`, a `confirm` opened 300 ms after a click (chained), a `confirm` opened by a timer with no
  preceding action (unchained), and a form with `beforeunload` armed. Public pages open dialogs too
  rarely and too unpredictably to be the named page.
- **Window restore**: any of the above, on a maximized window.

**Process rule (owner, 2026-09-18)**: an implementation task that fails its second attempt is not tried
a third time; the main session re-reads the reference or takes one measurement, writes the answer into
`docs/design-notes.md`, and re-briefs. Every requirement below names the design-notes
section its implementer needs, or says "no reference".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record the run as a GIF (Priority: P1)

A tester asks the agent to "record this, then log in and add an item to the cart". The agent starts a
recording, works through the flow, and exports. A single GIF lands in the tester's download folder,
one frame per step, each frame labelled with what the agent did and where it clicked, and the agent
tells the tester the file name.

**Why this priority**: it is the capability the QA team named first; it is the only deliverable that
turns a run into evidence a tester can attach to a ticket.

**Independent Test**: on the named form page, a scripted caller starts a recording, performs twelve
actions including one batch of three steps and one explicit screenshot, exports with a chosen file
name, and the gate decodes the file: fourteen frames (12 actions with the batch counted as 3, plus the
screenshot, plus the initial frame), 800 ms delays, last frame 2800 ms, label text present.

**Acceptance Scenarios**:

1. **Given** a session holding a tab, **When** the agent starts a recording, **Then** the answer says
   recording started with 0 frames, an initial frame of the current page is taken, and a second start
   is a harmless no-op that says a recording is already open (design-notes §2).
2. **Given** a recording is open, **When** the agent clicks, types, presses keys, scrolls, drags, fills
   a form field, navigates, uploads a file or takes a screenshot, **Then** one frame is taken about
   100 ms after the action settles, and each step of a `browser_batch` counts as its own action
   (design-notes §2). A read (`read_page`, `find`, `get_page_text`) takes no frame.
3. **Given** a frame cannot be captured (the tab is gone, the page is restricted), **Then** the frame is
   skipped, the action's answer is unchanged, and the export answer reports the number of skipped
   frames (the reference skips silently, design-notes §2).
4. **Given** the recording has 200 frames, **When** the agent performs another action, **Then** the
   action succeeds, no frame is added, the recording is marked stopped, and the answer carries
   `recording: "full"` until the agent exports or clears (D-008-2).
5. **Given** a recording with N frames, **When** the agent exports with `filename: "TC-1234"`,
   **Then** a file `TC-1234.gif` appears in the browser's download folder without a save dialog, the
   answer carries the file name, frame count, skipped count, pixel size and byte size, the recording is
   cleared, and `downloads_context` lists the file as complete and attributed to this session.
6. **Given** the agent passes a file name with a path separator, a leading dot, or characters the
   platform forbids, **Then** the export is refused with `invalid-filename` and nothing is written.
7. **Given** a recording with frames and no export, **When** the session ends (Stop, release, agent
   gone), **Then** the recording is exported under the default name and the panel's session card shows
   the file name (D-008-1).
8. **Given** the worker was restarted mid-recording, **When** the agent exports, **Then** every frame
   taken before the restart is in the file (D-008-2).

---

### User Story 2 - See each step on the frame (Priority: P1)

The tester opens the GIF. Every frame shows the page as the browser showed it, plus: a dark label in
a corner saying what the agent did (`#12 type "norton@ex…"`), a step counter (`12 / 47`), a ring at the
click point or an arrow along a drag, a thin progress bar along the bottom, and the extension's name
and version in a corner.

**Why this priority**: without the overlay the GIF is a slideshow the tester has to interpret; with it
the file is self-explaining. The owner chose the full set (option C) for the open-source audience.

**Independent Test**: decode two sampled frames from the US1 export and check the label text, the
counter, the ring position (within 3 px of the click's page coordinate scaled to the canvas) and the
watermark text `Hallpass 0.2.0` (or whatever the manifest says).

**Acceptance Scenarios**:

1. **Given** a click at page point (x, y) on a frame of canvas width W and viewport width V, **Then**
   the ring is centred at (x·W/V, y·W/V) — scaled by the canvas-to-viewport ratio, **not** by the
   device pixel ratio (design-notes §2; this is the coordinate trap that cost three briefs in 004).
2. **Given** a `type` into a password field, or into a field whose autocomplete names a payment-card
   detail, **Then** the label reads `type "••••"`; the same masking rule as 005 FR-073 applies to
   `form_input`.
3. **Given** typed text longer than 40 characters, **Then** the label shows the first 39 and an
   ellipsis.
4. **Given** frames of different sizes (a resize during the recording), **Then** the canvas is the
   largest frame and smaller frames are padded on the right and bottom, with the progress bar and
   watermark anchored to each frame's own visible edge (design-notes §2).
5. **Given** the page-edge glow and the phantom cursor of 004 are on the page, **Then** they are in the
   frame as the page showed them; nothing is hidden before capture (divergence from the reference,
   which hides its indicator — design-notes §2–§3).

---

### User Story 3 - A dialog no longer stalls the run (Priority: P1)

The agent clicks "Delete". The page asks "Delete 3 orders? This cannot be undone." The agent is told at
once what the page asked, decides to accept, and the run continues. In `ask` mode the tester sees the
dialog's text in the panel and, because it followed the click they just approved, is not asked again.

**Why this priority**: every QA flow with a destructive step has a confirm; today one confirm ends the
run in a 25 s silence.

**Independent Test**: on the gate's dialog fixture, a scripted caller triggers each dialog kind and
each consent path; unit tests pin the chained/unchained rule at the 1 s boundary.

**Acceptance Scenarios**:

1. **Given** a held tab opens `alert`, `confirm` or `prompt`, **Then** the answer of the action that
   caused it (or, for a dialog with no cause, the next tool call) carries `dialog: {id, type, message,
   defaultValue?}` and the session's panel card logs "{site} says: {message}" (design-notes §3 for the
   shape; the text is ours — CX carries none).
2. **Given** a dialog is open, **When** the agent calls any tool other than `dialog`, `tabs_context`,
   `downloads_context` or `wait`, **Then** the answer is `blocked-by-dialog` with the same dialog object,
   immediately, not after a timeout (both references time out generically — design-notes §3).
3. **Given** an open `confirm`, **When** the agent calls `dialog {action: "dismiss"}`, **Then** the page
   sees Cancel, the answer is `ok`, no consent is asked in any mode (D-008-4).
4. **Given** an open `alert`, **When** the agent calls `dialog` with either action, **Then** the alert
   closes and no consent is asked (an alert has one button).
5. **Given** `ask` mode, an effect approved at t₀ on tab T, and a `confirm` that opened on T before
   t₀ + 1 s, **When** the agent accepts, **Then** no blocking card is shown; the panel shows a notice
   "dialog accepted: {message}" marked as following the approved action, and the answer is `ok`.
6. **Given** `ask` mode and a `confirm` that opened with no approved effect in the last second on that
   tab (timer, other tab, or the agent waited), **When** the agent accepts, **Then** the consent card is
   shown with the dialog's text and the agent's choice; *allow once* accepts, *always on this site* sets
   `skip-checks` as today, *refuse* dismisses the dialog and answers `refused`.
7. **Given** `follow-a-plan` or `skip-checks` mode, **Then** accept never shows a card; the panel still
   logs the text.
8. **Given** an open `prompt`, **When** the agent accepts with `promptText`, **Then** the page receives
   that text; without `promptText` the dialog's default value is submitted.
9. **Given** the owner closes the dialog by hand while the agent is deciding, **When** the agent calls
   `dialog`, **Then** the answer is `no-dialog`.
10. **Given** the tab has unsaved changes and the agent navigates or closes it, **Then** the "leave
    site?" prompt is auto-answered *stay*, the answer is `blocked-by-beforeunload` with the page URL,
    and nothing is lost (design-notes §3: the reference's default). **When** the agent repeats with
    `force: true`, **Then** that is an effect under the site's mode (card in `ask`, wording "discard
    unsaved changes and leave"), the prompt is answered *leave*, and the answer is the navigation's.
11. **Given** any dialog handled, **Then** within 300 ms the tab answers a trivial read again; if it does
    not, the answer says `page-unresponsive` (the reference has no such check — design-notes §3; added
    because a stuck page after accept is otherwise indistinguishable from a slow one).

---

### User Story 4 - The window goes back the way it was (Priority: P2)

The tester's Chrome is maximized. The agent resizes it to 1024×768 for a responsive check. When the
agent is done with that window, it is maximized again without the tester touching it.

**Why this priority**: a daily annoyance, not a blocker; cheap because the design exists.

**Independent Test**: gate scenario maximize → `resize_window` → release → expect `maximized`; unit
tests for the four edge cases.

**Acceptance Scenarios**:

1. **Given** a maximized window, **When** `resize_window` runs, **Then** the prior state is remembered
   for that window and this session, surviving a worker restart.
2. **Given** a remembered state, **When** the session's last tab in that window is released or the
   session ends, **Then** the window is set back to that state and the memory is dropped.
3. **Given** the window was closed meanwhile, **Then** the memory is dropped silently.
4. **Given** the owner re-maximised by hand before release, **Then** nothing is done.
5. **Given** two sessions resized the same window, **Then** only the last one to let go restores it.
6. **Given** the window's size at release differs from what the tool last set (the owner resized by
   hand), **Then** nothing is restored (D-008-6).

---

### User Story 5 - Upgrade to 0.2.0 without losing anything (Priority: P2)

A tester with 0.1.0 installed runs the 0.2.0 installer. Chrome asks once about the new permission;
afterwards the pairing still holds, every site keeps its mode, and the two new tools appear.

**Why this priority**: the QA team already has 0.1.0; an upgrade that resets consent would cost them a
morning and their trust.

**Independent Test**: install 0.1.0 into a scratch profile, pair, set two site modes, install 0.2.0
over it, verify pairing and modes, call `gif_recorder` once.

**Acceptance Scenarios**:

1. **Given** 0.1.0 installed and paired with two site modes stored, **When** `install.ps1` from the
   0.2.0 zip runs, **Then** the extension folder, host and registrations are replaced, the pairing
   record and site modes are unchanged, and the first tool call needs no new pairing.
2. **Given** the 0.2.0 build, **Then** the manifest declares exactly the 005 permissions plus
   `offscreen`, and the `narrow` build's manifest is byte-identical to 007's.
3. **Given** the QA guide, **Then** it has a "錄製 GIF" section and a "對話框" section with screenshots
   taken on the real panel.

### Edge Cases

- Recording open, tab navigates cross-site: the next frame is the new page; the label says
  `navigate <host>`.
- Export while a frame is still being captured: the export waits for it (≤ 1 s) and includes it.
- Two sessions each recording their own tabs: two independent recordings; a frame is attributed by the
  session that caused the action.
- `clear` with no recording: `ok` with 0 frames cleared.
- Export of 0 frames: refused `empty-recording`.
- The download folder is unavailable (removable drive gone): the export answers `download-failed` with
  the browser's reason and keeps the frames so the agent can retry.
- Dialog opens during a `browser_batch`: the batch stops at that step (its existing rule) and the
  step's answer carries the dialog object.
- Dialog opens while a `wait` is running: the wait ends `condition-unmet` with the dialog object.
- A dialog on a tab the session does not hold: ignored (not the session's business; the owner's own
  browsing is not observed).
- The debugging attachment cannot be made (developer tools open on the tab): dialogs on that tab are
  not heard; the first blocked tool call answers `blocked-by-dialog` with `message: null` after the
  existing input-unavailable rule fires, so the agent still knows why.
- Window restore when the worker is restarted between resize and release: state came from session
  storage; restore still happens.
- Restore target is `fullscreen`: restored to `fullscreen`.

## Requirements *(mandatory)*

### Functional Requirements

**Recording (US1, US2) — design-notes §2–§3**

- **FR-100 (PR-013, PR-020 — MUST)**: A new tool `gif_recorder` with `action: "start" | "stop" |
  "export" | "clear"` and, for export, an optional `filename` (base name without extension; letters,
  digits, space, `-`, `_`, `.` not leading; ≤ 80 chars; `.gif` appended). One recording per session.
  `start` on an open recording answers `ok` with `alreadyRecording: true`; `stop` freezes the frame list
  without exporting; `clear` discards it. Answers: `{state: "recording"|"stopped"|"none", frames,
  skipped, full}` and, for export, `{filename, frames, skipped, width, height, bytes, downloadId}`.
  Refusals: `invalid-filename`, `empty-recording`, `download-failed {reason}`.
- **FR-101 (PR-013 — MUST)**: While a recording is open, every page-changing tool (the click family,
  `hover`, `drag`, `type`, `key`, `scroll`, `form_input`, `navigate`, `file_upload`, `dialog`,
  `resize_window`) and every `screenshot` MUST add one frame after the action settles (≈ 100 ms), each
  `browser_batch` step counting as its own action; reads add none. `start` adds an initial frame. Frame
  capture uses the tab's existing screenshot path (JPEG, downscaled like a screenshot); a failed capture
  skips the frame, increments `skipped`, and never changes the action's own answer.
- **FR-102 (PR-013 — MUST)**: The cap is 200 frames. Reaching it sets `full: true`, stops adding frames,
  and every later action's answer in that session carries `recording: "full"` until export or clear.
- **FR-103 (PR-013 — MUST)**: Frames MUST NOT depend on the worker staying alive: as each frame is
  captured it is handed to the extension's off-screen page, which holds frames for every open recording;
  the page is opened at the first `start` and closed when no recording remains after an export or clear
  (D-008-2, D-008-8). A worker restart mid-recording loses no frame already handed over.
- **FR-104 (PR-013 — MUST)**: Export encodes an animated GIF: canvas = largest frame's size, smaller
  frames padded right/bottom with white, 800 ms per frame, +2000 ms on the last, looping. Encoding
  happens in the off-screen page; the worker never holds the encoded bytes longer than the download
  hand-off.
- **FR-105 (PR-013 — MUST)**: Before encoding, each frame is drawn on with, in this order: (a) for
  click-family, `hover`, `form_input` and `scroll` actions a ring at the action point; for `drag` a line
  with an arrowhead from start to end with both points marked; (b) an action label `#n <tool> <target
  or text>` near the point (or top-left for actions without a point), text cut to 40 characters with an
  ellipsis; (c) a step counter `n / N` bottom-right; (d) a progress bar along the bottom, fill n / N;
  (e) a watermark bottom-left: the manifest's name and version at run time. Scaling from page
  coordinates to canvas pixels uses the canvas-width ÷ viewport-width ratio recorded with the frame,
  never the device pixel ratio alone. The owner's approved look is the "C" column of the overlay page.
- **FR-106 (PR-013, VI — MUST)**: A label MUST show `••••` in place of the text when the action typed
  into or set a field that 005 FR-073 classifies as redacted (password, hidden, or autocomplete naming a
  password, one-time code or payment-card detail). The rule is evaluated on the target at action time.
- **FR-107 (PR-013, PR-020 — MUST)**: Export writes the file through the browser's download facility
  into its default download folder with no save dialog, attributed to the session so that `wait
  {condition: "download-complete"}` and `downloads_context` (005 FR-078/FR-079) see it like any other
  download; the temporary object URL is released once the download completes or fails. Default name
  `agent-recording-<yyyyMMdd-HHmmss>.gif`.
- **FR-108 (PR-013 — MUST)**: When a session ends (Stop, release of its last tab, agent disconnect,
  pairing revoked) with a recording that has ≥ 1 frame, the recording is exported under the default
  name before the session's resources go; the session card's last line names the file. A recording of
  0 frames is dropped.
- **FR-109 (MUST)**: The recording's memory cost is bounded: a frame is at most the size a screenshot
  answer may be (005), so 200 frames ≤ ~200 MB worst case and ≈ 20 MB typical; the off-screen page
  releases every frame on export or clear. The panel shows a session's recording state (frames, full)
  on its card.

**Dialogs (US3) — design-notes §2–§3**

- **FR-110 (PR-008, PR-020 — MUST)**: On a held tab, the session MUST hear `alert`, `confirm`, `prompt`
  and "leave site?" dialogs opening and closing, and hold at most one *current dialog* per tab as
  `{id, type, message, defaultValue?, openedAt, tabId}`. `id` is the session's own counter. Dialogs on
  tabs the session does not hold are ignored.
- **FR-111 (PR-020 — MUST)**: While a current dialog exists on a tab, every tool that acts on or reads
  that tab, except `dialog`, `tabs_context`, `downloads_context`, `wait`, `tabs_release` (the agent may walk
  away and leave the dialog to the owner) and the tools that name no tab (`tabs_create`, `gif_recorder`),
  MUST answer `blocked-by-dialog {dialog}` immediately. The action that caused the dialog answers its own result
  with `dialog` attached; a `browser_batch` stops at that step; a running `wait` ends `condition-unmet
  {dialog}`.
- **FR-112 (PR-008, PR-020 — MUST)**: A new tool `dialog {tabId, action: "accept" | "dismiss",
  promptText?}`. `dismiss` and any action on an `alert` are never gated. `accept` on a `confirm` or
  `prompt` is an effect under the tab's site mode (003 D-003-2), **except** that when an approved effect
  on the same tab completed within the last 1000 ms before the dialog opened, `accept` is treated as
  covered by that approval: no card, a panel notice instead. One approval covers **one** dialog (the
  record is consumed by the chained accept); an approved action that changes nothing on the page
  (`computer` screenshot/wait) writes no record. Under `follow-a-plan`, an `accept` on the plan's site
  is admitted like any step of the plan (US3 scenario 7). Answers: `ok`, `refused` (the owner refused;
  the dialog is dismissed), `no-dialog`, `page-unresponsive`.
- **FR-113 (PR-006 — MUST)**: The session's panel card MUST keep a short activity list (last 20 items)
  and every dialog appears in it as "{site} says: {message}" with the outcome (accepted / dismissed /
  accepted following the approved {action} / refused by you / closed by you), in every mode. This list
  also receives window restores. A recording's export is shown on the card's own recording line
  ("exported {filename}", FR-108/FR-109) rather than as an activity item, so the one fact about the
  recording is in one place (amended 2026-09-19 after T238 found the implementation had chosen this).
- **FR-114 (PR-008 — MUST)**: The `ask`-mode card for an unchained `accept` reads "{agent} wants to
  press OK on the page's dialog" with the dialog text quoted beneath and the three existing buttons;
  *refuse* dismisses the dialog. The notice for a chained accept is non-blocking and is dismissed with
  the card stack's normal rules (006 D-006-6).
- **FR-115 (PR-005, PR-020 — MUST)**: A "leave site?" prompt raised by the agent's own `navigate` or
  `tabs_close` is answered *stay* by default and the tool answers `blocked-by-beforeunload {url}` within
  300 ms; the same call with `force: true` is an effect under the site mode (card wording: "discard
  unsaved changes and leave {site}"), answers *leave*, and then returns the navigation's or close's
  normal answer. A "leave site?" prompt from the owner's own action on a held tab is not touched.
- **FR-116 (PR-020 — MUST)**: After any dialog is answered, the tool MUST confirm within 300 ms that the
  tab responds to a trivial read; otherwise it answers `page-unresponsive` and the current dialog is
  cleared. (No reference does this — design-notes §3; own addition.)
- **FR-117 (VI, PR-008 — MUST)**: Hearing dialogs MUST NOT widen what the agent can learn about a page
  beyond the dialog's own text: no other event of the page-events domain is buffered, exposed or
  consumed by any tool, and the 004 attachment invariant test is extended to pin this (D-008-5).

**Window restore (US4) — no reference; own design, design-notes §5**

- **FR-118 (PR-005 — MUST)**: When `resize_window` returns a maximized or full-screen window to normal
  (003 FR-045), it records `{windowId, priorState, sessionId, setSize}` in session-scoped storage that
  survives a worker restart.
- **FR-119 (PR-005 — MUST)**: When the session releases its last tab in that window, or ends, the
  window is returned to `priorState` and the record dropped — unless the window no longer exists (drop
  silently), its state is already `priorState` (drop, do nothing), another session still holds a record
  for it (leave it to the last holder), or its current size differs from `setSize` (the owner resized by
  hand; drop, do nothing). The panel activity list notes "window restored to {state}".
- **FR-120 (MUST)**: `resize_window` on a window with an existing record from the same session updates
  `setSize` only; `priorState` is the first one seen.

**Permission, package, guide (US5) — permissions traced in design-notes, Permissions**

- **FR-121 (V — MUST)**: The `agent` build's manifest adds exactly `offscreen`, justified as image
  encoding for FR-103/FR-104; the off-screen page loads only extension-local scripts, makes no network
  request, receives frames and returns encoded bytes and nothing else, and is closed per FR-103. The
  `narrow` build's manifest is unchanged (001 contract, 004 FR-070). A contract test pins both.
- **FR-122 (PR-020 — MUST)**: `npm run package` produces `release/hallpass-0.2.0.zip` with the
  007 shape; the installer applied over a 0.1.0 installation preserves the pairing record and stored
  site modes and diagnostics grants (US5 scenario 1). Version is read from one place and stamped into
  the manifest, the zip name and the watermark.
- **FR-123 (MUST)**: `docs/qa-guide.html` gains "錄製 GIF" (how to ask for a recording, where the file
  lands, what the overlays mean, the 200-frame limit) and "對話框" (what the tester sees in each mode,
  what refuse does, the "leave site?" default), each with a real-panel screenshot; the operations guide
  lists the two new tools and the new permission.

### Key Entities

- **Recording**: per session; `state`, ordered frames, `skipped`, `full`, `startedAt`. Lives in the
  off-screen page; the worker keeps only the state summary.
- **Frame**: JPEG bytes, `capturedAt`, `viewportWidth/Height`, `canvasScale` (capture width ÷
  viewport width), the causing **Action** `{index, tool, targetLabel, text?, redacted, point?, from?,
  to?}`.
- **Current dialog**: per held tab; `{id, type, message, defaultValue?, openedAt, tabId, chainedTo?}`
  where `chainedTo` names the approved effect it followed, if any.
- **Window restore record**: `{windowId, priorState, sessionId, setSize}` in session storage.
- **Activity item** (panel): `{at, kind: dialog | export | restore, text, outcome}`, last 20 per session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-054**: On the named form page, a scripted caller's 12-action flow (one 3-step batch, one
  screenshot) exports a GIF the gate decodes to exactly 14 frames, 800 ms delays, 2800 ms last delay,
  with the label text found on the two sampled frames — 3 runs out of 3.
- **SC-055**: A recording pushed past 200 actions ends with exactly 200 frames and every action past
  the cap answered `recording: "full"`; the first frame is the initial page (nothing dropped from the
  start).
- **SC-056**: Killing the worker after frame 6 of a 10-action recording yields a 10-frame export
  (plus initial) — 3 runs out of 3.
- **SC-057**: The exported file is listed by `downloads_context` as complete with the chosen name
  within 5 s of export in every probe run; an invalid name is refused with nothing written.
- **SC-058**: On the dialog fixture, each of alert / confirm-dismiss / chained-accept / unchained-accept
  / prompt-with-text / beforeunload-stay / beforeunload-force behaves as its US3 scenario says — 1/1
  each per probe run; a tool call during an open dialog answers `blocked-by-dialog` in under 500 ms
  (today: 25 s).
- **SC-059**: The unit suite pins the chained boundary: 999 ms → notice, 1001 ms → card; other tab → card.
- **SC-060**: Maximize → resize → release returns the window to `maximized` in 3/3 gate runs; the four
  edge cases pass as unit tests.
- **SC-061**: 0.1.0 → 0.2.0 install over a paired scratch profile keeps the pairing and both stored
  site modes; the first tool call after upgrade needs no pairing prompt — 1/1.
- **SC-062**: The `agent` manifest's permission set is 005's plus `offscreen` and nothing else; the
  `narrow` manifest is byte-identical to 007's (contract test).

## Assumptions

- The QA team's callers (Claude Code, CodeBuddy, Cursor, Codex) all render a tool's structured answer to
  the agent; `recording: "full"` and `dialog` objects need no client-specific plumbing.
- The panel has no activity list today (006 has session cards only); FR-113 adds a bounded one rather
  than a full log, which is a later feature if QA asks.
- A frame captured through the tab's existing screenshot path is acceptable evidence even when it is
  downscaled; QA does not need pixel-exact frames.
- The gate can decode GIFs with a small pure-JS decoder in the test kit; no new production dependency.
- Version stamping (`0.2.0`) replaces the `0.0.0` in the three `package.json` files as the single source.
- The chained-accept window of 1000 ms is a starting value; if the probe shows real pages opening
  confirms later than that after a click, the value is revisited with the measurement in the evidence
  file, not guessed.

## Out of scope

- `viewport` CSS override, `zoom`, `upload_image` (feature 009); tab-group colouring and organisation;
  a browser visibility toggle; raw CDP passthrough; plan-as-a-tool; saved prompts.
- A panel-driven (button) recording, a live preview, per-frame editing, MP4/WebM output, real-time
  frame spacing.
- Open-source preparation: public name, LICENSE, README language, scrubbing identifiers from evidence
  files, a store listing.
- Triage of the QA team's feedback (own list when it arrives).
- Any change to the archived remote path, its consent model or the `narrow` manifest.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-09-19 | Feature closed: `coverage.md` maps every FR to the test, gate scenario and probe run that proves it, and names what only Chromium 151 has seen; FR-123's two guide sections written with real-panel screenshots (`agent-guide-shots.spec.ts`); the `download-failed` case is now driven live on the gate (the browser is told to refuse the file) instead of being skipped | T236, T238 |
| 2026-09-19 | Probe run T237 found two honesty gaps, both fixed (2cc72f6): a `screenshot` answer reached the agent as an image alone, so FR-101's `recording` was invisible on it; and the export answered the *requested* name while the browser had uniquified the file — FR-107 now reports the name the browser saved | S9 probe (`claude -p`), 2026-09-19 |
| 2026-09-19 | Branded-Chrome run (153.0.8010.50): the 200-frame export exceeded the flat 30 s call bound → `AGENT_EXPORT_CALL_TIMEOUT_MS` (180 s) for `gif_recorder export` (2481860); measured 31.5 s / 17.3 MB for 200 frames | Owner's Chrome gate, 2026-09-19 |
| 2026-09-19 | FR-113 amended: a recording's export is shown on the card's recording line, not as an activity item (T238 found the implementation had chosen the single place; the owner may reverse) | main session, 2026-09-19 |
| 2026-09-19 | S4 review (T230): FR-111 pass-through widened to `tabs_release` and the tab-less tools; FR-112 gains "one approval, one dialog", no record for positionless `computer` actions, and the `follow-a-plan` admission of scenario 7; FR-115's owner clause was found violated (every `beforeunload` was auto-answered) and fixed with a test; dialog state is now forgotten on session end and on detach | code-reviewer, 2026-09-19 |
| 2026-09-19 | D-008-5 decided (option A: on-screen dialog text is visible to the agent without the diagnostics grant; second stated exception, pinned by test, reviewed) | Owner, 2026-09-19 |
| 2026-09-19 | Initial specification; owner decisions D-008-1–8; evidence file written first per the owner's 2026-09-18 process instruction | 2026-09-18 owner review (12 questions), reference reading 2026-09-18/19 |

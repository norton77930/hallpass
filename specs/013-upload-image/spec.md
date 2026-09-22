# Feature Specification: Upload a Session Screenshot into a Page

**Feature Branch**: `013-upload-image` (git: `feature-013-upload-image` in the `feature-008-spec`
worktree, from `feature-012-viewport-zoom` at 117f581 so that 012 and 013 both fast-forward into
`main` in order)

**Feature Directory**: `specs/013-upload-image`

**Created**: 2026-09-22

**Status**: Draft; owner decisions D-013-1 to D-013-5 taken 2026-09-22 (below); ready for
`/speckit-plan`.

**Input**: Owner discussion of 2026-09-22 after feature 012 closed: the `upload_image` capability
split off by D-012-1. The reference reading behind this document is §3 of the private evidence
file for 012 (one reference implements it; the other has nothing at the extension level).

**Owner decisions (2026-09-22)**:

- **D-013-1** — The only thing the agent can upload this way is a screenshot the same session took
  earlier through this product. Every screenshot answer (the `screenshot` tool and the `computer`
  tool's screenshot action) carries an image id the agent quotes back. No file from disk, no image
  the agent composes itself, no image from another session.
- **D-013-2** — Screenshot bytes are retained for a bounded time (5 minutes from capture) within a
  bounded total budget (8 MiB of stored image data per session, oldest evicted first), per session.
  Retention survives a recycled worker and ends with the browser.
- **D-013-3** — Both delivery paths ship: into a file input named by a reference, and dropped at a
  coordinate for pages that accept drag-and-drop instead of an input (the motivating case is a
  document editor with no visible input).
- **D-013-4** — The upload is a page effect and passes the existing per-site consent exactly as
  `file_upload` does; no new consent card or panel section; the panel activity list gets one line
  per upload.
- **D-013-5** — Version 0.5.0 ships 013; the tool count goes from 32 to 33.

**Authoritative Source Order**: Constitution (II clean room, IV explicit uncertainty, VI privacy
and data minimisation, VII observable, XI defined failure) → `docs/product-requirements-draft.md`
PR-006 (screenshots) and PR-009 (files into a page) → the owner's decisions above → 003 US7 /
FR-051 (`file_upload`, the sibling this rides beside) → `docs/design-notes.md` §7 ("image upload
stays planned, not skipped") → the private reference evidence (012 file, §3) → the repository's own
code as read on 2026-09-22 (facts cited inline).

## Why this feature exists

An agent testing an image-handling feature (an avatar picker, a bug-report form with an attachment
field, a document editor that accepts dropped pictures) needs a picture to hand the page. The
picture it already has is the screenshot it just took. Today `file_upload` places files from the
owner's disk, but the agent cannot write a screenshot to disk through this product and the owner
would have to configure an upload root for it. So the flow "take a screenshot, put it into this
form, check the preview" is impossible without the owner's hands.

The design keeps the privacy shape of everything else here: the image never leaves the browser or
the session that took it, nothing new is read from disk, the bytes are gone after a short time, and
putting them into a page is a page effect the site's consent mode governs like any click.

The reference that implements this mints an id on every screenshot answer, keeps the bytes for a
bounded time and budget per session, and injects them as a file either into an input or as a drop
at a point. The behaviour here is designed from those observations and from this product's own
consent and session model; answer wording and event naming are this product's own (Constitution II).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Put the screenshot I just took into a file input (Priority: P1)

A coding agent holds a tab on a form with an attachment field, takes a screenshot of the page,
reads the page to find the field's reference, and uploads that screenshot to it by quoting the
screenshot's id. The page's own change handling runs and its preview shows the picture; the answer
states what the input now holds. The owner, on a site set to "ask", is asked once, the same way
they are asked before a click.

**Why this priority**: it is the flow with no substitute today, and the reference path that every
form-based upload test needs.

**Independent Test**: on the packaged gate's upload fixture, take a screenshot, read the page,
upload the screenshot by id to the input's reference, assert the fixture reports one file with the
given name, a PNG type and the screenshot's byte size, and that the page's change handling ran.

**Acceptance Scenarios**:

1. **Given** a screenshot answer from this session, **When** the agent reads it, **Then** it
   contains an image id and a sentence saying the id can be uploaded with the upload tool.
2. **Given** a site in `skip-checks` mode, a file-input reference and a fresh image id, **When** the
   agent uploads, **Then** the input holds one file with the requested name (default provided), the
   page's change handling ran, and the answer states the file's name and size as read from the page.
3. **Given** a site in `ask` mode, **When** the agent uploads, **Then** the owner is asked before
   anything is put into the page, with the same card a click would show; a refusal leaves the input
   empty and the answer says the owner declined.
4. **Given** an id this session never issued, an id from another session, or an id whose bytes have
   expired or been evicted, **When** the agent uploads, **Then** the answer refuses with the reason
   (unknown, or no longer available) and tells the agent to take a new screenshot; nothing is put
   into the page.
5. **Given** a reference that is not a file input and not a drop target, **When** the agent
   uploads to it, **Then** the answer refuses naming what the element is; nothing changes.
6. **Given** the worker was recycled between the screenshot and the upload (within the retention
   time), **When** the agent uploads, **Then** it succeeds; retention is a session fact.

---

### User Story 2 - Drop the screenshot where the page wants it (Priority: P2)

An agent working in a page that accepts pictures by drag-and-drop and has no reachable file input
drops the screenshot at a coordinate, the way a person would drag a file from their desktop onto
that spot. The page receives a drop with one file in it; the answer states where the drop landed
and what was dropped.

**Why this priority**: it is the only way into editor-style pages; it costs the drag event
sequence on top of story 1.

**Independent Test**: on the gate's drop fixture, drop a fresh screenshot at the fixture's drop
zone coordinate; assert the fixture reports the file's name, type and size from the drop, and that
it saw the drag-enter and drag-over that precede a real drop.

**Acceptance Scenarios**:

1. **Given** a `skip-checks` site with a drop zone at a known point and a fresh image id, **When**
   the agent drops at that coordinate, **Then** the zone reports one PNG file with the given name and
   the screenshot's size, having received the enter, over and drop sequence in order.
2. **Given** a reference (not a coordinate) that names a drop zone which is not a file input,
   **When** the agent uploads to it, **Then** the drop is delivered at the element's centre and the
   answer says so.
3. **Given** the coordinate lies inside a same-origin child frame, **When** the agent drops there,
   **Then** the element under the point inside that frame receives the drop (one level down; deeper
   nesting and cross-origin frames answer "not reachable").
4. **Given** a coordinate outside the viewport, **When** the agent drops, **Then** the call is
   refused naming the viewport's size.
5. **Given** both a reference and a coordinate in one call, or neither, **When** the agent calls,
   **Then** the call is refused as ambiguous or incomplete; nothing happens.
6. **Given** the coordinate is over an element that is a file input, **When** the agent drops,
   **Then** the file is placed into that input as in story 1 (the page gets the more useful of the
   two) and the answer says which happened.

---

### User Story 3 - The bytes are short-lived and stay in the session (Priority: P3)

The owner knows that a screenshot the agent took is kept only briefly, only for that agent's
session, and only inside their browser. Five minutes after capture it is gone whether or not it was
used; if the session takes many screenshots, the oldest are dropped first once the budget is
reached; ending the session or closing the browser ends retention.

**Why this priority**: it is a privacy property the owner relies on, not a capability the agent
uses; it must be true from the first release.

**Independent Test**: unit checks on the retention rules (expiry at the bound, eviction order
when the budget is exceeded, an image larger than the whole budget is not retained, a second
session cannot resolve the first session's id); a gate check that an upload after the retention
time is refused as no longer available.

**Acceptance Scenarios**:

1. **Given** a screenshot taken more than five minutes ago, **When** the agent uploads it, **Then**
   the answer refuses as no longer available.
2. **Given** screenshots whose stored size together exceeds the budget, **When** the newest is
   stored, **Then** the oldest ones are removed until it fits, and uploading a removed id is
   refused as no longer available.
3. **Given** one screenshot larger than the whole budget, **When** taken, **Then** the screenshot
   answer still carries the picture but says the picture is too large to be uploaded later.
4. **Given** two sessions, **When** the second quotes an id the first was given, **Then** it is
   refused as unknown.
5. **Given** the session ends (release, owner take-back of the last tab, disconnect), **When** a
   new session of the same client starts, **Then** none of the earlier ids resolve.

---

### User Story 4 - The agent knows where the image comes from (Priority: P3)

An agent that wants to "attach a picture" reads the tool list and learns that the upload tool
takes an id from an earlier screenshot of this session, that `file_upload` is for files the owner
allowed from disk, and that both are page effects a site may ask about. It takes a screenshot first
when it has none.

**Why this priority**: one sentence per tool decides whether a model tries to invent an id or a
path.

**Independent Test**: a contract check that the descriptions contain the steering sentences; the
paid probe (SC-098) asks a real model to attach a picture of the current page to the fixture's
form and records the tool sequence.

**Acceptance Scenarios**:

1. **Given** the tool list, **When** read, **Then** the upload tool's description says it uploads a
   screenshot this session took (by the id in the screenshot answer), that it targets a file input
   by reference or a drop point by coordinate, and that `file_upload` is the tool for files from
   disk; `file_upload`'s description says the converse.
2. **Given** a `claude -p` probe asked to attach a picture of the page to the form, **When** it
   acts, **Then** it takes a screenshot, then calls the upload tool with that id (1/1, model
   recorded).

---

### Edge Cases

- The tab navigated between the screenshot and the upload: the id is still valid (it is a session
  fact, not a page fact); the reference or coordinate is resolved against the current page.
- The upload targets a tab other than the one the screenshot was taken on: allowed, as long as the
  session holds the target tab; the id belongs to the session.
- The screenshot was a region capture or a scaled capture (012): the stored bytes are the picture
  the agent received, so what is uploaded is what the agent saw.
- The file input accepts only certain types or a single file: the file is placed anyway (the input
  does not filter programmatic placement); the page's own validation decides, and the answer reports
  what the input holds afterwards, as `file_upload` does today.
- The file input is hidden (the common case behind a styled button): a reference to it is still a
  valid target; the drop path exists for pages where no input can be referenced.
- A drop target highlights on drag-enter: the sequence delivers enter, over and drop; a page that
  clears its highlight on drop needs nothing more; a page that only clears on leave is not sent a
  leave after a successful drop (a real drop does not send one either).
- The page's drop handler rejects the file (wrong type, too big): the drop is still "delivered";
  the answer reports delivery, not acceptance; the agent reads the page to learn the outcome, as
  for every effect (003 FR-040's honesty rule).
- The tab is not held by the session, or the page is restricted: the usual ownership and
  "page not actionable" refusals apply, before any consent card.
- The frame under a coordinate is CSS-transformed (scaled, rotated or translated): a known limit,
  not supported. The descent into a child frame translates the point by the frame's rectangle,
  border and padding, which is exact for an untransformed frame only; under a transform the point
  hit-tests inside the child at the wrong place, and the element it finds may not be the one the
  agent aimed at. A reference target is unaffected.
- A batch step is an upload: it passes the batch's per-step gate like an upload outside a batch.
- Recording (008) is running: an upload is an effect and gets an overlay frame like `file_upload`.
- The worker is recycled during the five minutes: retention survives; the reference or coordinate
  is resolved fresh on the next call as every call does.
- The browser is closed and reopened: retention is gone; ids from before answer no longer
  available.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-167 (PR-006 — MUST)**: Every screenshot answer this product returns to the agent (the
  `screenshot` tool and the `computer` tool's screenshot action) MUST carry an image id that is
  unique within the session, and MUST say in words that the id can be quoted to the upload tool.
- **FR-168 (PR-006 — MUST)**: The product MUST retain the bytes of each such screenshot, keyed by
  session and id, for five minutes from capture, within a total of 8 MiB of stored image data per
  session; when a new screenshot would exceed the total, the oldest retained screenshots MUST be
  removed first until it fits; a single screenshot larger than the total MUST NOT be retained and
  its answer MUST say it cannot be uploaded later. Retention MUST survive worker recycling and MUST
  end when the session ends or the browser exits.
- **FR-169 (PR-009 — MUST)**: A paired agent MUST be able to upload a retained screenshot, named by
  its id, into a held tab either to a file input named by a reference or to a point named by a
  viewport coordinate; exactly one of reference or coordinate MUST be given. An optional file name
  MAY be given; a default name with the image's extension applies otherwise.
- **FR-170 (MUST)**: When the target is a file input, the input MUST afterwards hold one file with
  the given name, the image's type and the retained bytes, and the page's own change handling MUST
  have run; the answer MUST report the name and size the page reports, not the request.
- **FR-171 (MUST)**: When the target is not a file input (a drop point, or a reference to a
  non-input element), the element under the point (or the referenced element's centre) MUST
  receive a drag-and-drop sequence (enter, over, drop) carrying one file with the given name, the
  image's type and the retained bytes; the answer MUST report the file and where it was delivered.
  A point inside a same-origin child frame one level down MUST resolve to the element inside that
  frame; deeper or cross-origin frames MUST be refused as not reachable.
- **FR-172 (MUST)**: An id this session never issued, an id from another session, and an id whose
  bytes have expired or been evicted MUST each be refused before anything touches the page, with a
  reason that distinguishes "unknown" from "no longer available" and tells the agent to take a new
  screenshot.
- **FR-173 (MUST)**: A reference that names neither a file input nor an element that can receive
  a drop, a coordinate outside the viewport, and a call with both or neither of reference and
  coordinate MUST each be refused with the rule named; nothing changes on the page.
- **FR-174 (PR-005 — MUST)**: The upload is a page effect: it MUST pass the same per-site consent
  as `file_upload` (mode `ask` prompts with the existing card, `skip-checks` proceeds, revoked
  refuses), MUST respect tab ownership and restricted-page rules before consent, MUST be recorded as
  one line in the panel's activity list, and MUST get a recording overlay when a recording is
  running. No new consent kind, card, permission or panel section is added.
- **FR-175 (Constitution VI — MUST)**: The retained bytes MUST NOT leave the browser except as the
  agent's own screenshot answer already does, MUST NOT be written to disk by this product, and MUST
  NOT be readable by another session or by the panel.
- **FR-176 (MUST)**: The upload tool's description MUST say that it uploads a screenshot this
  session took, quoting the id from the screenshot answer, to a file input by reference or a drop
  point by coordinate, and that `file_upload` is for files from the owner's disk; `file_upload`'s
  description MUST point to the upload tool for screenshots. The screenshot tools' descriptions
  MUST mention the id.
- **FR-177 (MUST)**: The tool count becomes 33 and the README, the zh-TW operations guide, the
  design notes' "planned" list and the QA guide's tool list are updated; the package version is
  0.5.0.

### Key Entities

- **Retained screenshot**: session, image id, bytes, media type, byte size, captured-at; created by
  a screenshot answer, removed by expiry, eviction, session end or browser exit.
- **Upload request**: tab, image id, exactly one of reference or coordinate, optional file name;
  answer carries the delivery kind (input or drop), the file's name and size as the page reports
  them, and for a drop the point delivered to.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-093**: On the packaged gate, a screenshot uploaded by id to the upload fixture's input is
  reported by the page with the given name, a PNG type and the screenshot's exact byte size, and
  the change handling ran (2/2 fixtures: visible input, hidden input behind a button).
- **SC-094**: A drop at the fixture's drop-zone coordinate is reported by the page with the file's
  name, type and size and the enter/over/drop order (1/1); the same by reference to the zone (1/1);
  a drop into a same-origin child frame's zone (1/1).
- **SC-095**: Unknown id, foreign-session id, expired id and evicted id are each refused with the
  distinguishing reason and nothing reaches the page (4/4); the eviction and single-oversize rules
  hold in unit checks (3/3).
- **SC-096**: On an `ask` site the owner's card appears before the upload and a decline leaves the
  input empty (1/1); the panel shows one activity line per upload (1/1).
- **SC-097**: After a forced worker restart between screenshot and upload, the upload succeeds
  (1/1); after the session ends, the id no longer resolves (1/1).
- **SC-098**: The paid probe asked to attach a picture of the page to the form takes a screenshot
  and then calls the upload tool with that id (1/1, model recorded).
- **SC-099**: Unit, contract and snapshot checks stay green; the manifest's permissions are
  unchanged; every screenshot answer in the contract carries an id; tool count 33 and version 0.5.0
  appear in the README, guides and package.

## Assumptions

- Screenshot ids are opaque short strings; the agent never needs to construct one.
- The five-minute and 8 MiB bounds are product choices matching the one reference; the plan may
  keep them as constants and need not make them configurable.
- The retained bytes are the encoded image the agent received (PNG today); no re-encoding.
- The gate runs on Chromium in attach mode as for 012; the owner's branded Chrome and the paid
  probe are used for the final run, as the owner allowed on 2026-09-22.
- The drop sequence is a programmatic delivery of the standard drag events; pages that require an
  operating-system drag (native file promises) are out of reach and answer as delivered-but-not-
  accepted through the page's own state, as any effect does.

## Out of Scope

- Uploading images from disk (that is `file_upload`), images the agent composes, or images from
  another session or client.
- Uploading a recording (008 GIF) by this path; a later feature may reuse the delivery if wanted.
- Retention configurable by the owner, or longer than the browser's life.
- Any new consent card, permission or panel section.

## Traceability

| Reference feature | Destination |
| --- | --- |
| Image id on every screenshot answer (one reference) | FR-167 |
| Bounded per-session screenshot retention (one reference) | FR-168, FR-172, FR-175 |
| Upload into a file input by reference (one reference) | FR-169, FR-170 |
| Drop at a coordinate with the drag sequence (one reference) | FR-169, FR-171 |
| Image lookup in a chat history (one reference's own-panel path) | Not applicable; no chat here |
| Recording handed to a page by the same drop (one reference) | Out of scope |
| The other reference | Nothing at the extension level; REFERENCE-ONLY |

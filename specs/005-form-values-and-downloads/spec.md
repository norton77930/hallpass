# Feature Specification: Form Values in the Read, and Download Reporting

**Feature Branch**: `005-form-values-and-downloads` (logical feature identifier; this workspace has no Git metadata)

**Feature Directory**: `specs/005-form-values-and-downloads`

**Created**: 2026-09-13

**Status**: Complete 2026-09-13 — T170–T187 done; probes S7 and S8 done 1/1 on the owner's Chrome 152 (coverage.md "Runs")

**Input**: Owner direction of 2026-09-13, after the post-004 gap inventory: "依照你的建議進行" — of the
gaps that still stop a coding agent from finishing a task in the browser, close the two that have a
reference behaviour to follow: (1) the agent cannot see what a form field currently holds; (2) when a
page produces a file, the agent is not told its name or when it is complete. Do not build a clipboard
read (no reference does it in the extension), do not build plan editing (a remote-path notion), and leave
right-click's native menu, interrupt-and-resume and the cross-site confirmation prompt as they are.

**Authoritative Source Order**: Constitution → `docs/product-requirements-draft.md` (PR-004, PR-020) →
the behaviour analysis (kept in the private archive; its public summary is `docs/design-notes.md` §6),
which records the 2026-09-13 reading of both installed reference extensions for exactly these questions.

## Why this feature exists

Feature 004 closed every behaviour delta the owner's real runs exposed. The inventory taken afterwards
(2026-09-13, from the reference analysis) left eighteen cells where this project has less than a
reference; sixteen are desktop, side-panel or visual-only matters outside a browser-driving extension's
scope or deliberate design decisions. Two are not:

- **A filled form is opaque.** `read_page` and `find` describe a field by role, name, type and
  placeholder, never by what it holds. An agent asked "is this form filled in correctly?" or handed a
  half-completed form cannot answer without a screenshot. Both references put the value in the read
  (design-notes §6).
- **A produced file is silent.** When the agent clicks "Export CSV", the browser downloads the file to
  the owner's download folder — and the agent learns nothing: not the name, not whether it finished.
  Codex observes the browser's downloads and reports name and status to the agent; Claude in Chrome
  does not report at all (design-notes §6). Neither *fetches* or moves a file, and neither will we.

Both are reads of what the browser already knows. Neither needs a new consent flow: the references gate
neither, and the owner has decided the same (D-005-1, D-005-2).

## Owner decisions recorded before specification

Taken by the product owner on 2026-09-13 during the gap review, binding for this feature.

| ID | Decision | Constitution touchpoint |
| --- | --- | --- |
| D-005-1 | **Field values belong in the read and need no separate consent** on the local-agent path. The remote path's `page.form-values` grant is an archived design and is not changed. Fields the references hide stay hidden: a password or hidden input, and any field whose autocomplete names a password, a one-time code or a payment-card detail, is reported as *redacted*, never as a value. | PR-004 (read what the owner can see), V (no new permission), II (behaviour from the reference, never code) |
| D-005-2 | **The agent is told about the browser's downloads; it never starts, opens, moves or deletes one.** A download that begins while a session holds tabs is reported to that session by name, source and state. The file stays where the browser put it; the coding agent reads it from there with its own file access. The `downloads` permission is added to the local-agent build only. | V (one new permission, traced use: observe only), PR-020 |
| D-005-3 | **Out of scope, by reading the references**: clipboard access (neither extension reads it), plan editing (a remote-path notion), a native context menu on right-click (the agent could not see it), interrupt-and-resume and a cross-site confirmation prompt (behaviour, not capability). | — |

## Traceability

| Requirement | PR | Evidence |
| --- | --- | --- |
| FR-072–FR-075 (field values) | PR-004 | design-notes §6 "Form values" |
| FR-076–FR-080 (downloads) | PR-020, V | design-notes §6 "Downloads" |
| SC-039–SC-043 | — | acceptance probe reports under `tests/acceptance/probe-004/reports/` |

## Acceptance standard *(binding for every requirement below)*

Unchanged from 004 (D-004-6): every claim closes on the owner's branded Chrome 152 in attach mode,
against a named public page, with a scripted non-interactive coding-agent session as the caller, and a
timestamped report. The 004 probe harness is reused with new scenario files; no new harness. Unit and
contract tests prove the shape; the probe proves the behaviour. Nothing is handed to the owner to verify.

Named pages for this feature:

- **Form values**: `https://httpbin.org/forms/post` — text inputs, radio group, checkboxes, a `select`-free
  form with a textarea; and `https://www.wikipedia.org/` — a labelled search input the agent fills first.
- **Downloads**: `https://github.com/octocat/Hello-World/archive/refs/heads/master.zip` — a URL the
  browser always downloads rather than renders (a zip), reached by navigation; and, for a page-triggered
  download, a link with a `download` attribute on a fixture page served by the packaged gate.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what a form holds (Priority: P1)

A coding agent, holding a tab with a form, calls `read_page` (or `find`) and, for every field it can
act on, learns the field's current value the way a person looking at the screen would — the text in a
textbox, whether a checkbox is ticked, which option a select shows — except for fields a person would
expect to be hidden (a password, a card number), which are marked redacted.

**Why this priority**: it is the cheapest of the two and blocks the most common task ("check this form",
"finish filling this form"). It has a precise reference rule to follow.

**Independent test**: on `https://httpbin.org/forms/post`, type into the customer-name field, tick a
topping, pick a size, then `read_page`; the answer carries those three states and nothing for the
(absent) password field. On a fixture page with a password input and a `cc-number` autocomplete field,
`read_page` reports both as redacted with no value.

**Acceptance scenarios**:

1. **Given** a text input holding "Ada", **When** `read_page` runs, **Then** its node carries
   `value: "Ada"`.
2. **Given** a checkbox that is ticked and one that is not, **Then** their nodes carry `checked: true`
   and `checked: false`; neither carries `value`.
3. **Given** a radio group with one option chosen, **Then** the chosen node carries `checked: true`.
4. **Given** a select showing "Large", **Then** its node carries `value: "Large"` (the option's visible
   text) beside its existing `options`.
5. **Given** a textarea holding two lines, **Then** its node carries the text with the line break kept.
6. **Given** a password input holding anything, **Then** its node carries `redacted: true` and no
   `value`; an empty password input carries neither.
7. **Given** a field whose value exceeds the label bound, **Then** `value` is cut at the bound and the
   node says so (`valueTruncated: true`).
8. **Given** `find` matched the field, **Then** its answer carries the same fields as `read_page`.

### User Story 2 - Learn about a file the page produced (Priority: P1)

A coding agent clicks a control (or navigates to a URL) that makes the browser download a file. It can
then wait until that download is complete and learn the path the browser saved it to, and it can list
the downloads its session has caused so far. It never has to guess a file name, and it is never told
about downloads another session or the owner caused.

**Why this priority**: it is the only inventory item the agent cannot work around at all today.

**Independent test**: navigate a held tab to the named zip URL, `wait` for `download-complete`, and
receive the saved path and final URL; `downloads_context` lists that one item as complete; a second
session started afterwards lists nothing.

**Acceptance scenarios**:

1. **Given** a held tab and a navigation to a URL the browser downloads, **When** the agent waits with
   `condition: "download-complete"`, **Then** the wait ends when the browser marks the item complete
   and reports `{filename, url, state: "complete"}` where `filename` is the browser's saved path.
2. **Given** the download fails or the owner cancels it, **Then** the wait ends with the item's state
   (`failed` / `canceled`) rather than running to the bound.
3. **Given** no download starts within the bound, **Then** the wait fails with `bound-reached`, as
   every other condition does.
4. **Given** two downloads caused by the session, **Then** `downloads_context` lists both, newest
   first, each with id, filename, url, state, start time and bytes.
5. **Given** a download that began before the session started, or while the session held no tab,
   **Then** neither the wait nor the listing ever reports it.
6. **Given** the browser flags an item as dangerous, **Then** the listing shows `danger: true` and the
   extension takes no action on it (no accept, no open, no remove).
7. **Given** the session ends, **Then** its download list is discarded with the session.

### Edge Cases

- A download whose filename the browser has not yet decided (`onCreated` before the name is known)
  is listed with an empty filename until `onChanged` supplies it; a wait only completes on `complete`.
- The browser's download item carries no tab id. Attribution is by session liveness and time (an item
  created while the session holds at least one tab), the same rule the reference uses ("browser control
  active"). When two sessions hold tabs at once, an item is reported to **every** such session, marked
  `attribution: "shared"`; the agents are told this rather than one of them being silently left out.
- A `contenteditable` region is not a form field; no value is emitted for it (unchanged).
- A `select[multiple]` reports every selected option's text, joined by the same separator `options`
  already implies (one string per option is not added; the node's `value` is a single string).
- Redaction is decided by the field, not the page: a password field on a page in `skip-checks` mode is
  still redacted.

## Requirements *(mandatory)*

### Functional Requirements

**Field values in the read (US1)**

- **FR-072 (PR-004 — MUST)**: On the local-agent path, every `read_page` and `find` node that is a text
  entry (`input` of a text-like type, `textarea`), a choice (`select`), or a toggle (`checkbox`, `radio`)
  MUST carry the control's current state: `value` (string) for text entries and selects, `checked`
  (boolean) for toggles. The value is what the owner sees — an input's live value, a select's selected
  option text, a textarea's text with line breaks kept.
- **FR-073 (PR-004 — MUST)**: A field MUST be reported as `redacted: true` with no `value` when it is a
  password or hidden input, or when its autocomplete names a current or new password, a one-time code, or
  a payment-card number, security code or expiry (in any of the browser's spellings). An empty such field
  carries neither `value` nor `redacted`.
- **FR-074 (PR-004 — MUST)**: `value` is bounded by the existing label bound; a longer value is cut
  there and the node carries `valueTruncated: true`. Line breaks inside a textarea's value are kept
  as-is (they are not whitespace-collapsed like names).
- **FR-075 (MUST)**: The archived remote path (`page.read`, `page.form-values` and its grant) is
  unchanged: its answer shape, its consent, and the narrow build's manifest. (The shared content
  script's bundle does change - it carries the field-state code - but the branch that runs it is the
  agent-only policy; the remote path never evaluates it.)

**Download reporting (US2)**

- **FR-076 (PR-020 — MUST)**: The local-agent build MUST observe the browser's downloads and MUST NOT
  start, open, show, accept-danger, pause, resume, cancel, remove or erase any of them.
- **FR-077 (PR-020 — MUST)**: A download MUST be attributed to a session when it is created while that
  session holds at least one tab. It is attributed to every such session; when more than one, each
  answer carries `attribution: "shared"`, otherwise `"session"`. A download created while no session
  holds a tab is attributed to none and never reported.
- **FR-078 (PR-020 — MUST)**: `wait` MUST accept `condition: "download-complete"` (no `ref`). It ends
  when the newest attributed download reaches a terminal state and answers `{outcome:"condition-met",
  waitedMs, download:{id, filename, url, state}}` with state `complete | failed | canceled`; it fails with
  `bound-reached` like every other condition. A download already terminal before the wait began does
  not satisfy it unless it began after the session's previous `download-complete` wait was answered — the
  wait is about *the next* completion. A `navigate` whose URL the browser turns into a download
  MUST answer `ok` with the tab's unchanged URL and `download {id, url, filename, state}` instead of
  waiting for a commit that never comes.
- **FR-079 (PR-020 — MUST)**: A new read tool `downloads_context` MUST list the session's attributed
  downloads, newest first, at most 20, each `{id, filename, url, state, startedAt, bytesReceived,
  totalBytes, danger, attribution}`. `filename` is the browser's saved path exactly as the browser reports
  it (it is the point of the tool). It needs no held tab.
- **FR-080 (MUST)**: A session's download records are held in the worker's session storage with the
  session and discarded when the session ends (FR-058). They contain nothing from any page: only what
  the browser's download record carries.

### Key Entities

- **FieldState**: `{value?, checked?, redacted?, valueTruncated?}` on a read node; exactly one of
  `value` / `redacted` when the field holds anything.
- **DownloadRecord**: `{id, filename, url, state, startedAt, bytesReceived, totalBytes, danger,
  attribution}`; per session, newest first, bound 20.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-039**: On `https://httpbin.org/forms/post`, after `type` into the customer name field, `click` on
  one topping and one size, a `read_page` answer carries the typed text as that field's `value`, the two
  clicked toggles as `checked: true`, and every other toggle as `checked: false`. Probe scenario, one run.
- **SC-040**: On the packaged gate's form fixture, a filled password field and a filled `cc-number`
  field are both `redacted: true` with no `value`, while a filled `email` field carries its value.
- **SC-041**: `narrow-manifest-guard` and the archived remote-path tests stay byte-identical/green.
- **SC-042**: On branded Chrome, navigating a held tab to the named zip URL then waiting for
  `download-complete` answers within the bound with a `filename` that exists on disk (checked by the probe
  from the caller's side) and `state: "complete"`; `downloads_context` lists it once.
- **SC-043**: With two live sessions, a download caused by session A while B also holds a tab is listed by
  both with `attribution: "shared"`; a download started after A ended is not listed by A's successor.

## Assumptions

- The browser's download record has no tab id (confirmed in the platform API); attribution by session
  liveness is therefore the strongest honest rule, and the reference uses the same one.
- Adding `downloads` to the agent build changes only that build's manifest; the narrow build's manifest
  guard is the proof.
- The 004 probe harness accepts new scenario files without change; if a scenario needs a caller-side
  file-existence check, that is a small harness extension recorded in tasks.

## Out of scope

- Clipboard read or write (D-005-3). Plan editing. Native context menu. Interrupt-and-resume.
  Cross-site confirmation prompt.
- Starting a download from the agent (`download_media`-style), moving or deleting downloaded files.
- Values of `contenteditable` regions; closed shadow roots.
- Any change to the remote path's consent model.

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-09-13 | Probe S8 measured two defects on the owner's Chrome: `navigate` to a URL the browser downloads ran to `navigation-timeout` (US2 says navigating to such a URL is a supported way to cause a download), and the scenario asked the sandboxed caller to check the disk. Amendment: FR-078 gains the sentence "A `navigate` whose URL the browser turns into a download answers `ok` with the tab's unchanged URL and `download {id, url, filename, state}` instead of waiting for a commit that never comes"; SC-042's on-disk check is the harness's, not the caller's | Probe run 2026-09-13T12:17:30Z |
| 2026-09-13 | Review (R1) follow-up recorded, not built: `download-complete` inspects the newest-by-creation record only, so when a page starts A then B and B finishes first, A's later completion is never answered (FR-078 says "newest", so this is by the letter; multi-file exports would want "any un-answered completion"). FR-075 wording corrected from "narrow build's bytes" to "narrow build's manifest" | R1 review, 2026-09-13 |
| 2026-09-13 | Initial specification; owner decisions D-005-1–3; design-notes §6 | Post-004 gap inventory and reference reading, 2026-09-13 |

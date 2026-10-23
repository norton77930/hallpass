# Feature Specification: Attachments in the Side-Panel Conversation

**Feature Branch**: `022-composer-attachments` (git: `feature-022-composer-attachments`, from `main` at 0.14.0)

**Feature Directory**: `specs/022-composer-attachments`

**Created**: 2026-10-21

**Status**: Draft written under the owner's delegation of 2026-10-21 ("我先去睡覺了 請完成任務"). The
owner chose option B on 2026-10-20 (images as in other agent side panels, other files copied into the
conversation folder, the current tab as text or PDF). Every finer decision below (D-022-1..9) was **decided
by Claude under delegation; the owner confirms or changes it** in the morning review.

**Input**: Owner, 2026-10-20, order after 0.14.0: "spec 022 composer attachments, option B" — images
(+, paste, drop, tab screenshot, downscale); other files copied into the conversation folder and named to
the agent, about 25 MB; attach the current tab as page text or PDF. Release together with 021 as 0.15.0.

**Decisions (D-022-n, decided by Claude under delegation, confirmed by the owner 2026-10-21)**:

- **D-022-1 — images**: images are attached with a "+" button in the composer (a file picker), by pasting
  and by dropping onto the composer. PNG, JPEG, GIF and WebP; at most 5 images per message. The panel
  scales each image down so its long edge is at most 2000 px and re-encodes it until it fits one message
  to the helper (about 700 000 base64 characters); a GIF is sent as its first frame. The image goes to
  the agent as an image in the prompt (both pinned agents accept images).
- **D-022-2 — screenshot of this tab**: the "+" menu offers "Screenshot of this tab": the visible part of
  the tab the user is looking at, attached as an image. It is the user's own action, so no site consent
  card is asked. Pages Hallpass may never read (browser pages, the Web Store, other extensions) say they
  cannot be captured.
- **D-022-3 — attach this tab**: "Attach this tab" adds the page's address, title and visible text (at
  most 50 000 characters; longer text is cut and the chip says so) as context in the prompt. A PDF tab
  is fetched and saved as a file (D-022-4) instead. Restricted pages say they cannot be attached. No site
  consent card (the user's own action).
- **D-022-4 — other files**: any other file picked or dropped is copied into the conversation's folder,
  in a `hallpass-attachments` subfolder made on demand, never over an existing file (an existing name
  gets " (2)", " (3)", …). The agent is told the file's name and its path. At most 25 MB per file, 25 MB
  in total per message, 5 files per message. The copy is written only inside the conversation folder (no
  name from the panel can lead outside it) and is removed again when the transfer fails or the message is
  given up before it is sent.
- **D-022-5 — composer**: attachments show as chips above the text inside the composer card (thumbnail or
  file icon, name, size, a remove button). They stay with their conversation like the draft (020 T610).
  A message may be attachments only. While the first-use card holds a message (D-019-5) its attachments
  are held with it and sent after the user agrees. The sent message shows its attachments in the user's
  bubble (thumbnails for images, name chips for files and for the tab).
- **D-022-6 — what the agent accepts**: the helper reads what the agent says it accepts. When an agent does
  not accept images or page context, the matching "+" entries are disabled with the reason; files still
  work because the agent is only told their path.
- **D-022-7 — history**: Hallpass still keeps no conversation content (D-019-6). Opening an old
  conversation shows what the agent replays; an image it replays is shown as an image chip without a
  thumbnail (the helper cannot shrink pictures), what it does not replay is not.
  Copied files stay in the folder: they belong to the user's folder, and removing a conversation from the
  list does not delete them.
- **D-022-8 — limits and errors**: every refusal says what happened and what to do, in the panel's language
  (too big, too many, type not supported, page cannot be read, folder gone, agent does not accept images).
  Nothing is sent until every attachment is ready. The limits are shown as a hint in the "+" menu.
- **D-022-9 — scope**: no audio, nothing for external (MCP) agents, no drag-out, no image editing, no text
  recognition, nothing stored outside the conversation folder, no new runtime dependency. English and
  zh-TW. Keyboard and screen-reader access at the 006/020 bar.

## Why this feature exists

The panel conversation (019, 0.14.0) takes only typed text. Showing an agent what is on the screen, a
design, an error dialog, a log file or the page being read means describing it in words or saving it
somewhere the agent can find it. Other agent side panels accept images and the current page directly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Show the agent a picture (Priority: P1)

The owner pastes a screenshot of an error into the composer, types "why does this fail?" and sends. The
agent answers about what the picture shows.

**Why this priority**: the most common attachment; it is what "attachments" means to most users.

**Independent Test**: paste a PNG, send with a question to Claude Code: the prompt the agent receives holds
one image and the text; the bubble shows the thumbnail.

**Acceptance Scenarios**:

1. **Given** an empty composer, **When** an image is pasted, **Then** a chip with its thumbnail, name and
   size appears above the text and Send is enabled.
2. **Given** a 6000 × 4000 photo, **When** it is attached, **Then** it is sent with a long edge of at most
   2000 px and within the one-message size.
3. **Given** five images attached, **When** a sixth is dropped, **Then** it is refused with "At most 5
   images per message" and the five stay.
4. **Given** an image chip, **When** its remove button is pressed, **Then** the chip goes and focus moves to
   the text field.
5. **Given** a message with an image and no text, **When** Send is pressed, **Then** it is sent.

### User Story 2 - Screenshot of the page I am looking at (Priority: P1)

The owner opens "+", picks "Screenshot of this tab" and asks "what is wrong with this layout?".

**Why this priority**: the side panel sits beside the page; showing the page is the natural question.

**Independent Test**: on a test page, "+" → "Screenshot of this tab": an image chip appears without any
site consent card; on `chrome://extensions` the entry says the page cannot be captured.

**Acceptance Scenarios**:

1. **Given** an ordinary page, **When** "Screenshot of this tab" is chosen, **Then** an image chip of the
   visible part appears within 2 seconds and no consent card is shown.
2. **Given** a browser page, **When** it is chosen, **Then** nothing is attached and the composer says the
   page cannot be captured.

### User Story 3 - Give the agent the page (Priority: P2)

The owner reads a long article, picks "Attach this tab" and asks for a summary in five points.

**Why this priority**: summarising and questioning the open page is a core side-panel use; the agent could
already read the page with browser tools, but only after site consent and more steps.

**Independent Test**: on a text fixture page, "Attach this tab": a chip shows the title; the prompt holds the
address, title and text as context; a page over 50 000 characters is cut and the chip says "cut".

**Acceptance Scenarios**:

1. **Given** an article, **When** "Attach this tab" is chosen, **Then** a tab chip with the page title
   appears, and the prompt holds the address, title and visible text.
2. **Given** a PDF open in a tab, **When** it is chosen, **Then** the PDF is copied into the conversation
   folder (Story 4) and the agent is told its path.
3. **Given** an agent that does not accept page context, **When** "+" is opened, **Then** "Attach this tab"
   is disabled with the reason, and a PDF tab still works (it is a file).

### User Story 4 - Hand over a file (Priority: P2)

The owner drops a 3 MB CSV and asks the agent to chart it. The file appears in the conversation folder
under `hallpass-attachments`, and the agent works with it there.

**Why this priority**: agents work on files; putting the file where the agent works is the simplest way.

**Independent Test**: drop a CSV twice in two messages: the folder holds `data.csv` and `data (2).csv`; each
prompt names its file's path; a 30 MB file is refused before anything is written.

**Acceptance Scenarios**:

1. **Given** a project folder conversation, **When** a CSV is dropped and sent, **Then** the CSV is in
   `<folder>\hallpass-attachments\` and the prompt names it with that path.
2. **Given** a file of the same name already there, **When** another is sent, **Then** the new copy gets
   " (2)" and the old one is unchanged.
3. **Given** a 30 MB file, **When** it is dropped, **Then** it is refused with the limit and nothing is
   written.
4. **Given** a file chip, **When** it is removed before sending, **Then** nothing of it is left in the folder.
5. **Given** a transfer that fails half way, **Then** no partial file stays and the composer says so.

### User Story 5 - Attachments survive the first-use card and conversation switches (Priority: P2)

The owner attaches a picture for an agent not yet downloaded. The first-use card holds the message with its
picture; after "Allow", both are sent. Switching to another conversation and back keeps unsent chips.

**Why this priority**: losing an attachment silently is worse than not having the feature.

**Acceptance Scenarios**:

1. **Given** a held first-use message with an image, **When** the user agrees, **Then** text and image are
   sent together; **When** the user declines, **Then** both return to the composer.
2. **Given** chips in conversation A, **When** the user opens B and returns, **Then** A's chips are there and
   B never showed them.

### User Story 6 - Nothing else changes (Priority: P1)

Typing and sending text, permission cards, first use, stop, mode and folder chips and the external-agent
consent flow behave exactly as in 0.14.0.

### Edge Cases

- The conversation folder was deleted after the conversation started: a file attachment is refused with
  "folder gone"; images and tab text still work.
- The scratch folder is used: files go to the scratch folder's `hallpass-attachments`.
- A file whose name has characters Windows refuses, or a name like `..\x`: the saved name keeps only the
  final name part with refused characters replaced; it is always inside `hallpass-attachments`.
- An image that cannot be decoded (a renamed file): refused as "not an image".
- A paste with text and an image: the text goes into the field, the image becomes a chip.
- The panel is closed while a file transfer runs: the transfer is given up, the partial file removed, and
  the chip is gone when the panel reopens (the draft text stays as in 020).
- The agent crashes after the files were written: the files stay (they are in the user's folder); the
  message can be sent again.
- Two images with the same name: two chips; image names are not files and need no " (2)".
- The tab is a page Hallpass's site list blocks for agents: the user's own attachment is still allowed
  (it is the user acting), restricted browser pages are not.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-325**: The composer MUST offer a "+" button that opens a menu with: "Add images or files…",
  "Screenshot of this tab", "Attach this tab", and a hint line with the limits (D-022-1, D-022-4, D-022-8).
- **FR-326**: Pasting an image and dropping images or files onto the composer MUST attach them as with the
  picker; pasted text MUST still go into the text field.
- **FR-327**: An image (PNG, JPEG, GIF, WebP) MUST be scaled so its long edge is at most 2000 px and
  re-encoded until its encoded form fits one message to the helper; a GIF MUST be sent as its first frame;
  an image that cannot be decoded MUST be refused.
- **FR-328**: A message MUST carry at most 5 images and at most 5 files; a file MUST be at most 25 MB and all
  files of one message together at most 25 MB; anything over a limit MUST be refused when it is added, with
  the limit in the message.
- **FR-329**: "Screenshot of this tab" MUST capture the visible part of the tab the user is viewing and attach
  it as an image, without a site consent card; restricted pages MUST be refused with a reason.
- **FR-330**: "Attach this tab" MUST attach the page's address, title and visible text (at most 50 000
  characters, the chip saying when text was cut) and send them to the agent as page context; a PDF tab MUST
  be attached as a file (FR-331) instead; restricted pages MUST be refused with a reason.
- **FR-331**: A file attachment MUST be copied into `<conversation folder>\hallpass-attachments\`, created on
  demand, under the file's own final name part with characters Windows refuses replaced, never replacing an
  existing file (" (2)", " (3)", … before the extension), and MUST never be written outside that subfolder.
- **FR-332**: A file copy MUST arrive in pieces small enough for one message each and MUST become visible
  under its final name only when complete; a failed or given-up transfer MUST leave no file behind.
- **FR-333**: The prompt to the agent MUST hold, in order: the text (if any), each image as an image, the
  page context as context, and one line per file naming the file and its full path.
- **FR-334**: The helper MUST read which content kinds the agent accepts when it starts; the panel MUST disable
  "Screenshot of this tab" and image adding when images are not accepted and "Attach this tab" when page
  context is not accepted (a PDF tab still allowed), each with its reason.
- **FR-335**: Attachment chips MUST show a thumbnail or icon, the name, the size and a remove button named for
  the attachment; they MUST stay with their conversation like the draft.
- **FR-336**: Send MUST be enabled when there is text or at least one ready attachment, and MUST wait while an
  attachment is still being prepared; nothing is sent until all attachments are ready.
- **FR-337**: A message held by the first-use card MUST hold its attachments too; agreeing sends them, declining
  returns them to the composer with the text.
- **FR-338**: The sent message MUST show its attachments in the user's bubble: image thumbnails, name chips for
  files and the tab; a replayed old conversation MUST show each image the agent replays as an image chip.
- **FR-339**: Every refusal MUST be shown in the panel's language with what to do (too big, too many, type,
  restricted page, folder gone, not accepted by the agent, transfer failed).
- **FR-340**: Removing a conversation from the list MUST NOT delete files copied into its folder.
- **FR-341**: The "+" menu, its entries, the chips and their remove buttons MUST be reachable and operable by
  keyboard and named for screen readers, in English and zh-TW.
- **FR-342**: Text-only sending, permission cards, first use, stop, mode and folder choice and the external
  agent flows MUST behave as in 0.14.0.

### Key Entities

- **Attachment (in the composer)**: kind (image, file, tab), display name, size, state (preparing, ready,
  refused), thumbnail for images; belongs to one conversation's draft.
- **Image attachment**: encoded picture and its type, within one message's size.
- **File attachment**: the transfer of the file's bytes, its final name and path in the conversation folder.
- **Tab attachment**: address, title, visible text (or the PDF as a file attachment), and whether text was cut.

## Success Criteria *(mandatory)*

- **SC-148**: A pasted 4K screenshot is attached and ready within 2 seconds and reaches the agent as an image
  with a long edge of at most 2000 px.
- **SC-149**: "Screenshot of this tab" never shows a site consent card and refuses every restricted page.
- **SC-150**: A 25 MB file arrives byte-identical in `hallpass-attachments` within 30 seconds on the owner's
  machine; a refused or failed transfer leaves zero bytes behind.
- **SC-151**: No file name or input from the panel can make the helper write outside the conversation's
  `hallpass-attachments` folder (checked with crafted names such as `..\..\x`, `C:\x`, `con`, names with `:`).
- **SC-152**: 100 % of refusals are shown in the panel's language, in both English and zh-TW.
- **SC-153**: Every existing panel test and the packaged conversation gate pass unchanged.
- **SC-154**: Screenshots of each attachment state, light and dark, English and zh-TW, are reviewed one by one
  before the owner is asked to approve.

## Assumptions

- Both pinned agents accept images and page context (claude-agent-acp 0.81.2 and codex-acp 1.13.1 say so when
  they start); Claude Code ignores binary page content, so a PDF is always handed over as a file.
- The owner's agents can read files inside their conversation folder, so a file named by path is enough.
- One message to the helper stays at most 1 MiB; files therefore travel in pieces.
- 25 MB matches the size other agent panels accept for an image and is enough for logs, CSVs and PDFs.
- The visible-text reading used by the browser tools is good enough for "Attach this tab".

## Out of Scope

Audio; attachments for external (MCP) agents; dragging attachments out; editing or annotating images; text
recognition; storing attachments anywhere but the conversation folder; folders as attachments; attachments
from the agent to the user; a new runtime dependency.

## Change log

- **2026-10-24 — D-022-6 / FR-356 amended by 023** (D-023-3, FR-365): an agent that does not accept page
  context no longer gets a greyed "Attach this tab"; the tab goes as a `.txt` file in the conversation
  folder, named by path. Agents that accept page context are unchanged.
# Feature Specification: A Session Card That Reads at a Glance

**Feature Branch**: `spec-036-session-card` (from `main` d747ed4, 0.23.0)

**Feature Directory**: `specs/036-session-card-layout`

**Created**: 2026-11-17

**Status**: Approved by the owner on 2026-11-17 (design answers D-036-1 to D-036-6, chosen on a
throwaway prototype; the owner asked for the spec-kit flow to be run to completion).

**Input**: The owner's screenshot of the side panel's 工作階段 tab on 2026-11-17 and the words "我們來討論
UI介面的呈現優化". One session card filled the whole panel: two run-on permission lines, twelve activity
lines with no times, Stop/Resume written twice per line, the site plan said three times, and five other
sessions below it. The prototype (branch `prototype/session-card-ui`, `?variant=`) showed seven
versions; the owner chose layout **D** and visual language **E**. Observable behaviour of other products
was looked at, not copied (clean room, `docs/design-notes.md`); every phrase, colour and size below is
Hallpass's own.

**Facts checked 2026-11-17** (this repository at d747ed4):

- The 工作階段 tab shows one card per live session, newest activity first, every card fully open
  (006 FR-087, 016 FR-225 – FR-234).
- A card shows, top to bottom: a title (folder, else agent), "agent · started", a state pill, what it
  holds, "Stopped from the page" while held (034), a "Manage this site's permissions" link for the one site
  it acts on (024 FR-393), one line per session grant as "site · kind · this session · source" (031
  FR-475), a recording line (008 FR-109), up to 20 activity lines newest first with no time (008 FR-113,
  032 FR-494), the site plan as a folded list with a "Withdraw site plan" button (017 FR-259), then End
  session (always first, 016 FR-232), Interrupt (working), Resume (held), Take back tabs (holding) and
  folded technical details.
- Origins are shown with their scheme (`https://…`); a Stop and its Resume are two lines each, and a
  zh-TW line says the owner in the third person (「主人…」) and then again in the second (「你已…」).
- The consent card for a waiting session is drawn above the tabs, outside the session card.

**Decisions (D-036-n)** (owner, 2026-11-17):

- **D-036-1 - all six fixes**: sectioned card; permissions grouped by site; activity folded to the
  newest three with times; idle sessions folded to one line; one voice (second person) and one way to
  say where something was answered; the action row reordered.
- **D-036-2 - layout D**: each card has a header (always shown) and a body (shown when open). The body
  has two titled sections, "Sites and permissions" and "Recent activity", then a footer with Take back
  tabs and End session, then one quiet line with the start time and technical details.
- **D-036-3 - one list per site**: every site the session holds a tab on, holds a grant for, or has in
  its site plan appears once, with marks for "tab here" and "in site plan", its grants, and its own
  manage link. Withdrawing the site plan moves to the section's title.
- **D-036-4 - one primary action in the header**: the header carries the one action that matters now:
  Answer while the session waits for the owner, Resume while it is stopped from the page, Interrupt while
  it is working. It is there even when the card is folded.
- **D-036-5 - folding**: cards that need the owner (waiting, working, stopped from the page) are open;
  idle cards are folded to one line and gathered under an "Idle" heading below the others. The owner's
  own open/fold choice wins until the session next starts to need them.
- **D-036-6 - visual language E**: no boxes inside boxes; hairline separators; colour only for the
  primary action and the state; grants and answers as text with small line icons, not pills; a wider type
  ladder; the session colour as a narrow bar beside the title. The current colour tokens stay. The warm
  palette (prototype F) is **not** part of 036: it changes every surface of the panel and becomes its own
  spec.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner sees which session needs them (Priority: P1)

Six sessions are live. One waits for an answer, one is working, one was stopped from the page, three are
idle. The owner opens the 工作階段 tab and sees the three that need them as open cards at the top, each
with its one action in the header, and the three idle ones as single lines under "Idle".

**Why this priority**: The owner's complaint was that one card filled the panel; this is what makes six
sessions fit and the urgent one obvious.

**Independent Test**: With fixture state of six sessions (the prototype's), open the tab and confirm the
order, which cards are open, the header actions, and that the idle group fits in under 200 px.

**Acceptance Scenarios**:

1. **Given** sessions in the states waiting, working, stopped from the page and idle, **When** the tab is
   shown, **Then** every waiting, working or stopped card is open and listed first (newest activity first
   among them), and every idle card is folded under an "Idle" heading with the count, newest first.
2. **Given** a waiting session, **When** the owner presses Answer in its header, **Then** the consent
   card comes into view and takes keyboard focus; nothing is answered.
3. **Given** a session stopped from the page, **When** the owner presses Resume in its header, **Then**
   the session resumes exactly as the existing Resume does (034).
4. **Given** a working session, **When** the owner presses Interrupt in its header, **Then** it behaves
   exactly as "Interrupt this step" does today, including the "nothing was running" line (014 FR-178).
5. **Given** only one session is live, **When** the tab is shown, **Then** its card is open whatever its
   state.

---

### User Story 2 - The owner reads what a session may do, per site (Priority: P1)

The owner opens integration-v1 and reads, under "Sites and permissions", market-weekly-71p.pages.dev
(tab here, ✓ page actions in Chrome, ✓ diagnostics in the terminal), dash.cloudflare.com (in site plan)
and polished-tooth-cac5.cloudflareaccess.com (in site plan), each with its manage link, and "Withdraw site
plan" on the section title.

**Why this priority**: The permission lines were the hardest part of the old card to read, and they are
what the owner must trust.

**Independent Test**: With the integration-v1 fixture, confirm each site appears once, without a scheme,
with exactly its marks and grants, and that each manage link opens the settings page at that site.

**Acceptance Scenarios**:

1. **Given** a session with grants on one site, a held tab on that site and a two-site plan, **When** its
   card is open, **Then** "Sites and permissions" lists three sites once each: the held site first, then
   sites with grants, then the rest of the plan.
2. **Given** a site with two grants answered in different places, **When** it is listed, **Then** it shows
   both grants as text ("✓ page actions", "✓ diagnostics"), each with an icon and the name of where it was
   given (Chrome or the terminal).
3. **Given** a session with a site plan, **When** the owner presses "Withdraw site plan" on the section
   title, **Then** the plan is withdrawn exactly as today (017 FR-259) and the "in site plan" marks go.
4. **Given** any listed site with a known origin, **When** the owner presses its manage icon, **Then**
   the settings page opens at that site (024 FR-393).
5. **Given** a session with no grants and no plan, **When** its card is open, **Then** the section is
   absent.

---

### User Story 3 - The owner reads recent activity in a few lines (Priority: P2)

The owner opens a card and sees the newest three things that happened, each with its time, a sentence in
the second person and its result, and "Show all N" under them.

**Why this priority**: Activity is the record the owner checks afterwards, not the thing they act on.

**Independent Test**: With the integration-v1 fixture (12 items), confirm 3 rows with times are shown,
"Show all 8" expands to 8 rows, the two Stop/Resume pairs read as one row, and the site-plan approval is
one row.

**Acceptance Scenarios**:

1. **Given** a session with more than three activity rows, **When** its card opens, **Then** the newest
   three rows show, each with its local time as HH:mm, followed by "Show all N".
2. **Given** a Stop on the page directly followed by Resume, **When** the rows are made, **Then** they
   read as one row ("You stopped it from the page, then resumed"), and k such pairs in a row read as one
   row with the count.
3. **Given** a site-plan approval and its consent answer at the same moment, **When** the rows are made,
   **Then** they read as one row.
4. **Given** any other activity kind (dialog, export, restore, viewport, upload, interrupt, consent),
   **When** it is shown, **Then** it reads with the same sentence the panel uses today, without the
   scheme of any site, with its result as coloured text and, for a consent answer, where it was answered.
5. **Given** the expanded list, **When** the owner presses "Show less", **Then** it folds back to three.

---

### User Story 4 - The card looks calm and finished (Priority: P2)

The owner looks at the tab in light and dark, in zh-TW and en-US, and sees the prototype E look: thin
lines instead of grey boxes, colour only on the primary action and the state, small icons, a clear title.

**Why this priority**: The owner chose E because D "looked ordinary"; the structure alone does not answer
that.

**Independent Test**: Capture the six-session fixture in light zh-TW and compare it with the prototype E
capture; capture light en-US, dark zh-TW and dark en-US and check them against FR-551 – FR-554.

**Acceptance Scenarios**:

1. **Given** the six-session fixture in light zh-TW, **When** it is captured at the panel's width,
   **Then** it matches the prototype E capture in structure, order, text, marks and colour use (a judged
   list of differences, not pixel equality).
2. **Given** dark mode, **When** the same fixture is captured, **Then** every text keeps 4.5:1 against
   its ground (006 FR-092) and no surface uses a colour outside the panel's tokens.
3. **Given** en-US, **When** the fixture is captured, **Then** no row overflows the panel width; long
   site names end with an ellipsis and keep the full name for a hover.

---

### Edge Cases

- **A session that starts to need the owner**: an idle card the owner left folded opens and moves up when
  the session becomes waiting, working or stopped; a card the owner folded while it needed them stays
  folded until its state next changes into needing them.
- **A session that stops needing the owner**: an open card stays open (the owner may be reading it) and
  moves to the idle group; it folds only when the panel is next shown.
- **Waiting with no consent card on screen** (a stale picture): Answer brings the top of the panel into
  view and changes nothing.
- **Held tab on a site with no known origin**: the site is listed by host name without a manage icon.
- **A site name too long for the line**: it ends with an ellipsis; the full name is in the hover text.
- **Recording**: the recording line (008 FR-109) shows in the body above "Sites and permissions".
- **Notices** (008 FR-114) and the consent card keep their places outside the card.
- **More than 20 activity items**: the worker still sends at most 20 (008); the count after "Show all"
  is the number of rows after merging.
- **A newer worker's unknown activity kind**: it reads as today's "something happened" sentence.
- **Keyboard**: the header's open/fold control and the primary action are separate focus stops; the
  open/fold control says whether the card is open.

## Requirements *(mandatory)*

### Functional Requirements

**Order and folding**

- **FR-538 - two groups**: the tab lists first every session that is waiting, working or stopped from the
  page, then an "Idle" heading with the count and every idle session; each group is newest activity first.
- **FR-539 - open by default**: a card is open when its session is waiting, working or stopped from the
  page, or when it is the only session; otherwise it is folded.
- **FR-540 - the owner's choice**: pressing a card's header opens or folds it, and that choice holds until
  the session next enters waiting, working or stopped from the page, which opens it. The choice lives as
  long as the panel document and is not stored.

**Header**

- **FR-541 - header content**: the header shows a narrow bar in the session's colour (016 FR-225), the
  title (016 FR-226 – FR-227), and one line: the state, the agent, and the number of tabs it holds when
  it holds any. The state reads "Waiting for you", "Working", "Stopped from the page", or "Idle · {ago}";
  waiting and stopped are in the warning colour, working in the accent colour with a slowly pulsing dot.
- **FR-542 - primary action**: the header shows at most one action: Answer while waiting, Resume while
  stopped from the page, Interrupt while working (not stopped). Answer brings the consent card into view
  and moves focus to it; Resume and Interrupt do what 034 and 014 FR-178 define. Answer and Resume are
  filled in the accent colour; Interrupt is a plain button.
- **FR-543 - header on a folded card**: a folded card shows only the header, including its primary action.

**Body**

- **FR-544 - body order**: recording line (when any), "Sites and permissions" (when any), "Recent activity"
  (when any), footer, then one quiet line "{start time} · Technical details" that unfolds the session id
  (016 FR-231).
- **FR-545 - one row per site**: "Sites and permissions" lists each site once: sites the session holds
  tabs on, then sites with session grants, then the remaining sites of its site plan. A site is shown by
  host (with port when not default) and never with a scheme; internationalised hosts follow the existing
  display rule (Unicode then ASCII).
- **FR-546 - site marks and grants**: a site row shows "Tab here" when the session holds a tab there and
  "In site plan" when it is in the plan, each with a small icon; then each session grant as "✓ {kind}"
  with an icon and the name of where it was given ("Chrome" or "Terminal"). A site with neither grant nor
  plan shows no further words.
- **FR-547 - manage per site**: each site row with a known origin has a manage icon button whose
  accessible name is "Manage permissions for {site} (opens settings)"; it opens the settings page at that
  site (024 FR-393).
- **FR-548 - withdraw on the title**: with a site plan, "Withdraw site plan" sits on the section's title
  line in the danger colour and does what 017 FR-259 defines. The separate site-plan block is removed.
- **FR-549 - activity rows**: "Recent activity" shows rows newest first, each with local time HH:mm, the
  sentence, and on a second line the result as coloured text (allowed: success colour; refused: danger;
  timed out or stopped: warning; others: muted) and, for consent answers, where it was answered with its
  icon. Sites in sentences carry no scheme.
- **FR-550 - merging and folding rows**: a Stop on the page directly followed by its Resume is one row
  ("You stopped it from the page, then resumed"); k ≥ 2 such pairs in a row are one row ("You stopped and
  resumed it from the page {k} times"); a site-plan event and the consent answer for that plan at the same
  moment are one row. The newest three rows show, then "Show all {n}" / "Show less".
- **FR-551 - footer**: the footer has Take back tabs ({n}) on the left while the session holds tabs
  (016 FR-234) and End session on the right as a text button in the danger colour, always present. This
  replaces 016 FR-232's "End session first"; Interrupt and Resume move to the header (FR-542).

**Look**

- **FR-552 - no boxes in boxes**: a card is one surface with a hairline border and a faint shadow;
  sections, site rows and activity rows inside it are separated by hairlines, never by filled boxes or
  bordered tiles. Idle cards share one surface, one row each, separated by hairlines.
- **FR-553 - colour carries meaning only**: colour other than text greys appears only on the primary
  action, the state, the "✓" marks, result words, "Tab here", danger text buttons and the session bar. A
  card that needs the owner because it waits or is stopped has a warning-coloured border and a soft ring.
- **FR-554 - type ladder**: the title is the largest text on the card (15 px, semibold); section titles
  are small and muted (12 px); body text is 13 px; times, meta and marks are 12 px or less, and times use
  figures of equal width. Every colour comes from the panel's tokens; new hairline colours are added to
  the token set in both themes.

**Words**

- **FR-555 - one voice**: every activity sentence addresses the owner as "you" (zh-TW 「你」); the panel
  never calls the owner 「主人」. A sentence that already says what happened carries no second outcome
  word.
- **FR-556 - copy**:

  | Where | en-US | zh-TW |
  |---|---|---|
  | Section title | Sites and permissions | 網站與權限 |
  | Section title | Recent activity | 最近活動 |
  | Site mark | Tab here | 分頁在這 |
  | Site mark | In site plan | 計畫內 |
  | Grant | ✓ {kind} | ✓ {kind} |
  | Place | Chrome / Terminal | Chrome／終端機 |
  | Primary action | Answer / Resume / Interrupt | 去回答／繼續／中斷 |
  | Idle heading | Idle | 待命中 |
  | Row fold | Show all {n} / Show less | 顯示全部 {n} 筆／收起 |
  | Stop + resume | You stopped it from the page, then resumed | 你從頁面停止，之後繼續 |
  | k pairs | You stopped and resumed it from the page {k} times | 你從頁面停止又繼續了 {k} 次 |
  | Stop alone | You pressed Stop on the page | 你在頁面按了「停止」 |
  | Resume alone | You resumed the session | 你讓工作階段繼續 |
  | Interrupt | You interrupted a step | 你中斷了一步 |
  | Last line | {time} · Technical details | {time} 開始 · 技術資訊 |
  | Open/fold name | Show details for {name} / Hide details for {name} | 顯示 {name} 的詳細資訊／隱藏 {name} 的詳細資訊 |

- **FR-557 - panel only**: no frame, field, tool, worker behaviour or stored value changes; everything
  above is made by the panel from the picture it already receives.

### Key Entities

- **Needs-the-owner**: a session that is waiting, working, or stopped from the page.
- **Site row**: one site (host, optional origin), whether a tab is held there, whether it is in the site
  plan, and its session grants with where each was given.
- **Activity row**: time, sentence, optional result word and tone, optional place; made from one or more
  activity items by FR-550.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-239**: With the six-session fixture, the whole tab (status row, three open cards, idle group) fits
  in 2 screens of a 1000 px-tall panel, against 4.5 today.
- **SC-240**: With the integration-v1 fixture, its open card is at most 60 % of today's card height.
- **SC-241**: Each site appears exactly once in "Sites and permissions" for every fixture session (0
  duplicates), and no shown text contains "https://".
- **SC-242**: The light zh-TW capture of the fixture has no difference from the prototype E capture that
  the acceptance verifier judges as a design difference (wording, order, marks, colour use).
- **SC-243**: Light/dark × en-US/zh-TW captures: 0 rows overflow the panel, every text pair keeps 4.5:1.
- **SC-244**: Every existing card action (End session, Take back tabs, Interrupt, Resume, Withdraw site
  plan, Manage) still sends the same message to the worker as before (0 changed frames).

## Assumptions

- The owner judges the final look on the real panel after merge; the prototype E capture is the design
  reference for the build.
- The idle group's fold state, like the owner's open/fold choices, is not remembered across panel opens.
- "Answer" focuses the existing consent card; it does not answer and does not switch tabs.
- Locales other than en-US and zh-TW fall back to en-US as today.

## Non-goals

- The warm palette (prototype F) or any change to colours outside the session card; it is the next
  spec.
- Changes to the conversation tab, the consent card, the status row or the settings page.
- New worker data (for example, per-tab times or more than 20 activity items).
- Remembering fold choices across panel opens.

## Change log

- **2026-11-17**: first draft from the owner's choices D and E on the prototype; approved by the owner the
  same day.
- **2026-11-17**: implementation (T1052-T1069). Ruling on FR-549 from the fixture review: only an allowed
  answer is coloured as success; a dialog OK, a delivery or a restore is a plain (muted) result, as in
  the prototype. `sitesOf` also lists the session's own `site` so its Manage control stays reachable.
  Live run: zh-TW passed every 036 claim in the real panel; the en-US leg stopped at the harness locale
  switch, and the same spec already failed at d747ed4 (earlier, on the old card's title text).

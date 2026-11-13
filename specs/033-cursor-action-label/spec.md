# Feature Specification: The Pointer Says What the Agent Is Doing

**Feature Branch**: `worktree-spec-033-cursor-action-label` (from private main 14dcad0)

**Feature Directory**: `specs/033-cursor-action-label`

**Created**: 2026-11-13

**Status**: Draft. The owner chose the scope on 2026-11-13; the spec itself awaits the owner's approval.

**Input**: The owner compared Hallpass with a comparable browser-agent extension on 2026-11-13 and
liked that its on-page pointer carries a short caption of the current action ("reading page text",
"clicking") and moves like a hand. Observable behaviour only (clean room, `docs/design-notes.md`);
every phrase, number and shape below is Hallpass's own.

**Facts checked 2026-11-13** (this repository at private main 14dcad0):

- The page pointer (004 FR-064, R-119; glide added in fe904ea) is an arrow drawn in the top document of
  a held tab. It appears with the first pointer gesture, glides to each new target in a fixed 200 ms
  straight line, stays until the tab leaves the session, and wears the indicator's exclusion marker so
  `read_page`, `get_page_text` and `find` skip it.
- Only pointer gestures (click family, hover, drag, and their `computer` actions, the `computer`
  scroll included) send the pointer anywhere. The `scroll` tool scrolls through the content runtime
  and never moves it. Every other tool leaves it where the last gesture put it, so after a `navigate` the
  arrow still sits over a spot it no longer means anything at.
- Before each gesture's first browser-level event the worker waits for the pointer to report arrival,
  capped at 250 ms.
- Nothing tells the owner what the agent is doing on the page beyond the pill's fixed "An agent is
  working in this tab".
- Agent screenshots (`screenshot`, `computer` screenshot, region close-ups) are taken of the rendered page with no
  step that hides the pointer, the pill or the edge glow. Whether they appear in what the agent
  receives has not been measured.
- The worker already chooses the pill's copy in the owner's locale (`en-US`, `zh-TW`).

**Decisions (D-033-n)**:

- **D-033-1 - scope** (owner, 2026-11-13): an action caption next to the pointer, kept inside the
  viewport; a rest spot for tools that do not point; a press ripple; distance-aware curved motion; the
  caption is not page text; the worker sends the caption over a new internal message; agent captures
  hide the marks if measurement shows they are captured.
- **D-033-2 - deferred** (owner, 2026-11-13): a Stop control on the pill (#64) and moving the pill or
  opening the side panel from it (#65) are separate follow-ups.
- **D-033-3 - captions in the owner's locale**: the caption follows the same locale as the pill. A
  `zh-TW` base phrase is at most 8 characters; the English one at most 24.
- **D-033-4 - every agent gets captions**: outside MCP agents and side-panel conversations drive the
  same tools, so both get the caption; the MCP protocol does not change.
- **D-033-5 - GIF recordings keep the marks**: a recording is made for people, and the pointer and its
  caption are what make it readable. Only captures returned to the agent hide them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner sees what the agent is doing (Priority: P1)

The owner glances at the tab an agent is working in and reads, next to the pointer, what is happening
right now: "Clicking", "Typing", "Reading page text", "Finding “Sign in”", in their own language.

**Why this priority**: It is the whole point of the feature; the pill only says *that* an agent is
working, never *what* it is doing.

**Independent Test**: With a session holding a test page, run one tool of each kind in
FR-499's table and confirm the caption text and language each time, in `en-US` and `zh-TW`.

**Acceptance Scenarios**:

1. **Given** a held tab and owner locale `zh-TW`, **When** the agent clicks a button, **Then** the
   pointer travels to the button with the caption 「點擊」 beside it.
2. **Given** a held tab, **When** the agent runs `find` with the query "Sign in", **Then** the caption
   reads "Finding “Sign in”" and the pointer does not move.
3. **Given** a query longer than the parameter limit, **When** the caption is shown, **Then** the
   parameter is cut with an ellipsis and the caption stays on one line.
4. **Given** a caption at a pointing position, **When** about one second has passed without a new
   action, **Then** the caption fades out while the pointer stays.
5. **Given** a `browser_batch` of three steps, **When** it runs, **Then** each step shows its own
   caption as it starts.

---

### User Story 2 - The pointer rests when the agent is not pointing (Priority: P1)

When the agent opens a page, fills a field by reference, resizes the window or uploads a file, the
pointer moves to a rest spot near the bottom-left corner with the caption beside it, so it never seems
to point at something it is not acting on.

**Why this priority**: Without it a caption such as "Opening example.com" would hang over the last
button the agent clicked, which tells the owner something false.

**Independent Test**: Click a button in the middle of a test page, then `navigate`; confirm the
pointer is at the rest spot with "Opening localhost" and the caption does not fade.

**Acceptance Scenarios**:

1. **Given** the pointer over a button, **When** the agent calls `navigate`, **Then** the pointer moves
   to the rest spot and the caption "Opening {host}" stays until the next action.
2. **Given** the pointer at rest, **When** the agent next clicks, **Then** the pointer travels from the
   rest spot to the target.
3. **Given** no pointer on the page yet, **When** the first tool on the tab is a reading tool,
   **Then** the pointer appears at the rest spot with the reading caption.

---

### User Story 3 - The pointer moves like a hand and shows the press (Priority: P2)

Short moves are quick, long moves take a little longer, the path bends slightly and settles, the arrow
leans a little into the motion, and a ring spreads from the tip when a press lands.

**Why this priority**: It is the "feel" the owner noticed; the caption carries the information, the
motion makes it believable.

**Independent Test**: Run a batch of clicks at near and far targets on a test page and record a GIF;
confirm travel time grows with distance within its bounds, the path is curved, and each click shows one
ring after the arrow stops.

**Acceptance Scenarios**:

1. **Given** two clicks 40 px apart and two clicks 1000 px apart, **When** they run, **Then** the far
   move takes longer than the near one and neither is shorter than 140 ms or longer than 380 ms.
2. **Given** a click, **When** the press is dispatched, **Then** one ring spreads from the tip and is
   gone within one second, and the page reacts only after the arrow has stopped.
3. **Given** the owner's system asks for reduced motion, **When** the agent clicks, **Then** the
   pointer jumps without a curve or lean and the press shows as a brief fade instead of a spreading
   ring.

---

### User Story 4 - The caption is never in the agent's way (Priority: P1)

The caption never leaves the visible page, never becomes text the page or the agent can read, and
the pointer, caption, pill and glow never appear in a screenshot returned to the agent.

**Why this priority**: An agent reading its own caption back, or seeing it over the element it wants to
read in a screenshot, would act on Hallpass's drawing instead of the page.

**Independent Test**: Put the pointer at each corner of the viewport and check the caption is fully
visible; run `get_page_text`, `read_page` and `find` for the caption words; take a screenshot while the
pointer and caption are up and inspect the image.

**Acceptance Scenarios**:

1. **Given** a target 10 px from the right edge, **When** the caption is shown, **Then** it sits on the
   left of the pointer, fully visible, with its pointed corner toward the arrow.
2. **Given** a target 10 px from the bottom edge, **When** the caption is shown, **Then** it sits above
   the pointer, fully visible.
3. **Given** the caption "Reading page text" is up, **When** the agent runs `find` for "Reading page
   text" or the page searches its own text, **Then** nothing of the caption is found.
4. **Given** the pointer, caption, pill and glow are up, **When** the agent takes a screenshot or a region
   capture, **Then** the returned image contains none of them, and they are back on the page right after.
5. **Given** a GIF recording is running, **When** frames are captured, **Then** the pointer and caption
   are in the frames (D-033-5).

---

### Edge Cases

- A tool fails or is refused before it acts: the caption it put up is replaced by the next action's;
  no "failed" caption is shown (the side panel already reports outcomes).
- The tab is hidden (another tab is in front): nothing is animated; the pointer and caption are placed
  directly when the tab is shown again.
- The page navigates: the pointer and caption go with the document as they do today; the next action
  on the new document draws them again (at rest for `navigate` itself).
- The viewport is narrower than the caption: the caption is cut with an ellipsis rather than leaving the
  viewport.
- Screenshot (whole or region) and wait do not change the caption or the pointer's spot; wait shows "Waiting {n}
  seconds" only when it is the first action, otherwise it keeps the current caption.
- Tools without a held page (tab listing, browser choice, site plans, downloads list, recorder control,
  dialog answers) change neither the caption nor the pointer.
- The page styles text or sets `direction: rtl`: the caption's look and reading order are its own and
  do not follow the page.
- Two agent sessions never share a tab, so a caption belongs to exactly one session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-499 - one caption per action**: when a tool starts acting on a held tab, the page shows the
  caption below for that tool, in the owner's locale. `{…}` parameters are cut to 20 characters plus an
  ellipsis. Pointer behaviour: *travel* = the pointer goes to the action's point; *stay* = it stays where
  it is; *rest* = it goes to the rest spot (FR-502).

  | Tool / `computer` action | en-US | zh-TW | Pointer |
  |---|---|---|---|
  | click, left click | Clicking | 點擊 | travel |
  | double click | Double-clicking | 雙擊 | travel |
  | triple click | Triple-clicking | 三連擊 | travel |
  | right click | Right-clicking | 按右鍵 | travel |
  | hover, mouse move | Pointing | 移動游標 | travel |
  | drag | Dragging | 拖曳 | travel |
  | scroll tool (down / up / left / right) | Scrolling down / up / left / right | 向下 / 向上 / 向左 / 向右捲動 | stay |
  | scroll tool, to an element | Scrolling to element | 捲動到元素 | stay |
  | `computer` scroll (down / up) | Scrolling down / up | 向下 / 向上捲動 | travel |
  | type | Typing | 輸入文字 | stay |
  | key | Pressing {keys} | 按下 {keys} | stay |
  | navigate to a URL | Opening {host} | 開啟 {host} | rest |
  | navigate back / forward | Going back / Going forward | 上一頁 / 下一頁 | rest |
  | form_input | Filling in a field | 填寫欄位 | rest |
  | evaluate | Running page script | 執行頁面腳本 | rest |
  | file_upload | Uploading file | 上傳檔案 | rest |
  | upload_image | Uploading image | 上傳圖片 | rest |
  | resize_window, viewport | Resizing window | 調整視窗大小 | rest |
  | read_page | Reading page | 讀取頁面 | stay |
  | get_page_text | Reading page text | 讀取頁面文字 | stay |
  | find | Finding “{query}” | 尋找「{query}」 | stay |
  | read_console | Reading console | 讀取主控台 | stay |
  | read_network | Reading network activity | 讀取網路活動 | stay |
  | wait | Waiting {n} seconds | 等待 {n} 秒 | stay |
  | screenshot (whole or region) | (unchanged) | (unchanged) | stay |

- **FR-500 - first appearance**: a captioned action on a tab with no pointer yet draws the pointer: at
  the action's point for *travel*, otherwise at the rest spot.
- **FR-501 - fading**: a caption shown with the pointer at a pointing position fades out about one
  second after the pointer arrives; a new action shows its caption again at full strength. A caption
  at the rest spot does not fade.
- **FR-502 - rest spot**: the rest spot is near the bottom-left corner of the viewport, inside it,
  clear of the corner by at least 16 px on each side. It follows viewport resizes.
- **FR-503 - the caption stays inside the viewport**: by default the caption sits below-right of the
  arrow's tip with its pointed corner toward the tip. Near the right edge it moves to the left of the
  pointer; near the bottom edge it moves above. In every position it is fully inside the viewport with
  at least 8 px to spare; when the viewport is too narrow, the text is cut with an ellipsis.
- **FR-504 - the caption is a mark, not content**: the caption and pointer take no input, are hidden
  from assistive technology, and their words are not page text: the page's own text search, the
  selection, and Hallpass's `read_page`, `get_page_text` and `find` never return them.
- **FR-505 - press ripple**: when a press is dispatched, one ring spreads from the arrow's tip and
  disappears within one second. If the pointer is still travelling, the ring waits for its arrival.
- **FR-506 - distance-aware motion**: travel time grows with the distance travelled, never below
  140 ms nor above 380 ms; the path bends sideways by at most 10 % of the distance (and at most
  24 px); the pointer passes the target by at most 3 px and settles onto it; the arrow tilts toward the
  direction of travel by at most 8° and is upright on arrival. Moves under 1 px are not animated.
- **FR-507 - reduced motion**: when the owner's system asks for reduced motion the pointer is placed
  without travel, curve or tilt, and the press shows as a brief fade instead of a spreading ring.
- **FR-508 - press after arrival**: the first browser-level event of a gesture is still dispatched only
  after the pointer reports arrival, or after a cap that covers the longest travel with slack (no more
  than 450 ms); the press and release follow without extra waiting, as today. A page that never reports
  arrival costs at most the cap.
- **FR-509 - captures for the agent hide the marks**: if measurement (US4) shows the pointer, caption,
  pill or glow appear in a capture returned to the agent, they are hidden for that capture and restored
  right after. Hiding must not change the page's layout or what is under a given point, so the page
  cannot learn from hit-testing that a capture is being taken; the time they are hidden is bounded and
  they come back even when the capture fails. GIF recording frames keep them (D-033-5).
- **FR-510 - the worker decides the words**: the worker chooses the caption, its locale and its
  pointer behaviour and sends them to the page over an internal message of a fixed, closed shape. The
  page script never chooses or translates words, accepts only that exact shape, and puts the words on
  screen as text, never as markup. The agent-facing tool protocol is unchanged.
- **FR-511 - lifetime**: the caption and the pointer leave the page when the tab leaves the session,
  as the pointer does today.

### Key Entities

- **Pointer step**: what the worker sends the page when an action starts — the caption words (already
  in the owner's locale, possibly empty), the pointer behaviour (*travel* with a point, *stay*, or
  *rest*), and nothing else.
- **Caption**: the words on screen next to the pointer; their placement (below-right, left or above),
  and whether they are fading.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-219**: For every row of FR-499's table, the caption shown matches the table in both locales
  (24 rows × 2 locales checked).
- **SC-220**: With the pointer at each of the four corners and the four edge midpoints of a 1280×800
  and a 400×700 viewport, the caption is fully visible in all 16 placements.
- **SC-221**: Across 20 clicks at mixed distances, every page reaction happens after the pointer has
  stopped, and no gesture waits more than 450 ms for the pointer.
- **SC-222**: `find`, `get_page_text` and `read_page` return none of the caption words in any of the
  captions of FR-499 (0 matches).
- **SC-223**: Screenshots and region close-ups taken while the pointer, caption, pill and glow are up
  contain none of them (0 of 10 captures), and the marks are visible again within 0.5 s of each capture.
- **SC-224**: In the owner's live run, the owner can say what the agent is doing from the page alone for
  each step of a 10-step task, without looking at the side panel or the terminal.

## Assumptions

- The owner's locale is the one the pill already uses; locales other than `en-US` and `zh-TW` fall back
  to `en-US` as elsewhere.
- Captions are drawn in the top document only, like the pointer; coordinates stay the top viewport's.
- The `computer` tool's actions map to the same rows as their stand-alone tools.
- Side-panel conversations and outside MCP agents run tools through the same worker path, so one
  change covers both.
- Live verification uses the attached-browser setup the packaged gate already uses; no new tooling.

## Non-goals

- A Stop control on the pill (#64).
- Moving the pill, or opening the side panel from it (#65).
- "Done" or "failed" captions; outcomes stay in the side panel and the agent's client.
- Changing the arrow's shape or colour, the pill, or the glow, beyond hiding them for captures.

## Change log

- **2026-11-13 (first live run)**: the `scroll` tool's rows (directions and to-element) are `stay`, not
  `travel`: the tool scrolls through the content runtime and never sends the pointer a move, so a
  `travel` step (held until the next move) was never drawn. The `computer` tool's scroll still goes
  through the pointer and travels. FR-499's table and the Facts above are corrected.
  A `rest` step is also sent again once its call has finished: the first send goes out before the call
  runs, so for a `navigate` that replaces the document it reached the document being left and the new
  one showed no pointer and no caption (US2). The second send reaches the tab's new top document, and
  injects the page runtime first when that document has none (the indicator's send-or-inject path).

# Research: The Pointer Says What the Agent Is Doing

Decisions R-491..R-499 for spec 033. Seams were read at private main 14dcad0 (worktree commit 9000dd1).

## R-491 - one caption step per tool call, sent from `dispatchTool`

- **Decision**: `dispatchTool` (`apps/extension/src/service-worker/agent-runtime.ts`, after
  `heldByTransition`, before `runTool`) sends the tab's top frame one *pointer step* for every call that
  has a held tab: top-level calls and every `browser_batch` step pass through it. The step carries the
  caption words, already in the owner's locale, and the pointer behaviour (`travel` / `stay` / `rest`).
  It is fire-and-forget: the worker never waits for it, and a page that does not answer costs nothing.
  Words and behaviour come from one pure worker module (`agent-tools/pointer-captions.ts`) that maps a
  tool name plus its args (including `computer` actions, scroll direction, navigate URL / back /
  forward, `find` query, `key` keys, `wait` seconds) to FR-499's row.
- **Rationale**: one seam covers both agent kinds (D-033-4) and every batch step; the runners stay
  untouched. A failed or refused call simply leaves its caption until the next step (spec edge case).
- **Alternatives**: a step in each runner (≈10 call sites, easy to miss one); carrying words on the
  existing cursor message only (reaches pointer gestures only, not `navigate` or reads).

## R-492 - `travel` captions ride the existing move

- **Decision**: for a `travel` row the step only stores the caption on the page; the pointer moves when
  the existing cursor message `{type:"cursor", x, y}` arrives from `input.ts`, as today. The cursor
  message gains an optional `press: true` for the click family and the drag's press, which asks the page
  for the ripple when that move lands (FR-505). Tools with no pointer yet draw it at the move's point
  (FR-500), because the step for a `travel` row never draws it.
- **Rationale**: the target point is resolved inside `runEffect` (`effects.ts`), long after dispatch;
  reusing the move keeps exactly one source of pointer positions.
- **Alternatives**: a separate "press" message just before `mousePressed` (one more round trip in the
  gesture's critical path).

## R-493 - locale and words

- **Decision**: the locale is the one the pill already uses (`chrome.i18n.getUILanguage()`, mapped by
  `selectLocale`: `zh-TW` or else `en-US`). New catalog keys `agent.pointer.*` go in `locales/en-US.ts`
  and `locales/zh-TW.ts` (compile-time parity via `MessageKey`). `lookup` does not interpolate, so
  `pointer-captions.ts` substitutes `{host}`, `{query}`, `{keys}`, `{n}` itself, cutting each parameter
  to 20 characters plus `…` (FR-499). Host = the URL's hostname; `back` / `forward` use their own rows.
- **Rationale**: same mechanism as every other worker-chosen string; zh-TW parity is enforced by the
  existing type and `accessibility-localization.test.ts`.

## R-494 - the caption is drawn as generated content

- **Decision**: the pointer and pill are plain light DOM today, so the page's `window.find` and the
  selection can reach any text node in them. The caption is therefore an empty element whose words sit
  in an attribute (`data-hallpass-words`) and are drawn by a stylesheet rule
  `::before { content: attr(data-hallpass-words) }`. The stylesheet is one `<style>` element wearing the
  indicator marker, added once per document with the pointer. The caption element also wears the
  indicator marker and `aria-hidden="true"`, so `read_page`, `get_page_text` and `find` skip it as they
  skip the pointer (FR-504).
- **Rationale**: generated content is not part of the DOM text: neither text search nor selection
  returns it, and no Hallpass collector needs a new rule.
- **Alternatives**: a closed shadow root (larger change to how the pointer is built, and the collectors'
  exclusion would then rely on host-only marking); a canvas (no crisp text, no system font).
- **Not in scope**: the pill's own text stays a text node (spec Non-goals).

## R-495 - caption placement is a pure function

- **Decision**: `placeCaption({viewport, point, caption:{width,height}, atRest})` returns the offset and
  the side (`below-right` / `left` / `above`, plus the pointed corner) per FR-503: default below-right of
  the tip; `left` when `point.x + gap + width > viewport.width - 8`; `above` when
  `point.y + gap + height > viewport.height - 8`; clamped so the box stays ≥ 8 px inside; the caption gets
  `max-width: viewport.width - 16px` with ellipsis. The page measures the caption once per word change
  (`offsetWidth`) and calls it; jsdom tests call the function directly.
- **Rationale**: the edge rules are the whole of A2 and are easiest to prove as arithmetic.

## R-496 - motion: a planned path played by the Web Animations API

- **Decision**: a pure planner `planTravel(from, to, reducedMotion)` in a new
  `content-runtime/cursor-motion.ts` returns `{durationMs, frames[]}`:
  - duration = clamp(90 + 60·log2(1 + d/20), 140, 380) ms, 0 for d < 1 px or reduced motion;
  - the path bends sideways by min(0.1·d, 24) px on a sine profile, the side chosen by the travel
    direction so successive moves do not all bow the same way;
  - the last ~25 % passes the target by min(0.025·d, 3) px and settles back (a smooth ease, no bounce);
  - 12 sample frames as `transform: translate3d(x,y,0)`; the arrow's own inner element gets a matching
    `rotate()` track, tilt = 8°·tanh(speed / 1.5 px·ms⁻¹) toward travel, 0 at both ends.
  `moveCursor` plays the frames with `element.animate()` and resolves arrival on `finish`, or after
  `durationMs + 60` ms, or at once when the document is hidden, on first placement, for the same target,
  or when `animate` is unavailable (then it sets the final transform directly). A new move cancels the
  running animation and starts from the pointer's current computed position.
- **Rationale**: a CSS transition cannot bend a path or overshoot; the animation API needs no frame loop
  of ours. The constants are Hallpass's own and may be tuned at the owner's live look.
- **Worker cap**: `CURSOR_ARRIVAL_CAP_MS` becomes 420 (longest travel 380 + slack, FR-508 ≤ 450 ms). The
  drag's 60 ms cap is unchanged (a held drag must not sit still).

## R-497 - rest spot and fading

- **Decision**: a `rest` step moves the pointer (with the same planner) to (16, viewport.height − 16 −
  arrow height) and keeps the caption up; a `stay` step changes the words only; an empty-words step
  changes nothing visible. Fading: after each arrival at a pointing position (and after a `stay` step) a
  1 000 ms timer sets `data-faded` on the caption (opacity 0 over 200 ms); any new step or move clears it.
  At rest there is no timer. On `resize` the resting pointer is placed again without animation.
- **Rationale**: FR-501..502 with one timer and one attribute.

## R-498 - press ripple

- **Decision**: when a move with `press: true` arrives (or at once if already there), the page adds one
  ring element at the tip: a 6 px circle scaling to 34 px while fading out over 520 ms, removed on
  `animationend` or after 700 ms. Under reduced motion the ring does not grow; it fades out in 250 ms.
  The ring wears the indicator marker.
- **Rationale**: FR-505 / FR-507 without delaying the press: the worker dispatches after the arrival
  ack exactly as today; the ring is the page's own reaction to the same arrival.

## R-499 - captures returned to the agent hide the marks

- **Measurement first** (T980): with the pointer, pill and glow up on a test page, take a `screenshot` and
  inspect the returned image. All three are page DOM and `Page.captureScreenshot` /
  `captureVisibleTab` paint the page as shown, so they are expected to appear; FR-509 applies only if the
  measurement confirms it.
- **Decision (if confirmed)**: a new page message `{type:"marks", hidden:boolean}` to frame 0. On
  `hidden:true` the page sets `data-hallpass-hidden` on the pointer, caption, ring, pill and glow, styled
  `opacity: 0 !important; transition: none !important` (no `display`/`visibility`
  change, nothing moves, nothing under any point changes — they are already `pointer-events: none`),
  waits two animation frames so the hidden state is painted, and answers. It restores on
  `hidden:false` and, as a safety net, by itself 3 s after hiding. Hiding is inline on each mark
  (`opacity: 0 !important; transition: none !important`), not through the injected stylesheet, so a
  page CSP cannot block it. Restoring puts opacity back while the transition is still off, so the marks
  return at once with no fade, then answers after two frames.
  The worker wraps only the agent-facing captures: `reads.ts` `screenshot` (whole and region) and the
  `computer` screenshot in `effects.ts`, in `try { hide (await ack, ≤ 250 ms) ; capture } finally {
  show (await ack, ≤ 250 ms) }`, so the GIF frame recorded after the call sees the marks back. Overlapping
  captures of one tab share one hide and one show. `photographTab` itself does not hide, so the GIF recorder's fallback through it keeps the marks
  (D-033-5). The tab need not be active for the message; an inactive tab's capture activates it first, as
  today, and the marks are already hidden by then.
- **Risk**: R1 (lifecycle: hide must always be undone, including on capture failure and timeout) →
  code-reviewer on this slice.
- **Alternatives**: hide in `photographTab` with a flag (one more option on a shared function the GIF
  path also uses); `display:none` (changes the page's DOM state more visibly; rejected by FR-509).

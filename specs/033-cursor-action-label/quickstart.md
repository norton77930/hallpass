# Quickstart: checking spec 033

## Automated

```powershell
npx tsc -b
npm run typecheck
npm test                       # pointer-captions, caption placement, motion planner, cursor, pointer-delivery, marks
npm run build
npm run test:contract
npm run snapshot:check
```

## Live (owner's Chrome or the attached test Chromium, after an extension reload)

Serve the fixtures (`npm run dev:test-pages`, `https://localhost:19443`) and drive a session from an MCP
client. Record one GIF per check.

1. **Captions, en-US then zh-TW** (US1, SC-219): run one call per FR-499 row; read the caption each time.
   Switch Chrome's UI language to 繁體中文 and repeat a subset (click, navigate, find, key, wait).
2. **Rest spot** (US2): click a button mid-page, then `navigate`; the pointer goes bottom-left and the
   caption "Opening localhost" stays. A following click travels from the rest spot.
3. **Motion and ripple** (US3, SC-221): a batch of clicks 40 px and ~1000 px apart; far moves take longer,
   paths bend, each click shows one ring after the arrow stops, the page reacts after it stops. With
   Windows "Animation effects" off, the pointer jumps and the ring only fades.
4. **Edges** (US4, SC-220): click near each corner and edge midpoint at 1280×800 and at 400×700
   (`viewport`); the caption is fully visible each time.
5. **Not text** (SC-222): with "Reading page text" shown, Ctrl+F for "Reading page" finds nothing; `find`
   and `get_page_text` return none of the caption words.
6. **Captures** (US4, SC-223): with pointer, caption, pill and glow up, take `screenshot` (whole and
   `region`); the images contain none of them and the marks are back on the page right after. A GIF
   recording made at the same time does show the pointer and caption.

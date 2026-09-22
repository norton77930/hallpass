# Quickstart: validating feature 012

## Prerequisites

- `npm ci`, `npm run build` (agent build), `.test-pki` present (see the 009 gotchas in memory).
- Unattended gate recipe (011): Chromium headed on 9222 with a private `LOCALAPPDATA`, host
  registered from this worktree, foreign agent servers allowed (memory `unattended-attach-gate`).

## 1. Measurements (before implementation; already made, re-runnable)

```
node .scratch/r166-viewport-capture.mjs chromium
```

Expected (Chromium 151, see research R-166): emulated 2 560×1 440 → page reports it, window
unchanged, `captureVisibleTab` 1 484×814, protocol capture 2 560×1 440; DPR-2 clip 300×100 → 600×200;
after detach the page still reports the emulated size until reload.

Owner (R-168): the same on branded Chrome 153 through the attach recipe; record the numbers in
research.md.

## 2. Unit and contract

```
npm run test:unit
npm run test:contract
npm run snapshot:check
```

Expected: green; tool count 32; no manifest permission change; the descriptions contain the
steering sentences (contract test).

## 3. Packaged gate

```
npx playwright test tests/e2e/packaged/agent-viewport.spec.ts tests/e2e/packaged/agent-reads.spec.ts
```

Expected, in order (SC-085..089):

1. `viewport set 375×812` → page 375×812, narrow layout, window bounds/state unchanged.
2. `viewport set 2560×1440` → page 2 560×1 440, wide layout; `screenshot` answers
   `coverage: viewport`, `frame 2560×1440`; a click on an element only laid out at that width lands.
3. `reset` → real size. `set` again, `tabs_release` → real size. `set`, owner take-back via the
   panel → real size. `set`, session end → real size (4/4).
4. `set`, kill the worker, next call → page still emulated, record present (SC-087).
5. Forced DPR 2 fixture: region 100,200 300×100 → 600×200; with `scale 0.5` → 300×100; 11 px text
   matches the reference crop; region past the frame → `region-outside-viewport (frame …)`.
6. Plain screenshot `scale 0.5` → half width and height; answer says `scale 0.5`, `frame` real.

## 4. Probe (paid, owner's go-ahead)

```
claude -p --model sonnet "Open http://127.0.0.1:<port>/fixture and show me how it looks at a phone width" 
```

Expected (SC-090): the transcript shows a `viewport` call and no `resize_window` call; recorded in
coverage.md with the model.

## 5. Regression

```
npx playwright test tests/e2e/packaged/agent-window-restore.spec.ts tests/e2e/packaged/agent-input.spec.ts tests/e2e/packaged/agent-recording.spec.ts
```

Expected: green (window restore untouched; pointer and recording unaffected by the capture change).

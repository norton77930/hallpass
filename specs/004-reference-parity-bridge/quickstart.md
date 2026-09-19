# Quickstart: Reference Parity for the Local Agent Bridge

How the feature is proven. Everything here is run by the implementer; the owner's only part is the
one-time browser setup in step 1.

## 1. One-time owner setup (once, then never again)

1. Start the branded Chrome 152 with remote debugging on a **dedicated profile** — Chrome ignores
   `--remote-debugging-port` on the default profile, so the shortcut must carry both flags:
   `--remote-debugging-port=9222 --user-data-dir=D:\chrome-agent-profile`. The attach-mode gate and the
   probe reach the browser there (`HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222`). Done 2026-09-09.
2. In that profile: `dist/agent` loaded unpacked (extension id `adgpccmmbgnchnphfaoabfflfcepbopd`, the
   id the host manifest allows), the reference extension installed from the store, and the owner signed
   in to claude.ai so baseline runs can reach an artifact page. Done 2026-09-09.
3. Register `hallpass` only in this project's `.mcp.json`; remove any other-project registration
   (`claude mcp remove hallpass` inside that project), so sessions of other projects do not spawn
   servers. (After S1 this is a hygiene item, not a correctness one.)

## 2. Build and install

```powershell
npx tsc -b
npm run build:extension:agent
npm run agent-host:install        # rewrites the host manifest; the relay is now the listener (R-111)
npm run build:extension:test      # archive guard: narrow manifest byte-identical (SC-038)
```

## 3. Unit and contract suites (no browser)

```powershell
npm test            # unit + extension-ui projects
npm run test:contract
```

New unit coverage: relay multiplexer routing, server dial loop, lease store, persistent ref registry
(stale/prune), frame merge, coordinate translation, `computer` argument validation, probe report writer.

## 4. Attach-mode gate (dedicated Chrome profile, fixtures)

```powershell
$env:HALLPASS_CDP_ENDPOINT = "http://127.0.0.1:9222"
$env:HALLPASS_LOCALE = "en-US"        # then zh-TW
npm run test:e2e:agent
```

Expected: every 003 `agent-*` journey still passes, plus the new ones: `agent-sessions` (two
servers, one relay), `agent-claim` (owner tab, indicator, focus-main), `agent-frames` (fixture with a
nested iframe), `agent-input` (hover menu, per-key combobox on the fixture), `agent-refs` (three reads,
first ref acts), `agent-computer` (canvas fixture).

## 5. Acceptance probe (dedicated Chrome profile, real pages, agent as caller) — the definition of done

```powershell
$env:HALLPASS_CDP_ENDPOINT = "http://127.0.0.1:9222"
node --experimental-strip-types tests/acceptance/probe-004/run.ts --slice S3   # or --all
```

What it does (R-118): checks the environment, then per scenario spawns
`claude -p --model sonnet --effort low --output-format json --json-schema … --mcp-config … --strict-mcp-config --allowedTools "mcp__hallpass__*,mcp__claude-in-chrome__*"`
with the scenario's fixed prompt; the agent runs the reference's tools first (baseline) and then
`hallpass`; the probe compares and writes `tests/acceptance/probe-004/reports/004-<timestamp>.md` and `.json`.

| Slice | Scenarios | Page | Passes when |
| --- | --- | --- | --- |
| S0 | environment, one trivial call | any | report produced, environment table filled |
| S1 | 3 concurrent sessions; foreign tab refused; relay killed; server killed | any | SC-029, SC-030 |
| S2 | pairing with 20 s accept; owner tab listed/claimed/read; indicator control | any owner-opened page | SC-031, SC-032 |
| S3 | frame read vs baseline (read half) | claude.ai artifact page | SC-033 (read) |
| S4 | click inside frame (act half); hover menu; per-key suggestions | developer.chrome.com video frame; python.org nav; Wikipedia search | SC-033 (act), SC-034 |
| S5 | ref stability; capacity vs baseline; open shadow root | GitHub repo page (+ a shadow-DOM page) | SC-035, SC-036 |
| S6 | toolbar click by position | excalidraw.com | SC-037 |
| every run | archive guard | — | SC-038 |

Three scenario pages were replaced from what they were originally named as, each measured free before
the swap (see `specs/004-reference-parity-bridge/tasks.md` T129/T137 for the full measurement):

- **The hover page** moved from MDN's "Web APIs" nav to `python.org`'s "Socialize" nav. The MDN menu is
  click-driven — proven three ways (no pointer listener anywhere on it, no `:hover` CSS rule, and a
  trusted hover left it closed while a trusted click opened it) — so no hover could ever open it.
- **The frame-click page** (SC-033's act half) moved from the claude.ai artifact frame to
  `developer.chrome.com/docs/devtools/overview`'s embedded YouTube frame. The artifact frame carries no
  interactive role at all — nothing there for a click to land on — so the read half stays pinned to it
  (it is the oracle for the owner's original E4 failure) while the act half moved to a page with a real,
  genuinely cross-origin control.
- **The shadow page** moved to `mdn.github.io/web-components-examples/editable-list/`, a 14-node page
  whose entire content lives inside one open shadow root. Earlier candidates sat past `find`'s
  collection ceiling, so their shadow content was correctly out of reach, not a product defect.

A slice is delivered only with its report attached and `verdict: done`. A `not-run: page changed`
scenario names a replacement page and blocks delivery until re-run.

**Runs so far (2026-09-12), both `--all`, zh-TW:** `reports/004-2026-09-12T13-00-46Z.md` (15/18) and
`reports/004-2026-09-12T15-58-55Z.md` (15/18, a different three scenarios failing). Neither is `done`;
T142 (the final zh-TW `--all` run attached to `coverage.md`) is still open. See `tasks.md` Phase 10 for
which scenarios failed on which run and why.

## 6. Expected answers worth knowing

- Second session's first call while another runs: success, own group (never `bridge-unavailable`).
- Reading a tab another session holds: `refused/held-by-session {sessionId}`.
- Reading an owner tab not claimed: `refused/not-yours`; after `tabs_claim`: success.
- Effect on a tab with DevTools open: `failed/input-unavailable {reason: devtools-open}`.
- Old ref after the element is removed: `stale-reference`; after another `read_page`: still works.
- `computer` outside the viewport: `refused/outside-viewport {width, height}`.

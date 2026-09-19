# Feature 004 — acceptance coverage (T142, SC-028)

Which scenario of the acceptance probe (`tests/acceptance/probe-004/scenarios/`) closes which
requirement, and where each scenario's baseline comes from. SC-028 is the claim this table exists
for: *every* functional requirement is closed by at least one scenario in a run on the owner's
branded Chrome 152, with the coding agent as caller, against the named public page, with the baseline
recorded in the same run. A requirement whose only evidence is a fixture or a unit test is named as
such below rather than counted as covered by the probe.

**Baseline source, every scenario: `browser-tree`.** Settled 2026-09-09 (T085, R-118): the reference
extension is installed and enabled but publishes no MCP server, so a `claude -p` session cannot call
it; tree scenarios are judged against the browser's own accessibility tree read over the same
debugging session (`baseline.ts`), and `s0-baseline-source` records the attempt and the answer in
every run. The report's environment table says `baselineSource: browser-tree` for the same reason.

## Requirement → scenario

| Requirement | Claim (short) | Probe scenario(s) | Success criterion | Also proven by |
| --- | --- | --- | --- | --- |
| FR-055 | Any number of paired sessions use the browser at once | `s0-first-call` (3 concurrent), `s1-three-sessions` | SC-029 | `agent-sessions` |
| FR-056 | A tab belongs to at most one live session; a foreign-held tab is refused *naming the holder* | `s1-three-sessions` (restated to access, T163), `s2-owner-tab` | SC-029 | `agent-claim`, `agent-tabs` |
| FR-057 | Link lost → both live sessions' next call recovers | `s1-relay-killed` (2 concurrent) | SC-030 | `agent-sessions` |
| FR-058 | A session ends with its agent process; the other keeps working | `s1-server-killed` (2 concurrent) | SC-030 | `agent-sessions` |
| FR-059 | The call that raises a pairing request waits for the owner's answer | `s0-pairing-timing`, `s2-pairing-20s` (×5, accept after 20 s) | SC-031 | `agent-pairing` |
| FR-060 | A paired session lists every tab in the browser, with holder and active flag | `s0-owner-tab`, `s2-owner-tab` | SC-032 | `agent-tabs` |
| FR-061 | A session takes an unheld tab in one call | `s2-owner-tab` | SC-032 | `agent-claim` |
| FR-062 | Every held tab shows the in-page indicator | `s2-owner-tab` (note records the indicator on the owner's tab) | SC-032 | `agent-tabs`, `agent-claim` (indicator asserted in the page) |
| FR-063 | Reads cover every readable frame, cross-origin included | `s0-artifact-frame` (the "before"), `s3-artifact-frame` (tree containment) | SC-033 (read half) | `agent-frames` (nested + genuine OOPIF fixture) |
| FR-064 | Pointer effects are real browser input, frame offsets applied | `s4-hover-nav` (CSS `:hover` submenu), `s4-artifact-click` (click inside a cross-origin frame with a non-zero offset) | SC-034, SC-033 (act half) | `agent-input`, `agent-actions` |
| FR-065 | Typing arrives one keystroke per character | `s4-wikipedia-typing` (per-key suggestion list) | SC-034 | `agent-input` (fixture keydown counter) |
| FR-066 | A reference stays valid while its element is on the page | `s5-github-refs` (first-read ref acts after two more reads) | SC-035 | `agent-refs` |
| FR-067 | Tree read reaches the reference's capacity | `s5-github-capacity` (full read, tree containment on a large page) | SC-036 | `agent-reads` |
| FR-068 | Reads and finds include open shadow roots | `s5-shadow-page` (find resolves a shadow-only control) | — | `agent-reads` |
| FR-069 | Position-based action on a held tab | `s6-excalidraw` (toolbar tool changes by coordinate click) | SC-037 | `agent-computer` |
| FR-070 | Narrow build and 001/002 behaviour byte-identical | **not a probe scenario** — `narrow-manifest-guard.test.ts` (byte comparison) and the launched 001/002 gate, en-US + zh-TW | SC-038 | `browser-matrix.md` "Feature 004" |
| FR-071 | Site-mode gate, Stop, activity record, diagnostics unchanged under every new tool | **not a probe scenario** — the effect scenarios run under `skip-checks` set as an environment step (T129b), so the gate is *exercised* but not *measured* here | — | `agent-actions` (ask → allow/deny per effect), `agent-batch-wait` (Stop mid-batch), `agent-diagnostics`, `agent-privacy` |

Two scenarios carry no requirement of their own: `s0-baseline-source` records the baseline decision
above in every run, and the S0 files as a group are the "before" measurement — written to fail on the
003 build and re-run unchanged as the S1–S3 acceptance, so the run that proves a fix is the one that
measured the failure.

## Scenario → page, baseline, judgement

| Scenario | Slice | Evidence | Page | Baseline | Judged by | Expected |
| --- | --- | --- | --- | --- | --- | --- |
| `s0-artifact-frame` | S0 | E4 | claude.ai artifact (pinned id) | browser-tree | observed-equals | `artifact-body-read` |
| `s0-baseline-source` | S0 | T085 | about:blank | browser-tree | observed-equals | `reference-unreachable` |
| `s0-first-call` | S0 | E1 | about:blank, 3 concurrent | browser-tree | observed-equals | `ok` |
| `s0-owner-tab` | S0 | E3 | https://example.com/ | browser-tree | observed-equals | `owner-tab-listed` |
| `s0-pairing-timing` | S0 | E2 | about:blank | browser-tree | observed-equals | `paired-same-call` |
| `s1-relay-killed` | S1 | E1 | about:blank, 2 concurrent | browser-tree | observed-equals | `recovered` |
| `s1-server-killed` | S1 | T099b | about:blank, 2 concurrent | browser-tree | observed-equals | `still-working` |
| `s1-three-sessions` | S1 | E1 | about:blank, 3 concurrent | browser-tree | observed-equals | `ok` |
| `s2-owner-tab` | S2 | SC-032 | https://example.com/ | browser-tree | observed-equals | `owner-tab-worked` |
| `s2-pairing-20s` | S2 | SC-031 | about:blank, repeat 5 | browser-tree | observed-equals | `paired-same-call` |
| `s3-artifact-frame` | S3 | T117 | claude.ai artifact (pinned id) | browser-tree | tree-containment | ≥ 90% of baseline nodes |
| `s4-artifact-click` | S4 | T129 | developer.chrome.com DevTools overview (YouTube embed) | browser-tree | observed-equals | `click-landed` |
| `s4-hover-nav` | S4 | T129 | https://www.python.org/ | browser-tree | observed-equals | `submenu-opened` |
| `s4-wikipedia-typing` | S4 | T129 | en.wikipedia.org Main Page (expands the collapsed box first on a narrow viewport, T164) | browser-tree | observed-equals | `suggestions-shown` |
| `s5-github-capacity` | S5 | T137 | github.com/anthropics/claude-code | browser-tree | tree-containment | full read ⊇ baseline |
| `s5-github-refs` | S5 | T137 | github.com/anthropics/claude-code | browser-tree | observed-equals | `first-read-ref-resolved` |
| `s5-shadow-page` | S5 | T137 | mdn.github.io editable-list | browser-tree | observed-equals | `shadow-find-resolved` |
| `s6-excalidraw` | S6 | T141 | https://excalidraw.com/ | browser-tree | observed-equals | `toolbar-tool-changed` |

Every effect scenario (S4, S5's GitHub refs, S5's shadow page, S6) sets its site to `skip-checks` as
an environment step and the report's "Site modes" row lists each one: the effect would otherwise wait
on an owner prompt nobody is there to answer, and the scenario would record a timeout instead of the
capability. That is an assumption the run makes, written where a reader can see it.

## The runs after T168, and where SC-028 stands

| Run | Result | The reds, in the caller's own words |
| --- | --- | --- |
| `004-2026-09-13T04-36-27Z`, `--slice S4` | **3/3 done** | - (`s4-artifact-click` `click-landed`, the click `verified`) |
| `004-2026-09-13T04-40-39Z`, `--all` | **16/18** | `s1-three-sessions`: two of three sessions read a tab that does not exist - the agent's note says "Step4 target tabId=998414002 (998413002+1000)"; `tab-gone` is the right answer for it. `s3-artifact-frame`: "URL was mistyped by the operator during entry (eaf5bf vs requested eaa5bf)" - a 404 page, read as such. |

Across the day's three valid paid runs every one of the eighteen scenarios passed at least once, and
`s4-artifact-click` - the only cell that had never passed on the product as shipped - passed twice
after T168. The last `--all` is not the single all-green report SC-028 asks for: its two reds are
the `claude -p --model sonnet --effort low` caller mistyping an id and a URL, each admitted in its own
answer, on scenarios that were green three hours earlier on the same build. That is a fact about the
instrument's caller, recorded here rather than spent on: the standing rule is one measurement before
any paid run, and there is nothing left to measure on the product side for these two. Whether to
spend one more `--all` for a single 18/18 report is the owner's call.

## Environment preconditions the run refuses without

Recorded because each one has, at least once, looked like a product failure:

- **No other agent-bridge server on the machine** (T167). Another Claude Code session in this project
  has its own `hallpass` server on the same relay; the probe's environment check lists
  `mcp-server.js` processes and refuses the run naming their pids ("Foreign agent servers" row).
- **The agent build loaded in the dedicated profile is the one on disk.** The attach-mode gate reloads
  and byte-compares (T098b); the probe reads the build's version from the running worker.
- **A long run started from its own console.** From a non-interactive session, launch the probe with
  `Start-Process cmd.exe /c <batch>` (hidden window) and poll its log; a probe whose parent shell
  dies spawns `claude -p` processes that exit `0xC0000142` before starting (the invalid
  `004-2026-09-13T02-53-33Z` run).
- **Viewport wide enough for the page's desktop layout** where the scenario depends on it.
  `s4-wikipedia-typing` no longer does (it expands the collapsed control), but the finding stands: the
  agent build's side panel takes ~780 DIP of the window, and on a 1536-DIP monitor that leaves a
  viewport under Wikipedia's 1120 px breakpoint (T164).

## Final run

**Report:** `tests/acceptance/probe-004/reports/004-2026-09-13T03-01-29Z.md` (+ `.json`), started
2026-09-13T03:01:29Z, `npm run probe:004 -- --all`, Chrome 152.0.7977.77 on the dedicated profile,
`claude` CLI 2.1.270, pairing found (`935a7281…` already accepted), **Foreign agent servers: none**,
site modes set by the run for the six effect pages. Launched from its own hidden console
(`Start-Process cmd.exe /c <batch>`), the only way a ~14-minute paid run survives a non-interactive
session - the first attempt of the day (`004-2026-09-13T02-53-33Z`) lost its console mid-run and every
`claude -p` from `s1-server-killed` on died with `0xC0000142` before starting; that report is kept as
the record of the harness mistake, not as evidence about the product.

**Verdict: not-done — 17/18.** The best run to date (the two before it were 15/18 with a different
three failing each time).

| Scenario | Verdict | Observed |
| --- | --- | --- |
| `s0-artifact-frame` | pass | `artifact-body-read` |
| `s0-baseline-source` | pass | `reference-unreachable` (R-118 fallback in force) |
| `s0-first-call` | pass | `ok` ×3 concurrent |
| `s0-owner-tab` | pass | `owner-tab-listed` |
| `s0-pairing-timing` | pass | `paired-same-call` |
| `s1-relay-killed` | pass | `recovered` ×2 |
| `s1-server-killed` | pass | `still-working` ×2 (one marked expected-killed) |
| `s1-three-sessions` | pass | `ok` ×3 |
| `s2-owner-tab` | pass | `owner-tab-worked` |
| `s2-pairing-20s` | pass | `paired-same-call` 5/5, accept after 20 s |
| `s3-artifact-frame` | pass | headings+links 6/6, controls 4/4 in the full read |
| `s4-artifact-click` | **fail** | `click-missed` - see below |
| `s4-hover-nav` | pass | `submenu-opened` |
| `s4-wikipedia-typing` | pass | `suggestions-shown` (T164's expand-first step, first paid confirmation) |
| `s5-github-capacity` | pass | genuine names 153/153 found, decoys 2/2 not found |
| `s5-github-refs` | pass | `first-read-ref-resolved` |
| `s5-shadow-page` | pass | `shadow-find-resolved` |
| `s6-excalidraw` | pass | `toolbar-tool-changed` |

**`s4-artifact-click` (SC-033's act half, FR-064 in a cross-origin frame) - closed as T168, and
green in the S4 slice run `004-2026-09-13T04-36-27Z` (3/3, the click answering `verified`).** What
the 17/18 run recorded, kept as written at the time: The click on the embed's `Play video` answered `verdict: "target-missed", role: "div",
clicks: 1`; the second read shows the player's controls toggled (`Show/Hide player controls`) and no
`Pause video`, so the click was delivered into the frame but not to the button. Its history is
4 fails → 2 passes (2026-09-10 12:08, 2026-09-12 13:00) → 3 fails, so it is not stable in either
direction. Measured free after the run (Playwright over the same CDP session, same window - maximised
on the 2048-DIP monitor, viewport 1268 px, so *not* T164's viewport condition): inside the YouTube
frame, `document.elementFromPoint` at the centre of `button "Play video"` (72×72 at 315,161 in a
702×394 frame) returns a **class-less `DIV`, not the button** - a transparent layer sits over the
large play button in the player's cued state, and a real click at that point lands on it. That is
the measurement T168 started from. The measurement that closed it (through the product's own tools,
pointer listeners in the embed frame) showed the click landing at the button's centre to the pixel
and the video playing - the class-less `DIV` is the icon *inside* the button, and the
`target-missed` came from a hit-test made *after* the click, once the player had drawn its controls
over the point. The click family now confirms its point before delivery; the scenario now reads
"Pause video" **or** "Show player controls" as playback (YouTube auto-hides the controls a few
seconds in, which is what the 17/18 run's second read saw). Full record: `tasks.md` T168.

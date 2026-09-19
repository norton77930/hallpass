# Acceptance probe — feature 004

This probe is 004's definition of done. Every slice ends with its scenarios run here, against the
owner's own Chrome 152 and a real `claude -p` session, and the report attached. A fixture passing is
not a slice passing.

## Owner setup (once)

Your only recurring step after this is **opening Chrome from the shortcut below**. Everything else on
this page is run by the implementer.

1. **A Chrome shortcut with remote debugging.** Copy your Chrome shortcut and set its target to:

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=D:\chrome-agent-profile
   ```

   The separate `--user-data-dir` keeps this profile away from your everyday one; the debugging port
   is what the probe and the attach-mode gate connect to. Chrome must be started *from this shortcut*
   — an already-running Chrome will not gain the port.

2. **Load the agent build unpacked in that profile.** `chrome://extensions` → Developer mode →
   *Load unpacked* → `apps/extension/dist/agent`. If `dist/test` is also loaded, disable it: the two
   builds share a key and Chrome will not accept both.

3. **Keep the reference extension installed** in the same profile. The probe compares against it, so
   the baseline scenarios need it present and enabled.

4. **Register `hallpass` in this project only.** `.mcp.json` here is the single registration; if
   another project registered it, remove it there (`claude mcp remove hallpass` inside that
   project) so sessions elsewhere do not spawn their own servers.

That is the whole setup. From then on: open Chrome with the shortcut and say so.

## Running the probe

```powershell
$env:HALLPASS_CDP_ENDPOINT = "http://127.0.0.1:9222"
$env:HALLPASS_REFERENCE_EXTENSION_ID = "<the baseline extension's id>"
npm run probe:004 -- --slice S3     # one slice
npm run probe:004 -- --all          # every slice, S0 through S6
```

Both variables are needed for **every** run, not just the parity slices: the baseline extension's id
is not in this repository (it belongs to a third party), and the environment check reports "reference
extension id not configured" as a problem — and the runner refuses to start while any problem stands.

`--slice` and `--all` are mutually exclusive and one of them is required. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | the run completed; read the report for the verdict |
| 1 | a scenario failed — the slice is not done |
| 2 | the run was refused before it started (no slice given, or `HALLPASS_CDP_ENDPOINT` unset) |

## Reports

Each run writes `reports/004-<timestamp>.md` **and** the matching `.json` in this directory: the
environment table (browser version, extension ids, bridge install, `claude` CLI version), the
baseline source, and one row per scenario. The verdict is `done` only when every scenario passed; a
`not-run` scenario names why it did not run and blocks delivery until it is re-run.

`scenarios/` holds the scenario files, one JSON per scenario, named `s<slice>-<name>.json`. A file
carries the prompt, the answer schema, the page, which of the owner's failures it reproduces
(`evidence`), how it is judged (`expect`), any browser preparation (`setup`), and its own quota
bounds. The S0 files are written to **fail on the 003 build**: they are the "before" measurement and
they are re-run unchanged as the S1–S3 acceptance scenarios, so the run that proves a fix is the same
run that measured the failure. Editing an expectation to make a slice pass defeats the instrument.

### Baseline source — settled 2026-09-09 (T085)

R-118 left open whether a non-interactive session can call the *reference* extension's tools and use
them as the baseline. It cannot: the reference is installed and enabled, but it publishes no MCP
server, so a `claude -p` session sees `mcp__hallpass__*` and nothing matching
`mcp__claude-in-chrome__*`, and both attempted calls answer `no-such-tool`
(`scenarios/s0-baseline-source.json`). R-118's fallback is therefore in force: tree scenarios are
judged against the browser's own accessibility tree read over this same debugging session
(`baseline.ts`), and every report says `baselineSource: browser-tree`.

### Pairing — accepted by the probe, never by you

`pairing.ts` accepts on your behalf over CDP, so no scenario ever waits for a click. It writes the
paired agent into the extension's durable pairing state through the agent worker's own DevTools
socket. One limit is worth knowing: a *pending* prompt can only be answered through the side-panel
port, which refuses any sender that has a tab, and a side panel needs a real user gesture to open —
so the helper cannot dismiss a prompt that is already on screen. That is not a gap in the probe, it
is the E2 measurement: whether the call that raised the prompt survives the wait.

### Quota

Every session is bound by `--model sonnet --effort low --max-turns 12 --max-budget-usd 0.50`. The
last two travel with the scenario file, so a scenario cannot quietly become expensive.

### Sessions run in their own directories

A concurrent scenario (`concurrency: 3`) runs each session in its own temporary workspace under
`reports/.sessions/`, each with its own copy of `.mcp.json`. That is the point, not tidiness:
`claude` starts one mcp-server per session per project, which is what E1 is about.

A workspace Windows will not let go of - `EBUSY` while the finished agent process still has it as
its cwd - is retried and then **left behind**, named in the report's "Run notes". A run's observed
values are never worth a directory.

### Repeating a scenario

`repeat: 5` runs the whole scenario - its browser preparation included - five times in a row and
reports one row judged on all five (`pass` only when every run passed). It is not `concurrency`
with another name: `concurrency` starts several sessions against one preparation, which says
nothing about a claim like SC-031's "unpair, reconnect, accept after 20 s, five times".

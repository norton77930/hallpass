# Contracts — feature 008

Additions to `packages/contracts/src/agent-tools.ts` (descriptors, zod schemas, answer unions). Tool
count 29 → 31. Every new field is optional on existing answers so 005 callers keep working.

## 1. New tools

| Tool | Args | Result | Gate | Story |
| --- | --- | --- | --- | --- |
| `gif_recorder` | `{ action: "start" \| "stop" \| "export" \| "clear", filename? }` | start/stop/clear → `{ state, frames, skipped, full, alreadyRecording? }`; export → `{ filename, frames, skipped, width, height, bytes, downloadId }` | none (a recording is of the session's own tabs) | US1 |
| `dialog` | `{ tabId, action: "accept" \| "dismiss", promptText? }` | `{ ok: true, dialogId, type }` | **mode** on `accept` for confirm/prompt unless chained; never on dismiss or alert | US3 |

`filename`: `^[A-Za-z0-9 _.-]{1,80}$`, not starting with `.`; `.gif` appended; default
`agent-recording-<yyyyMMdd-HHmmss>`.

## 2. Changed tools

| Tool | Change |
| --- | --- |
| `navigate`, `tabs_close` | `force?: boolean` — leave a page that raises "leave site?"; an effect under the site mode |
| every effect, `screenshot`, `navigate`, `file_upload`, `resize_window`, `browser_batch` step | answer MAY carry `recording: { frames, full }` while a recording is open (the spec's `recording: "full"` shorthand means `recording.full === true`) |
| every tool answer that caused a dialog | MAY carry `dialog: CurrentDialog` |
| `wait` | new ending `condition-unmet { dialog }` |
| `browser_batch` | stops at the step whose answer carries `dialog` or is `blocked-by-dialog` (existing stop-at-first-failure rule) |

## 3. New refusal / blocked reasons (`agentRefusalSchema` union)

| Reason | Fields | Raised by |
| --- | --- | --- |
| `blocked-by-dialog` | `dialog: CurrentDialog` | any tool on a tab with a current dialog, except `dialog`, `tabs_context`, `downloads_context`, `wait` |
| `blocked-by-beforeunload` | `url` | `navigate` / `tabs_close` without `force` when the page asked to stay |
| `no-dialog` | — | `dialog` when none is open on that tab |
| `page-unresponsive` | — | `dialog` / forced navigate when the tab does not answer within 300 ms after the dialog was handled |
| `invalid-filename` | — | `gif_recorder export` |
| `empty-recording` | — | `gif_recorder export` with 0 frames |
| `download-failed` | `downloadReason` (the union's discriminant is `reason`, as `input-unavailable` → `unavailableReason`) | `gif_recorder export` when the browser's download fails |
| `refused` | — | `dialog accept` when the owner pressed refuse (the dialog is dismissed) |

## 4. Shapes

```ts
type CurrentDialog = {
  id: string; type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string; defaultValue?: string; openedAt: number; tabId: number;
  chainedTo?: { tool: string; approvedAt: number };
};
type RecordingState = { state: "none" | "recording" | "stopped"; frames: number; skipped: number; full: boolean };
```

## 5. Manifest (agent profile)

`permissions` = 005's set + `"offscreen"`; `version` = `"0.2.0"` (single literal, exported as
`EXTENSION_VERSION`). Narrow profile: byte-identical to 007 (contract test).

## 6. Panel messages, offscreen protocol

See `data-model.md` §"Panel messages" and §"Offscreen protocol"; both are internal to the extension and
are pinned by unit tests, not by this contract.

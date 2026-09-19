# Phase 0 Research: Local Agent MCP Bridge

Each item is a design unknown the plan front-loads. Format: Decision / Rationale / Alternatives.

## R-101 — Native messaging on Windows

**Decision**: The host is a Node script launched by a small `.bat`/`.cmd` shim (Chrome on Windows
spawns the executable named in the host manifest; a `.js` file cannot be spawned directly). The host
manifest JSON (`name`, `path` to the shim, `type: "stdio"`, `allowed_origins:
["chrome-extension://<id>/"]`) is written to a fixed app-data location, and a registry value under
`HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\<host name>` points Chrome at it. An
installer in `packages/agent-host/src/install/` writes both; an uninstaller removes both. HKCU (not
HKLM) so no elevation is needed.

**Rationale**: matches Chrome's documented native-messaging contract; per-user install avoids admin
rights; the shim indirection is the standard way to run Node as a native host on Windows.

**Alternatives**: a compiled exe (heavier build, no gain); WebSocket to a locally run server (needs a
listening port and its own auth, larger attack surface, and does not get Chrome's origin check for
free) — rejected. The reference extension's cloud-bridge WSS is explicitly out of scope (F-016 local
half only).

## R-102 — MCP stdio transport and the two-process bridge

**Decision (resolved 2026-09-08, before M2)**: Chrome always spawns its *own* native-messaging host
process when the worker calls `connectNative`; it never attaches to a process that is already running.
The MCP server, in turn, is spawned by the agent (Claude Code) and owns *its* stdio. So the bridge is
**two processes with one local link**:

- `mcp-server` — spawned by Claude Code as a stdio MCP server (`@modelcontextprotocol/sdk` `McpServer`
  + `StdioServerTransport`, tools via `registerTool` with Zod schemas, results as `text`/`image`
  blocks). It is the long-lived side. On start it listens on `127.0.0.1` on an ephemeral port and writes
  `{ port, token, pid, startedAt }` to `%LOCALAPPDATA%\hallpass\bridge.json` (mode 0600 semantics:
  the user's own profile directory).
- `native-host` — spawned by Chrome, a thin relay: reads `bridge.json`, connects to that port, presents
  the token, and from then on forwards native frames (Chrome stdio, length-prefixed) to the socket and
  back. If no MCP server is listening it answers the worker one `bridge-unavailable` control frame and
  exits; the worker retries on its next connect attempt (startup, alarm, or the panel's Connect).

Pairing identity travels agent → mcp-server → relay → worker as the `pair-request` control frame; the
worker's answer travels back the same way. The token only authenticates the relay to the server on the
loopback link; it is not the pairing (pairing is the owner's accept in the panel).

**Constraint (M2)**: one agent session per machine until the multi-session decision. `bridge.json` holds
one record, so a second `mcp-server` takes the file over (it logs `agent.bridge.record-busy` when the
record it replaces names a live process) and the relay reaches whichever server wrote it last. A server
retracts only a record carrying its own pid, so leaving is never destructive to the other session. Per-pid
records are an owner decision before US5.

**Rationale**: it is the only ordering Chrome allows; keeping the MCP server as the long-lived side
means the agent session, not the browser's worker lifecycle, decides when the bridge exists; the relay
is ~100 lines and has no policy in it.

**Alternatives**: one process (impossible, above); the worker opening a WebSocket straight to the MCP
server (no native messaging at all — fewer moving parts, but Chrome's origin check on the host manifest
is lost, a listening port is exposed to every local process, and MV3 worker lifetime around a
long-lived socket is a second unknown) — kept as the fallback if the relay proves unreliable in M2.

## R-103 — Two callers, one content runtime

**Decision**: The content runtime, target registry, action executors, description matcher and wait
evaluator are caller-agnostic and reused unchanged. The new `agent-bridge` produces the same internal
requests the `control-port` produces for the remote caller (`content.collect-page`,
`content.resolve-target`, `content.evaluate-condition`, the action-executor calls), so both callers
share one execution path and one set of tests for it.

**Rationale**: the whole point of the pivot is that the browser-side machinery is right; only the
trust model and transport change. Forking it would double the maintenance and the review surface.

**Alternatives**: a second content runtime for the agent — rejected (duplication, drift).

## R-104 — Tab-group ownership and agent-tab marking

**Decision**: Each agent **session** owns a `chrome.tabGroups` group; tabs the agent creates join it
and are titled/coloured to read as agent-controlled. The `tabs_context` tool returns only tabs in the
session's group. Ownership is held in `chrome.storage.session` keyed by session id, reconciled against
live tabs on each call (a tab the owner closed by hand is reported "gone"). Marking uses the group
title/colour, not a favicon swap (simpler, and the reference's favicon-badge is a nicety, not required
by any FR).

**Rationale**: `tabGroups` gives a visible, native boundary the owner already understands; keying on
the session keeps two agents (or two sessions) from seeing each other's tabs (SC-024).

**Alternatives**: a window per session (heavier, and the owner may want the agent in their window);
per-tab metadata without a group (invisible to the owner) — rejected.

**As built (M4)**: a session ends when the *MCP session* ends, not when the relay drops. The host
sends `stop {sessionId}` with no `callId` on `close()` and on SIGINT/SIGTERM/SIGBREAK; the worker then
removes the record and clears the group's title and colour, so the owner's tab strip stops naming an
agent that is gone and the tabs stay as the owner's. A relay dropping is explicitly *not* this - one
agent session outlives any number of relay connections (D-M3-3) - and `stop` carrying a `callId` stays
the host's per-call backstop. Chrome discards a group when its last tab leaves, so adopting into a
remembered group can throw; the manager opens and marks a fresh group in that case rather than leaving
the session unable to open another tab.

## R-105 — Screenshots

**Decision**: `screenshot`/`zoom` use `chrome.tabs.captureVisibleTab` on the agent tab's window,
returned as a base64 PNG `image` content block; `zoom` crops in the worker (no extra permission).
Capture needs `<all_urls>` **or** `activeTab`; since the agent tab may not be the active one,
`<all_urls>` (already taken for FR-045) covers it. A tab the browser will not let the extension read
answers "page not readable".

**Rationale**: `captureVisibleTab` is the MV3 way to image a tab; cropping in-worker avoids a second
permission for `zoom`.

**Alternatives**: `Page.captureScreenshot` over the debugger (would force the `debugger` permission on
every screenshot and trip Chrome's warning bar for a non-diagnostic read) — rejected.

**As built (M4)**: three things the implementation had to settle that the decision above did not.
(1) `captureVisibleTab` photographs *the active tab of a window* and there is no per-tab capture, so
an agent tab that is not active is brought to the front, captured, and the displaced tab is restored -
including after a capture that threw. The visible flicker is stated in the tool's own description.
(2) `OffscreenCanvas` and `createImageBitmap` do exist in the MV3 worker and the crop works there, but
`fetch()` of the capture's own `data:` url does **not**: the extension's CSP has no `data:` in
`connect-src`, so the fetch fails silently and every crop would come back as the whole viewport. The
bytes are decoded with `atob` instead. A crop the worker still cannot do returns the whole viewport
with `cropped: false` rather than a picture of the wrong rectangle.
(3) The relay re-frames every message under native messaging's 1 MiB limit, so a base64 image over
`SCREENSHOT_MAX_BASE64_CHARS` (700 000) is refused as `failed`/`screenshot-too-large` for that one
call. Without the bound an oversized screenshot would break the link for every later call. Raising the
framing bound is a protocol decision, still open.

## R-106 — Element references across calls

**Decision**: `read_page`/`find` mint stable references from the existing `TargetRegistry`
(`mintTargetHandle`, `readLiveTarget`); a reference names one element of one page as of one read and is
invalid once the element or the page is gone (`resolveDescription`/registry already enforce this). The
action tools accept a reference or coordinates. A stale reference answers "stale reference"
(FR-043).

**Rationale**: the registry already provides exactly this lifetime; reusing it keeps one definition of
"stale".

**Alternatives**: coordinate-only (brittle, and the reference tools return refs) — rejected.

**As built (M4)**: a ref appears on a `read_page` node only where the registry actually minted a
handle. The collector mints one only where the runtime could deliver an effect (`snapshotTarget`'s
`actionable`), so a node without a ref is this product honestly saying it cannot act on that element;
minting one for every node would advertise a capability that is not there and the agent would find out
only when the effect failed. `filter: "interactive"` keeps interactive *roles* rather than "nodes with
a ref", because the two answer different questions.

Two constraints the registry imposes on callers, both found by the M4 journeys.
(1) Re-injecting the content runtime builds a new registry and invalidates every handle, so
`agent-tools/page-binding.ts` probes first and injects only when nothing answers - the same order
`ensureContentRuntime` uses on the remote path. Before this, `find` then `click` answered `stale` on a
page that had not changed.
(2) A collection invalidates the previous one's handles (`collectPage` calls `registry.invalidate()`),
so two `find` calls cannot yield two live refs at once. An agent that needs two endpoints at the same
time - `drag` - names them as points, which go through `content.resolve-point` and register without
disturbing the registry.

## R-107 — The per-site mode gate

**Decision**: The gate lives in the worker's `router`/`agent-bridge`, not in the content runtime: an
effect tool call resolves the current page's site, reads the site mode, and either runs
(`skip-checks`, or a step of an approved plan under `follow-a-plan`), prompts the owner (`ask`, or an
unplanned step under `follow-a-plan`), or is refused. Reads and tab management skip the gate entirely.
`follow-a-plan` reuses the *shape* of 002's plan approval (an approved ordered list admits its steps)
but not its wire: here the plan is local to a session+site and is never sent to a remote service.

**Rationale**: keeping the gate at the transport boundary means the content runtime stays
caller-agnostic (R-103) and the gate is unit-testable without a page.

**Alternatives**: per-action cards for the agent (the thing the owner decided to drop, D-003-2) —
rejected.

## R-108 — Site definition and storage

**Decision**: "Site" = scheme + host (port included for the fixture origins). Site modes and the
diagnostics grant are one record per site in `chrome.storage.local` (durable, the owner's standing
decision). Paired agents are one record per agent id in `chrome.storage.local`. Live sessions and tab
ownership are in `chrome.storage.session` (die with the browser).

**Rationale**: durability matches meaning — modes and pairings persist, sessions do not.

**Alternatives**: eTLD+1 grouping (surprising for the owner; a subdomain can be a different trust
level) — rejected for the first release; can be an option later.

## R-109 — Isolating the wider permissions

**Decision**: a new `agent` value in `BUILD_PROFILES` with its own `PROFILE_PERMISSIONS` entry
(`<all_urls>`, `nativeMessaging`, `tabs`, `tabGroups`, and — behind US6 only at runtime — `debugger`,
plus `downloads`/file access for US7). `narrow` is untouched; the shipping remote-service artifact
never declares these. The manifest writer already reads the profile, so this is data, not new logic.
The 003 build sets `SHIPPING_PROFILE`/the build command to `agent`; `narrow` still builds for the
archived path's own tests.

**Rationale**: satisfies Constitution V by construction — the wider surface exists only in the profile
that needs it, and the existing profile mechanism was designed for exactly this ("a wider profile is a
second value here").

**Alternatives**: widening `narrow` (would grant the remote artifact permissions it must not have) —
rejected outright.

## R-110 — Keeping the archived path compiling

**Decision**: the remote-service modules (`control-port`, `content-broker`, `task-channel-client`,
task-mode/plan binding, the remote consent flow) stay in the tree and keep compiling under `tsc -b`;
they are simply not reached by the `agent` build's entry wiring and not exercised by the 003 build
profile. Their unit/contract tests keep running (they are green today) so the archive does not rot.
No file is deleted in 003.

**Rationale**: D-003-3 says archive, not remove; keeping them compiling means a future "give it to
other people" product can revive the remote path without archaeology.

**Alternatives**: deleting them (loses the reviewed remote-caller design) or `@ts-ignore`-ing them
(rot) — rejected.

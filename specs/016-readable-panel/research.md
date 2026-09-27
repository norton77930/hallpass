# Research: A Readable Panel (016)

Decisions R-203 – R-210. Sources: the 0.8.0 source at 5f8f27c (read 2026-09-27), the owner's
decisions D-016-1 … D-016-10, and the private reference reading for the tab-group marking (behaviour
only: one reference titles per-session groups with its product name or a session name, rotates a
fixed colour list per session and prefixes the title with an hourglass / bell / check; the other picks
a random colour per session and badges the favicon).

## R-203 — Where a session's project name comes from (FR-226)

**Found**: the host never reads its working directory today, and never asks the MCP client for
roots. Registration is user-scoped with a fixed command and no `cwd`
(`claude mcp add hallpass --scope user -- node …\mcp-server.js`), so the working directory is whatever
the client spawns the server with.

**Decision**: after `initialized`, if the client advertises the `roots` capability, ask for roots
once and take the first `file://` root; otherwise use `process.cwd()`. Keep only the last path
segment (split on both separators), trim, cap at 64 characters. Treat as *no label*: an empty
segment, a drive or filesystem root, and the user's home directory itself (a client started from
home says nothing about a project). Never log the path or the label (the host's log lines carry
event names only).

**Verification**: the harness MCP client (no roots) proves the `cwd` path; whether the owner's
Claude Code hands over its project is checked on the owner's machine at close-out (a card title is
visible proof) — recorded as an owner check, not assumed.

**Alternatives**: environment variables of the client (not standard); asking the agent to state its
project (no such tool, and it would be self-reported remote input anyway).

## R-204 — How the label reaches the worker (FR-226, compatibility)

**Found**: the relay forwards every frame after `hello` opaquely, checking only the `sessionId` claim
(`relay-mux.ts` `fromServer`); the worker's bridge tries three strict schemas and drops anything else
with `agent.bridge.frame-rejected` (`agent-bridge.ts` `onFrame`). A new optional field on `hello`
would be refused by the relay's strict `hello` parse in a 0.8.0 native host.

**Decision**: a new link frame `session-label { type, sessionId, label }` sent by the host once after
`hello-ack` (and again after a re-greeting), only when a label exists. Old worker: dropped as
unknown, card falls back to start time. Old relay: forwards it (type-transparent). Link protocol stays
2. The worker stores the label on its session record (below) and exposes it in the projection.

## R-205 — Session start time and colour survive a worker restart (FR-228, FR-240)

**Found**: `lastHelloAt` exists twice (in-memory `sessions`, and the `storage.session` session record
in the tab manager) and both are overwritten on every greeting, so neither is a start time; the
projection exposes only `lastActivityAt`.

**Decision**: the tab manager's persisted session record gains write-once `firstSeenAt`, a
`colourIndex` assigned on first sight from a persisted counter (`agentSessionColourNext` in
`storage.session`, modulo the rotation), and the optional `label`. The projection's session view gains
optional `label`, `startedAt`, `colour` (a named tab-group colour). A projection from an older worker
carries none of them and the panel falls back (no stripe, no start time — the old id title).

**Rotation**: cyan, green, purple, pink, orange, grey, blue (Chrome's tab-group colour names;
red and yellow excluded because they read as warnings).

## R-206 — The panel changes (FR-223 – FR-237)

**Found** (0.8.0): in-panel `<h1>` in `AgentShell`; `StatusRow` shows `paired[0]`'s name and one
"unpair" that unpairs every paired agent; `SessionCard` titles with the 8-hex id, always shows three
buttons (interrupt `aria-disabled`); `SiteList` renders the permissive badge, a repeated
"diagnostics granted" line, and a revoke whose visible text repeats the site. A `<details>`
idiom for technical details exists in `NotConnected`.

**Decision**:
- `AgentShell` drops the `<h1>`; `StatusRow` takes the live-session count and the paired list; its
  menu lists each paired agent with its own unpair (the message to the worker is today's per-agent
  unpair — the loop already sends one per agent).
- `SessionCard`: colour stripe (named colour → token per theme), title
  `agentName · label` or `agentName · startedAt`, subtitle (start time, held tabs), state line
  (working / waiting / idle + last action), `<details>` with the session id, buttons per FR-232–234.
  "Last action" is re-rendered by a one-minute timer in the shell (no worker traffic).
- `SiteList`: badge removed; `<select>` gets a `data-permissive` attribute styled with the warn
  token border; checkbox label text changes; the "granted" line is removed; revoke text is "revoke"
  with `aria-label` carrying the site.
- Tab-group colours are Chrome's; the panel needs matching swatches in light and dark: a token per
  colour name in `tokens.css` (light values Chrome's light palette; dark values its dark palette).

## R-207 — Tab-group title and prefix (FR-238 – FR-241)

**Found**: the marking is written only at group creation/adoption and cleared at release/end;
nothing observes working/waiting transitions. `queryAgentGroupIds()` finds groups by exact title
"Agent". The call counter (`stop.ts`) is pull-only; the worker's `notify()` fires after prompt and
session changes, not after call begin/end.

**Decision**:
- `AgentStopSignals` gains an `onChange(listener)` fired when a session's in-flight count changes;
  the runtime subscribes and calls a new *group presenter*.
- The presenter computes, per session holding a group, the wanted title: `🔔 Hallpass` if a prompt
  of that session is waiting (from the prompt controller, already read by the projection), else
  `⌛ Hallpass` if in-flight > 0, else `Hallpass`; a transition from working to idle is applied only
  after 1 s without a new call (timer per session, cancelled by a new call). It writes only when the
  wanted title differs from the last one it wrote (no churn), and sets the session colour on
  creation.
- Stale detection: query all groups and keep those whose title is in {`Agent`, `Hallpass`,
  `⌛ Hallpass`, `🔔 Hallpass`} (the set is one exported constant).
- The group title is not localised (a product name plus two symbols).

## R-208 — A keystroke that opens a dialog (FR-242, 015 review F2)

**Decision**: capture `currentDialog` before `keyboard.type` / `keyboard.press` and wrap each in the
existing `racingDialog`, branching on `"dialog" in delivery` exactly as the click path does; the
focusing click of a keyboard call is raced the same way. No new helper.

## R-209 — A hung press sends no release (FR-243, 015 review F3)

**Found**: already true — `click()` / `drag()` await `mousePressed` before `mouseReleased`, and
`dispatchInput`'s rejection aborts the sequence.

**Decision**: pin it with a unit test beside the T402 cases (hold `mousePressed`, answer late,
assert no `mouseReleased` was ever sent), plus one sentence in `dispatchInput`'s doc. No behaviour
change.

## R-210 — Pairing wait extension (FR-244, B5)

**Found**: already implemented by 011 D-011-7 (commit 667293d): `panelPresenceChanged` extends a
session raised with the short bound to the long bound measured from the raise and starts ticking; the
host's `extendPairingBound` re-arms from `requestedAt`, and the progress text switches to the
panel-not-seen sentence. The open item recorded on 2026-09-23 predates that commit.

**Decision**: measure first — a worker unit test (raise with panel visible → presence lost at 30 s
→ expect bound 120 s from raise, ticks started) and a host test (ticks with a larger bound re-arm
from `requestedAt`). If both are green, record "covered by D-011-7" in coverage and change no code;
only a red test opens a fix.

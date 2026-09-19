# Research: Reference Parity for the Local Agent Bridge

Numbering continues from 003 (R-101–R-110). Each item resolves a design unknown of
[plan.md](./plan.md) with a decision, not a guess. Reference behaviour is cited only through
`docs/design-notes.md` (evidence ids G1–G12, N1–N2); no reference code is used.

## R-111 — Bridge topology for concurrent sessions (G1, G2, G11)

**Decision**: invert the loopback link. The **relay** (the process Chrome spawns for the extension's
native port) becomes the long-lived listener: it opens an ephemeral loopback port, writes `bridge.json`
(`{port, token, relayPid, startedAt}`), and accepts **any number** of mcp-server connections. Each
mcp-server (one per Claude Code session) dials the relay, sends `hello {sessionId, agentId, token}`, and
keeps dialling every 5 s while no relay answers. The relay multiplexes by connection: it forwards frames
to the worker unchanged (every frame already carries `sessionId` or `callId`), keeps
`sessionId → connection` and `callId → connection` maps, and routes worker answers back by those keys.

**Rationale**: this is the observable model of the Codex reference (one browser-side connection,
N sessions by id, G1) and it removes the two 003 defects at once: there is exactly one writer of
`bridge.json` (the relay) so last-writer-wins disappears, and a session that starts while others run
simply connects rather than replacing the record. The 5 s dial loop is the reference's reconnect cadence
(G2). Retrying from the server side also makes worker restarts cheap: Chrome respawns the relay, the
relay writes a new record, every server dials it within 5 s (FR-057's 10 s bound with margin).

**Consequences**:
- The worker learns of a session's end from the relay (`session-ended {sessionId}` when a server's
  socket closes) and releases it within 15 s (FR-058). When the *relay* dies (worker restart), nobody can
  tell; on the next relay start the worker waits 15 s for each stored session's `hello` and releases the
  ones that do not return (G11 "peer gone ⇒ release", bounded).
- `hello` is authenticated by the relay's token from `bridge.json` plus the bearer `agent-id` (003
  assumption, unchanged). The record is user-readable; any process running as the owner could connect,
  which is 003's accepted model.
- Pairing is per `agentId`, not per session: a second session of an already-paired agent never prompts
  (003 SC-020 holds).

**Alternatives considered**: (a) keep servers listening and make `bridge.json` a directory of per-pid
records the relay polls and dials — more moving parts, the relay must watch a directory and hold N client
sockets, and stale records still need liveness checks; (b) a `bridge-busy` refusal for every session but
one — rejected by the owner (D-004-2); (c) the extension itself listening (WebSocket from the worker) —
rejected in R-102 and still not possible (an extension cannot listen).

## R-112 — Pairing inside one call (G3, FR-059)

**Decision**: raise the pairing request at MCP session start (`initialize`), not only on the first
tool call, and while a tool call waits on a pending pairing send MCP progress notifications every 5 s.
The in-call wait bound becomes 45 s by default, overridable, and always at least 30 s (FR-059). The
probe's S2 scenario (accept after 20 s) is the acceptance evidence.

**Rationale**: E2 happened because the owner's reading time counted against the caller's own bound.
Raising the prompt at `initialize` puts the owner's decision *before* the first call in the common case
(the agent initialises the server as the session starts, well before it uses a tool). Progress
notifications are the MCP-standard way for a server to say "still working"; where the client honours
them the call bound is reset, where it does not the 45 s default still leaves the owner 20 s with margin
under a 60 s client bound. Neither reference determines a pairing bound; the spec sets it.

**Alternatives considered**: shortening the wait (makes E2 worse); answering "pairing pending, retry"
immediately (the owner explicitly wants the same call to succeed).

## R-113 — One debugger attachment, two traced uses (G6, G7, FR-064/065/071)

**Decision**: browser-level input uses the `debugger` permission 003 already declares. Attachment is
per held tab, made lazily on the first effect and kept while the session holds the tab; it survives
same-tab navigation. Diagnostics (003 US6) keep their own rule — the console/network/runtime domains
are enabled only under the per-site diagnostics grant and disabled on site change — but they share the
attachment. If attaching fails (developer tools open on that tab, a restricted page), every effect on
that tab answers `failed/input-unavailable` with the reason; no silent fallback to page-level events.
The browser's "is being controlled" notice is accepted (D-004-4).

**Rationale**: 003 already proved on the attach-mode probe that the extension's debugger attachment
coexists with the gate's own remote-debugging client, so the acceptance environment does not conflict
with it. Detaching on every navigation (003 C1) was right for a *grant* that is per site; input is
gated per effect by the site mode, and the attachment itself exposes nothing. One attachment avoids the
attach/detach churn that would otherwise happen between a click and a console read.

**Alternatives considered**: page-level synthetic events (003 today; cannot make hover real — G6);
attaching per effect (attach latency on every click, and Chrome's notice flickers).

## R-114 — Reading every frame (G5, FR-063)

**Decision**: the agent build declares its page reader as a **content script** (`all_frames: true`,
`match_about_blank: true`, `run_at: document_start`) in addition to the dynamic injection 003 uses,
and only in the `agent` profile so the narrow manifest is untouched. The worker enumerates a tab's
frames with the scripting API's own all-frames execution, which returns a result per frame carrying its
id — **amended 2026-09-10**: the original text said `chrome.webNavigation.getAllFrames`, but that API is
absent from the agent build and adding it would mean a new permission and an exemption from the scope
guard, for information the permission we already hold can give. Least privilege (Constitution V) decides
it. The worker asks each frame's runtime for its subtree, and merges
them into one tree in frame order; every node carries the frame it belongs to; frames that do not answer
within a bound are listed as `not-readable` and the read still succeeds. Effects on an element inside a
frame resolve to **top-level viewport coordinates**: the frame's runtime reports the element's rect in
its own viewport, and the worker adds the frame-owner offsets it obtains once per frame through the
debugger's frame-owner and box-model queries (cached until that frame navigates). Coordinates are what
browser-level input takes (R-113), so no cross-frame message routing is needed for effects.

**Rationale**: this is the reference's observable shape — the reader lives in every frame from load,
and effects are addressed to the tab by coordinates, which is why the reference needs no frame id on
an effect (G5). Owner offsets through the debugger are exact where matching iframe elements by URL is
not (srcdoc and `about:blank` frames have no distinguishing URL).

**Alternatives considered**: injecting into `allFrames` dynamically on each read (works for reads,
but frames created after the read are missed until the next read, and `document_start` presence is
what lets the persistent registry of R-115 exist before the agent's first read); routing clicks as
messages into the frame's runtime (keeps synthetic events — rejected by R-113).

## R-115 — References that live as long as their element (G8, FR-066)

**Decision**: each frame's runtime keeps a **persistent registry** for the life of its document:
an element is assigned a reference the first time it is collected and keeps it; the registry holds
elements weakly and prunes disconnected ones on every collection; a reference is `stale` when its
element is no longer connected or the document is gone. References are opaque strings that encode the
frame and the registry index (`f<frame>-<n>`), minted by the worker so the agent never sees a raw
frame id. A read or a find adds to the registry; it never replaces it.

**Rationale**: the reference's observable behaviour (G8) is that a reference survives later reads
until the element is gone, and 003's own change log called the per-read replacement a limitation to
remove. The weak-holding registry is the only way to keep references stable without keeping removed
elements alive.

**Alternatives considered**: a per-read generation number the agent must pass (still invalidates on
each read); resolving by re-collection and structural match (can silently land on another element,
forbidden by FR-066).

## R-116 — Capacity, fields and the viewport filter (G9, FR-067)

**Decision**: raise the read bounds in the contracts to the reference's — default depth 15, up to
10,000 nodes and 50,000 text characters per answer, `max_chars` as a caller argument up to that
ceiling — and extend the node shape with `href`, `type`, `placeholder`, `options` (for selects) and
`frame`. The interactive read lists only nodes whose box intersects the viewport; the full read lists
all. Truncation reports the limit that applied, as 003 does. Answers flow worker → host, which is the
native-messaging direction with the large message limit; the host → worker direction (1 MB per message)
carries only requests and stays far below it.

**Rationale**: G9 is measured by SC-036 (node count within 10% of the reference on the same page) —
the bounds are what make that possible. The message-direction note is what makes 10,000 nodes safe.

## R-117 — The owner's tabs, leases and the indicator (G4, FR-060–FR-062)

**Decision**: a **tab lease** record (`tabId → {sessionId, kind: owner|agent, since}`) in
`chrome.storage.session` is the single source of "who holds what". `tabs_context` lists every tab
with `holder: this|<sessionId>|none`. A new `tabs_claim {tabId}` tool leases an unheld tab: the tab
joins the session's group, gets the indicator, and from then on is the session's; a held tab answers
`refused/held-by-session {sessionId}`. Reads and effects check the lease (replacing 003's group-only
check). The indicator is a small in-page element the agent build's content script shows on held tabs,
with one control; a **trusted** click on it sends the worker "bring the main tab forward", and the
worker activates the session's main tab (its most recently acted-on tab) and focuses that window.

**Rationale**: leases are the Codex reference's observable model (G4); the indicator and its control
are Claude in Chrome's, and the reference's control responds only to a trusted user event, which is
also what keeps a page script from steering the owner's focus (spec edge case). Listing without
content is what D-004-3 allowed.

## R-118 — The acceptance probe (US1, D-004-6)

**Decision**: `tests/acceptance/probe-004/` is a Node script that (1) checks preconditions — the
owner's Chrome 152 reachable at `HALLPASS_CDP_ENDPOINT`, the agent build loaded, the bridge installed, the
reference extension present; (2) for each scenario spawns the coding agent non-interactively:
`claude -p --model sonnet --effort low --output-format json --json-schema <schema as JSON text>
--mcp-config <path> --strict-mcp-config --allowedTools "mcp__hallpass__*,mcp__claude-in-chrome__*"
--max-turns <n>` with the prompt on **stdin**, running the **baseline through the reference's tools
first** and then the same steps through `hallpass`, returning structured JSON; (3) for
multi-session scenarios spawns two or three such agents concurrently; (4) writes
`tests/acceptance/probe-004/reports/004-<timestamp>.md` (+ `.json`) with browser version, per-scenario baseline,
observed, verdict and the agent's raw answers on failure.

**Risk and fallback**: whether the reference's tools are available to a non-interactive agent session
is verified first thing in S0. If they are not, the baseline for tree scenarios is taken from the
browser's own accessibility tree through the gate's debugging session on the same page (the same
source the reference reads), and the report says which baseline was used. Either way the owner runs
nothing.

**Quota**: sonnet, low effort, `--max-turns` and `--max-budget-usd` per scenario, and the probe runs
only on slice delivery.

**Flag set verified against Claude Code 2.1.266 on 2026-09-09 (B3)**: `-p`, `--model`, `--effort`,
`--output-format json`, `--mcp-config`, `--strict-mcp-config` are as assumed. Three corrections:
`--json-schema` takes the schema **as JSON text**, not a file path (a path fails with "not valid
JSON"); `--max-turns` exists but is hidden from `--help`; `--allowedTools` does accept wildcard
patterns, so no concrete tool list is needed. The prompt goes on stdin.

**Alternatives considered**: a headless MCP client harness (003's) as the caller — cheaper, but it
cannot reproduce E1 (per-session server spawning) or the client's own call bound (E2), which is
exactly what the owner wants proven.

## R-119 — The phantom cursor (FR-064)

**Decision**: the agent build's content script draws a small cursor marker in the top frame, positioned
by worker messages before each pointer effect and hidden a moment after the last one; it is
`pointer-events: none`, in the top document only (coordinates are top-level), and never part of any
read. **Rationale**: the reference shows a cursor overlay (G6); it also makes the owner's "what is the
agent doing" question answerable at a glance.

## R-120 — The position-based tool (G10, FR-069)

**Decision**: one tool, `computer { action, x, y, text?, key?, amount?, ms? }`, with actions
`screenshot | left_click | right_click | double_click | triple_click | type | key | scroll | wait`,
delivered through the same input path as the element tools (R-113) and gated as an effect whose prompt
carries a crop of the screenshot around `(x, y)`. Positions outside the viewport are refused with the
viewport size. **Rationale**: the reference's shape (G10); reusing the input path means the tool is a
thin contract addition once S4 exists.

## R-121 — Keeping the archive guard

**Decision**: every new manifest entry (content script, indicator) and every new worker module lives
behind the `agent` profile and the agent worker entry, as 003 did; the narrow manifest's byte-identity
and the 001/002 suites remain the archive guard and are part of every acceptance run (SC-038).

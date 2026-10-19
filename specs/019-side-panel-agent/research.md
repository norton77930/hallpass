# Research: A Conversation in the Side Panel with the Owner's Own Coding Agent (019)

Decisions for `spec.md` (approved 2026-10-18). Evidence: two ACP spikes on 2026-10-18 (both agents
start, answer, take a mode, resume through `session/load`; slim adapters run against the installed
command-line tools), a Windows process-tree measurement, a duplicate-tool spike, and readings of the
reference products and of open-source local-agent front ends (private evidence 004 and the 019 handoff
record). File:line references are to `worktree-feature-019-side-panel-agent` @ 9567963.

## R-312 — Topology: a broker process the relay starts, reached over the existing link

**Decision**: the relay (`native-host.ts`) starts one broker process (`broker.js`, new entry in
`packages/agent-host`) after its ack, or adopts the one already running for the same browser run (see
the lifetime anchor below). The broker does not talk to the relay
through pipes: it dials the relay over the loopback link exactly as an mcp-server does
(`bridge-link.ts` `dialRelay`), with a `hello` whose new optional `role: "broker"` field tells the worker
what it is. From there the relay routes broker frames by `sessionId` like any session
(`relay-mux.ts:270-273`), unchanged. Conversation frames are a new frame family on the link (R-323).

**Lifetime anchor (architecture review, finding 1)**: the relay's lifetime is *not* the browser's —
Chrome recycles the worker and the native host with it (`browser-run.ts:11-12`,
`agent-runtime.ts:131-148`). So the broker is anchored to the **browser run** (`browserRunId`), not to a
relay: a relay on ack reads the sidecar `brokers\<browserId>.json` `{ pid, browserRunId }`; alive and same
run → it adopts the running broker (sends it its new record over a fresh attested start, below);
otherwise it spawns one. When a relay leaves on stdin end it tells the broker "relay gone"; the broker
redials for up to 15 s and continues only if a relay acks with the same `browserRunId`, otherwise it
shuts down (and the job ends the tree). A worker recycle therefore leaves running agents running
(FR-295); closing the browser ends them within ~15 s (FR-296). T571 measured 15.8–16.4 s to zero processes in 10/10 closes. T572 (owner, 2026-10-19): the window stays 15 s for 0.13.0; a worker the browser recycles can come back up to 30 s later, after the broker ended, and the conversation then continues on the next message with its history. Next release: the broker also watches the browser's main process, ending at once when it is gone and waiting longer (35 s) when only the relay went.

**Attested broker (finding 2)**: the relay's link token only proves same-user file access and the run
id is readable in `browsers\<id>.json`, so a `hello` cannot prove it comes from the broker. The relay
passes a random secret on the broker's **stdin** at spawn (never in the environment or a file) and
writes only its SHA-256 into the `brokers\<browserId>.json` sidecar it owns. A relay that adopts the
broker after a recycle has no pipe to it, so it checks the greeting's secret against that hash and
the sidecar's pid against a live process. Only a greeting carrying the right secret may carry
`role: "broker"`; the relay strips the secret as
it strips `token` (`relay-mux.ts:185`) and refuses `role` on any other greeting (new log code). That is
link admission, not policy. Boundary: a process of the same Windows user that rewrites the sidecar can
still pose as a broker — the same boundary as today's link token; what the secret removes is the
cheaper path of copying public fields into a greeting. The worker accepts one broker session per relay run and `conversation-*`
frames only from that `sessionId`.

**Why**: the relay stays a forwarder with no policy (`native-host.ts:52-55`); its new duties are
process ownership (spawn/adopt) and admission of its own child. Reusing the link means one transport, one routing rule and the existing per-session
ownership check (`relay-mux.ts:209-213`). One broker per browser follows from one relay per browser
(018 R-266); each browser's panel runs its own conversations (spec edge case).

**Rejected**: (a) the relay hosts the agents itself — puts policy and long-lived state into the
forwarder; (b) the worker spawns the agents — an extension cannot spawn processes; (c) a broker that
outlives Chrome (Q4 option C, out of scope); (d) stdio pipes between relay and broker — a second
transport and a routing branch in the relay.

## R-313 — Process cleanup: the broker joins its own kill-on-close job (owner, 2026-10-18)

**Decision**: the broker's first act is to create a Windows job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign itself to it, and only then spawn anything; every agent,
adapter, the agent's own tools and their children inherit membership. The job handle is never shared,
so it closes when the broker dies by any means, and Windows ends the whole tree. The three Win32 calls
go through the new runtime dependency **koffi** (MIT; owner chose option A over a PowerShell holder and
over `taskkill`). First layer: when no relay of the same browser run re-attaches within 15 s
(R-312), the broker cancels turns and closes agents gracefully within 3 s; the job is the backstop for
crashes and hard kills.

**Measurement (2026-10-18)**: Chrome launches the native host with no job of its own and does not end it
on exit (Chromium's Windows launcher sets no job; the 33 job handles Chrome holds are single-process
renderer sandboxes). Node's own per-process job (flags `0x3C00`: breakaway allowed, kill on close) lets a
`cmd.exe`-launched child and a `detached` child survive a hard kill of the broker — exactly the
`codex.cmd` shape. A dedicated kill-on-close job wrapping the broker ended all 8 processes of the test
tree, including those paths. The self-assign variant uses the same mechanism; S2 measures it.

**Packaging**: koffi ships one prebuilt `.node` per platform; the package carries only win32-x64. The
Vite host bundle keeps koffi external and the zip gets `host/node_modules/koffi` (contract
`qa-package` pins change, R-327).

**Rejected**: (b) PowerShell + `Add-Type` holder that starts the broker suspended — works (it is what
was measured) but adds a PowerShell start and compile to every Chrome start, and is blocked by
Constrained Language Mode; (c) `taskkill /T` plus heartbeat — nothing runs when the broker itself
crashes, and children whose parent already exited are missed; (d) rely on Chrome — measured, it does
nothing.

## R-314 — Connector install: `npm ci` against a lockfile Hallpass ships

**Decision**: for each agent Hallpass ships a tiny `package.json` + `package-lock.json` pinning the
adapter (`@agentclientprotocol/claude-agent-acp` 0.81.2, `@agentclientprotocol/codex-acp` 1.13.1) and
their dependency trees. On the owner's consent (FR-299) the broker runs the installed Node's npm:
`npm ci --omit=optional --ignore-scripts --no-audit --no-fund` in a staging folder
`%LOCALAPPDATA%\hallpass\agents\<agent>\.staging-<random>`, then renames it to
`agents\<agent>\<adapterVersion>`. `npm ci` verifies every tarball against the lockfile's `integrity`
hashes, so nothing unpinned or altered is used; any failure deletes the staging folder (FR-300). The
panel shows npm's byte progress as an indeterminate bar with the expected size (57–77 MB measured).

**Why**: integrity checking, proxy and certificate settings come from the tool the owner already has;
`--omit=optional` leaves out the bundled CLI (the B2 spike); `--ignore-scripts` means no install script
runs. Hallpass writes no download or hashing code of its own (none exists today).

**Data transmitted**: requests to the npm registry the owner's npm is configured for; no Hallpass data.
Disclosed on the first-use card.

**Rejected**: Hallpass fetching tarballs itself (new HTTP + hash + extract code); bundling the
adapters in the zip (286–440 MB with bundled CLIs; 60–80 MB slim for owners who may never use them);
`npx` on demand (unpinned resolution, slow every start).

## R-315 — Finding the installed agent and telling "missing" from "mismatch"

**Decision**: the broker finds Claude Code as `claude.exe` and Codex as `codex.cmd` through `where.exe`
on the user's PATH, then the known per-user install locations. Missing → the panel's install guidance
(FR-301). Found → `--version` is read and shown; the adapter starts with `CLAUDE_CODE_EXECUTABLE` /
`CODEX_PATH` set to the absolute path. If `initialize` or the first `session/new` fails, the panel says
"tested with <agent> <tested version>, found <found version>" plus the agent's own error text (with
secret-like values redacted, R-326). There is no hard version range: later versions are accepted while
they work (spec Assumptions).

**Evidence**: without the variables, the Claude adapter fails at `session/new` ("native binary not
found … set CLAUDE_CODE_EXECUTABLE") and the Codex adapter at `initialize` ("Missing optional dependency
…"), both clean, so the failure step distinguishes a missing variable from a version problem.

## R-316 — Modes: allow-list, set before every first prompt, watched for drift

**Decision**: the offered modes are an allow-list per agent — Claude Code: `default` (strict), `auto`
(the agent's own review); Codex: `read-only` (strict), `agent` (the agent's own review). After every
`session/new` and `session/load` — including the automatic resume after the idle limit — the broker
sets strict (FR-289 covers resumed conversations too; the owner switches again if wanted) and confirms the returned current mode before
releasing the owner's message (FR-289). **Any** `current_mode_update` the owner did not cause with
`set-mode` — outside the allow-list *or inside it* (an agent can switch itself to its review mode, for
example on leaving a planning step; architecture review finding 5) — makes the broker cancel a pending
action, set the owner-chosen mode again, and tell the owner. Modes the adapter advertises but that are not in the
allow-list are never shown (FR-292, SC-140).

**Evidence**: spike: the Claude adapter starts in the owner's own `auto`; `session/set_mode` to
`default` and Codex to `read-only` both took effect before the prompt.

## R-317 — Permission answers: the broker owns "for this conversation"

**Decision**: the card's three answers map to the adapter's options as: allow once → the adapter's
allow-once option; reject → its reject-once option; allow for this conversation → **allow once to the
agent** plus a broker-side rule for that conversation keyed by the request's tool kind
(`edit`, `execute`, `delete`, `move`, `fetch`, `other`). Later requests of that kind in that
conversation are answered allow-once by the broker without a card and are listed as "allowed by your
rule". The adapter's "always allow" options are never sent.

**Why**: an agent's "always" can persist outside the conversation (for example into the project's
local settings file), which would break FR-291 ("ends when the conversation ends"). Keying by kind is
the narrowest rule the protocol describes for every agent. The rule lives in the broker's memory and
is not resumed: a resumed conversation asks again (safe direction).

**To confirm in S4**: the exact option ids each adapter sends for edits and commands, from live
requests; whether either adapter raises permission requests for MCP tools (Hallpass's own would then be
asked twice — the agent's card and the site gate — and the broker answers allow-once for `hallpass`
tools, leaving consent to the site gate); rules of kind `other` are keyed by tool name, not by kind
(finding 7); and that neither adapter has a permission timeout that turns into an answer (FR-294,
finding 9).

**Codex strict and edits inside the folder (finding 8)**: in the spike Codex's `read-only` asked only
for edits outside the folder and for network access; the spec discloses this (FR-293), but SC-135 ("no
file edit … without the owner's answer") then holds for Codex only outside the folder. S4 measures it
and the owner decides at the plan gate whether SC-135 is restated for Codex.

**Measured in S4 (T541, 2026-10-19)**: Claude Code 2.1.302 with claude-agent-acp 0.81.2, Codex 0.162.1
with codex-acp 1.13.1, strict mode set and confirmed, one tiny prompt per case in a fresh folder
outside any repository, every card answered reject-once.

| Case | Claude `default` | Codex `read-only` |
| --- | --- | --- |
| create a file in the folder | **no card**, file written | card (`edit`), refused, no file |
| run `echo` | **no card**, ran | no card; the sandbox failed the command |
| call a tool of a session MCP server | card (`other`, title = tool name) | card (`execute`, title = `mcp.<server>.<tool>`) |
| card left unanswered 130 s | — (no card raised) | still waiting; answered late, no timeout |
| agent-initiated mode change | none seen | none seen |

Option ids: Claude `allow-once`/allow_once, `allow-with-updates`/allow_always, `reject`/reject_once;
Codex `allow_once`/allow_once, `allow_for_session` or `allow_session` or `allow_always`/allow_always,
`cancel`/reject_once. The broker's kind-based mapping holds for both; it never picks allow_always.

- **Codex**: the spike's in-folder edit finding did not reproduce — `read-only` asked before writing a
  file in the folder and its sandbox refused a direct shell write. SC-135 holds for Codex as written.
  **Superseded by T573 (same day, codex-cli 0.163.0)**: 10/10 in-folder writes and changing commands
  ran with no card. The T541 card was the Windows sandbox failing on 0.162.1 ("command failed; retry
  without sandbox?"), not a designed ask: codex-acp 1.13.1's `read-only` mode is on-request + reviewer
  user + `workspaceWrite` with the cwd writable, sent on every `turn/start`, so config overrides
  (`CODEX_CONFIG`, `-c`) lose to the per-turn values and 0.163.0 rejects `approval_policy="untrusted"`.
  Spike (5 paid turns): a Hallpass shim behind `CODEX_PATH` that rewrites only the strict signature's
  `turn/start` to `sandboxPolicy: readOnly, networkAccess false` makes Codex ask (`execute` card) for
  both a file write and a shell write in the folder, reject honoured; agent mode and the owner's MCP
  servers unchanged. Decision (owner, "measure then fix"): ship the shim (D-019-12 for Codex). Limits:
  commands matching the owner's own Codex `prefix_rule ... allow` still run without a card; the broker
  must never answer Codex's allow-always (`accept_execpolicy_amendment` writes the owner's rules).
  Review fixes (ea7c010): the shim rewrites every policy-bearing `turn/start` except the exact agent
  tuple (fails closed), Codex does not start when the adapter's modes differ from the measured ones,
  strict declines Codex's request for wider sandbox permissions with a notice, and no mode records a
  conversation rule for it. Live on branded Chrome 155 (2026-10-20): 3/3 strict in-folder writes raised
  a `Run command` card, reject left no file, allow once wrote it (D-019-13).
- **Claude**: `default` does not ask when the owner's own settings already allow the tool. Panel
  conversations load the owner's settings (D-019-5), and an owner whose `permissions.allow` lists
  `Edit`/`Write` (as this machine's does) gets no card in strict mode; Claude also treats `echo` as
  read-only. The owner's global instructions apply too (a panel conversation called the owner's
  notification tool, as their terminal sessions do).
- **Session ask rules**: passing `_meta.claudeCode.options.settings = { permissions: { ask: ["Edit",
  "Write", "NotebookEdit", "Bash", "PowerShell"] } }` on `session/new` makes `default` raise a card for
  the same file write and the same `echo` (options only allow-once / reject), while the owner's MCP
  servers, hooks and instructions still load. The same rules in `auto` also raise a card for the edit,
  so they cannot stay on in the agent-review mode. The adapter rebuilds its query when `settings`
  changes on `session/load`, which is the seam for switching them on and off with the mode.
- MCP tools: both agents ask before a session MCP server's tool, so the broker's plan to answer
  allow-once for the `hallpass` server (consent stays with the site gate) is needed for both.

## R-318 — Conversations at run time: the broker keeps the live state, the panel reattaches

**Decision**: the broker holds, per running conversation, an in-memory event log of the current run
(text chunks, tool calls and their updates, cards, mode changes), capped at 256 KB per conversation
with the oldest text coalesced (frames are capped at 1 MB on the pipe and the loopback,
`native-frame.ts:14,24`; finding 4). A panel document that (re)connects asks for a **paged,
per-conversation** snapshot (`{ conversationId, fromSeq, events, more }`, each page ≤ 256 KB) and then
receives the live stream (FR-295, FR-288). The worker forwards pages and never accumulates content. Text chunks are coalesced to at most one frame per 50 ms per
conversation. Nothing of this is written to disk (D-019-6).

Idle (FR-297): no running turn, no waiting card, no message for 10 minutes → the broker closes that
agent; the conversation stays in the index; the next message resumes it through `session/load` with
the agent's replay. Cap (FR-311): at most three running agents per broker; a fourth evicts the one
idle longest; if none is idle the panel says so. Unexpected exit (FR-298): the conversation says so and
offers "continue", which resumes; nothing retried on its own.

## R-319 — Index, folders and scratch: broker-owned files

**Decision**: `%LOCALAPPDATA%\hallpass\conversations.json` (index, D-019-6) and `folders.json` (the
owner's folder list) — one writer, the broker, temp + rename like `bridge-link.ts:50-70`. Scratch
folders `%LOCALAPPDATA%\hallpass\scratch\<conversationId>\`, never deleted by Hallpass (D-019-8).
Index entry pruning (50 entries / 30 days) happens on every write. A `session/load` refused by the
agent for an unknown session marks the entry "cannot continue" (FR-304). Several browsers (018) share
the files; the broker of each browser re-reads before writing and writes atomically; conversations are
listed in every browser but a running one belongs to the broker that started it: an entry carries a
`lease { browserRunId, pid, at }` while running, and `open` in another browser is refused with
`in-use-elsewhere` while the lease pid is alive (finding 6); the lease is cleared on idle stop and
shutdown, and a dead pid's lease is ignored.

**Why host files, not `chrome.storage`**: the broker needs the index to resume without the panel open,
and folder paths are host facts; the extension never needs the paths except to show them.

## R-320 — The folder picker is a Windows dialog the broker opens

**Decision**: the panel's "Add folder" asks the broker, which opens the Windows folder dialog through a
short PowerShell `FolderBrowserDialog` on a top-most owner window, and returns the chosen absolute path
(or cancel). One dialog at a time per broker.

**Why**: the extension's directory picker returns a handle, not a path, and an ACP working folder must
be a path. PowerShell's dialog needs no dependency; it is a one-off action, so the start cost does not
matter (unlike R-313's per-start cost).

**Risk**: the dialog can open behind Chrome; the top-most owner is the mitigation, verified in S7.
Under PowerShell Constrained Language Mode (the reason R-313 rejected a PowerShell holder) the dialog
cannot be created; then the panel offers typing or pasting a path instead, checked for existence
(finding 10). This is a fallback for locked-down machines only; the dialog stays the normal path
(D-019-9).

## R-321 — The panel agent's browser connection: a per-conversation token

**Decision**: for each conversation the broker mints a random token, registers it with the worker over
the link (`conversation-browser-token`), and passes Hallpass's own mcp-server to the agent through
`session/new` `mcpServers` with that token in its environment. That mcp-server's `hello` carries the
token in a new optional field; the worker marks a session whose token matches a live conversation as a
*panel session*: admitted by the one-time panel consent instead of pairing (answering the
`agent-runtime.ts:1888-1891` check), labelled with the conversation, given its own tab group. Every
other rule — site modes, consent cards, plans, `decideGate` — applies unchanged (FR-307). Withdrawing
the consent (FR-309) revokes every panel token; their sessions get "not admitted" at once. The token
dies with the conversation's agent.

**Panel server identity and browser (finding 3)**: the broker also sets `HALLPASS_PANEL_BROWSER` to
its own `browserId`. An mcp-server with a panel token uses the agent id `panel:<conversationId>`
(never the shared per-user `agent-id`, `mcp-server.ts:516`), dials only that browser's record and never
reads the remembered browser choice or raises a browser-choice card (018). The worker answers its pair
request with an accepted result without touching `agentPairings` (`pairing-controller.ts:128`); the
pairing checks at `agent-runtime.ts:1804`, `:1888` and the server's wait (`mcp-server.ts:2536`) branch
on `kind === "panel"` → consent granted + token live. The status row's "unpair" does not touch panel
sessions. Withdrawal (FR-309) runs the same teardown as an unpair (`agent-runtime.ts:2802-2843`:
prompts, plans, debugger, tab groups) for every panel session, then revokes the tokens.

**Token hygiene (finding 11)**: the token is never stored (`tabs.announce` persists session records
without it, `agent-runtime.ts:2261`) or logged; it is valid for one agent run and revoked when that
agent exits, so a token that lands in the agent's own transcript through its environment is dead.

**Why**: admission rides on a secret the worker issued to an attested broker (R-312), not on a claim a
process makes about itself; an external agent cannot become a panel session by setting a flag.

**First browser action** (FR-306): the panel sends the active tab id with each message; the broker
passes it to the worker as the conversation's *start tab*, and the worker places that tab into the
panel session's group on its first browser call of the turn (the existing claim path, without a card,
because the owner sent the message from that tab).

## R-322 — The owner's own "hallpass" entry inside panel conversations

**Decision**: the broker supplies Hallpass's mcp-server under the **same name, `hallpass`**, in
`session/new` `mcpServers`, so the session's entry replaces the owner's for that session only; nothing
in the owner's settings is edited and the owner's other servers stay (D-019 edge case: the panel agent
runs with the owner's own settings).

- **Claude Code**: nothing else needed. The adapter applies session servers after the owner's, and the
  same name wins: live, the owner's `hallpass` was never started and the only `hallpass` tools were the
  session's. (The adapter's option to withhold *all* the owner's servers exists and is not used.)
- **Codex**: the adapter by default *drops* a session server whose name the owner's config already has;
  the broker starts it with `DISABLE_MCP_CONFIG_FILTERING=true`, and then the session entry wins (live).
  Two consequences, both handled:
  1. Codex deep-merges the two entries, so keys of the owner's entry the session entry does not set leak
     in (measured: an `env` key). The broker's entry sets every field it relies on explicitly (`command`,
     `args`, `env` with the token, `cwd`, `enabled: true`, startup and tool timeouts); a leftover `url`
     in the owner's entry would conflict with a command entry → the broker then falls back to the name
     `hallpass_panel` and tells the agent in the instructions to use only that one (FR-305's fallback).
     How the worker recognises and ignores the owner's own `hallpass` started inside that conversation
     (a marker variable the broker sets on the adapter, if Codex passes it to its servers) is
     **Behavior not confirmed** — measured in S8; until then the fallback shows the pairing card as for
     any agent, labelled with the conversation's folder.
  2. After the first turn the adapter starts a title-generation thread without the session's servers,
     which starts the owner's own servers. The broker sends `/rename <title>` as the conversation's first
     input (answered locally, no model call); live, this kept the extra thread from starting.

**Amended in S8 (T566, 2026-10-19)**: the pinned Codex adapter (codex-acp 1.13.1) passes only
`command`, `args` and `env` of a session server and ignores `_meta`, so `cwd`, `enabled` and the
timeouts cannot be set from the session: those keys of the owner's `hallpass` still merge in. The one
adapter-level route, the `CODEX_CONFIG` variable, replaces all `mcp_servers` and is written to the
adapter's startup log, which would put the browser token in a log file — rejected. The broker instead
reads the owner's user-level Codex config read-only (`broker/codex-config.ts`; no value leaves the
module) and falls back to `hallpass_panel` whenever the owner's entry cannot be merged over safely: an
HTTP key (`url`, bearer token, headers) or `enabled = false`. Under the fallback the mcp-server adds a
second instructions line naming the server to use. Not read: a project-level `.codex/config.toml` and
multi-line or nested inline tables. `/rename <index title>` is sent only for a run that began with
`session/new` (a resumed thread never starts a title thread). Measured in T567: whether merged owner
keys change the panel server, whether Codex shows server instructions to the model, and the marker
variable.

The token also travels in the ACP `mcpServers[].env` the agent receives (T558 S3), so it may reach the
agent's own command line or debug logs beyond the mcp-server's environment; Hallpass cannot prevent
that, and the token is revoked when the run ends. T567 records where it actually appears.

**Measured in T567 (2026-10-19, Claude Code 2.1.303 + claude-agent-acp 0.81.2, codex-cli 0.163.0 +
codex-acp 1.13.1, owner-approved spend, six turns)**:
- The owner's own `hallpass` was never started in a panel conversation, with either agent (Claude: the
  owner's user-scope entry; Codex: a command-type stand-in, also not started by the title thread). The
  agent saw one set of 37 browser tools, the session's.
- Codex merges the owner entry's `env` keys into the panel server (as expected from the S8 amendment);
  the panel server runs in the conversation's folder with Codex's base environment plus the entry's.
- With a `url` owner entry the broker fell back to `hallpass_panel` (37 tools under that name) and no
  pairing card appeared; the url entry starts no process.
- Codex does not pass server instructions to the model (asked directly, it answered "none", although
  `initialize` returns them); Claude quotes them. Under the fallback the tool names alone separate the
  two servers.
- A variable set on the adapter reaches every MCP server under Claude but **none** under Codex (Codex
  builds a server's environment from its base list plus the entry's `env`), so a marker cannot identify
  the owner's server; the "ignore pairing requests carrying it" step is dropped. The fallback's pairing
  card, labelled with the conversation folder, stays the answer.
- The token: Claude — the panel server's environment and `claude.exe`'s command line (the adapter
  passes `--mcp-config` JSON; readable by the owner's own processes), in no file; Codex — the panel
  server's environment only. Revoked when the run ends.

**Evidence**: duplicate-tool spike 2026-10-18 (handoff record, private), Claude `hallpass` and Codex
same-name stand-ins (the owner's Codex config has no `hallpass` today).

**Rejected**: a distinct name for everyone (the owner's `hallpass` stays visible and would ask to pair);
withholding all the owner's servers (changes the owner's agent in the panel; not possible for Codex).

## R-323 — Link frames: a new family, protocol stays 2

**Decision**: conversation frames between worker and broker are new frame types on the link
(`conversation-*`, contract in `contracts/conversation-frames.md`), each carrying the broker's
`sessionId` so the relay routes them unchanged. `hello` gains optional `role` and `panelToken`.
`AGENT_LINK_PROTOCOL` stays 2 under the evolution rules at `agent-tools.ts:3296-3307`; a 0.12 relay
never starts a broker, so a 0.13 worker simply sees no broker and the Conversation tab says the host
needs updating.

## R-324 — Panel ↔ worker: new panel commands and a conversation projection

**Decision**: the panel port gets `ui.conversation.*` commands (start, send, stop, answer card, set
mode, open, remove, add/remove folder, install agent) and a `conversation` part of the panel message;
the worker forwards to the broker and fans the broker's stream out to every panel document
(`agent-panel-port.ts` broadcast, FR-288). The worker holds the conversation overview (no content) and
forwards log pages on request; it accumulates no conversation content (R-318).

## R-325 — Layout and remembered tab

**Decision**: `AgentShell.tsx` keeps `PromptCard` and `NoticeCard` (lines 258, 264) above a tab bar;
today's composition (265-318) becomes the Connections & sites tab unchanged (FR-282, FR-310). The last
tab is remembered in `chrome.storage.local` key `agentPanelTab` (the panel has no persisted UI state
today). The count on the Connections & sites tab is the number of pairing requests, browser choices
and notices waiting (FR-284).

## R-326 — The owner's own settings run inside panel conversations; redaction

**Decision**: the first-use card says the panel agent runs with the owner's own instructions, tools and
hooks for that agent (spike: Claude and Codex both start the owner's MCP servers and hooks even with an
empty `mcpServers`). Hallpass does not edit those settings. Text Hallpass shows from an agent's error
or stderr passes through a redactor for URLs with credentials (`scheme://user:pass@`) and long
token-like values; the broker's log keeps the same redaction. Stderr is never shown by default, only
the agent's own error message.

## R-327 — Package, install, uninstall

**Decision**: the zip gains `host/broker.js`, `host/node_modules/koffi` (win32-x64 only) and
`host/agents/<agent>/package.json` + `package-lock.json` (R-314). `install.ps1` is unchanged except for
the new required files; `uninstall.ps1` removes `conversations.json`, `folders.json`, `agents\` and
`broker.log`, and **keeps** `scratch\` (D-019-8) and says so. The contract pins in
`qa-package.contract.test.ts:71,101-102` change with this plan.

## R-328 — Site-mode changes record who made them

**Decision**: `siteModeRecordSchema` (`agent-tools.ts:3704-3708`) and the stored record
(`site-mode-store.ts:71`) gain optional `changedBy: "panel-agent" | "external-agent" | "owner"` and
`changedAt`, in the same commit (the store re-validates with the strict schema at `:94`, so an unknown
key would drop the record). The writers set it: the site list and every consent card answered for a
panel session → `panel-agent` when the card was raised by a panel session, `external-agent` when by an
external session, `owner` for a change from the site list itself. A return to "ask" still deletes the
record (`:188-190`); "ask" is the default and needs no author. The site list shows "changed by …"
(FR-308). Old records without the field read as before.

**Why three values**: 7-1b (later) needs to know which *surface's* request led to an allow; a change the
owner made directly in the list belongs to neither surface.

## R-329 — Testing the agent side without paying for every run

**Decision**: a fake ACP agent (`tests/harness/fake-acp-agent.ts`) speaks the protocol subset the broker
uses (initialize, session/new, load, set_mode, prompt, cancel, request_permission, session updates,
mode drift, crash) and drives the unit, relay-process and packaged-gate tests. Real agents run only in
the release probe `S19` (paid, owner-approved per release) and in the S2/S4 measurements.

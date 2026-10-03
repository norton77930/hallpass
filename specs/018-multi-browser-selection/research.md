# Research: Several Browsers, One Bridge (018)

Decisions for `spec.md` (draft, 2026-10-03). Evidence for the reference behaviour: private evidence
004 §3h. File:line references are to the tree at `next-round-followups` @ e9070df.

## R-266 — Topology: one relay per browser, one record per browser, a session dials only its browser

**Decision**: every browser keeps its own relay (Chrome spawns one native host per browser anyway).
Each relay writes only its own record, `%LOCALAPPDATA%\hallpass\browsers\<browserId>.json`. An
mcp-server lists that directory and dials only the relay of the browser its session resolved to.
`relay-mux.ts` is unchanged: one native port, N sessions of that browser.

**Why**: routing becomes "which socket", so a session's frames cannot reach another browser's worker —
no shared process decides where an action runs (the R2 property of D-018-9). Every file keeps one
writer (the 004 lesson: an N-writer `bridge.json` broke multi-session, `bridge-link.ts` header).
Closing a browser touches only its relay and the sessions bound to it (US5.3); there is no leader to
hand over.

**Rejected**: (a) a hub relay with spoke relays forwarding their native port — leader election inside
processes whose lifetime Chrome controls, every browser's sessions detach when the hub's browser
closes, and the hub must rewrite frames by browser (the relay "forwards unchanged, carries no policy",
`native-host.ts` header); (b) every server dials every relay — each `hello` registers a session in
every worker (`agent-runtime.ts` ~2143), so cards and tab groups would appear in every browser
(contradicts FR-279); (c) a standalone broker daemon — nothing on Windows starts it; new install and
lifetime surface.

## R-267 — Supersede becomes per browser; `bridge.json` stays for old servers only

**Decision**: a relay exits only when its own `<browserId>.json` names another live pid of the same
browser (the worker-restart replacement of 004/T169) or on a protocol mismatch; another browser's
record never causes an exit. `bridge.json` is still written for mcp-servers older than 018 (FR-278) by
the first live relay, with today's ownership rule (`relay-ownership.ts` `decideOnAck` + sidecar); a
relay that does not own it keeps serving through its own record instead of standing by. The link
protocol stays 2: the server ↔ relay leg keeps its shape; every addition is a new file, a new frame
type or an optional field (`agent-tools.ts` ~2986-3000 records the same reasoning for earlier
additions).

## R-268 — Browser identity lives in the extension, per profile

**Decision**: a random identifier minted on first run, kept in `chrome.storage.local` (survives
restarts and updates; per profile by construction), modelled on `browser-run.ts` (which is per run, in
`storage.session`). Kind from the user-agent brands (plus Brave's own marker): chrome, edge, brave,
chromium, unknown. The name the owner sets is stored beside it. Identity and name ride on `relay-ack`
as optional fields; the relay writes them into its record. An old extension sends none: the relay
names the browser `run-<browserRunId>` (or `pid-<pid>`), marks it legacy, and offers no in-browser
choice for it.

## R-269 — Default names are computed in one pure function

**Decision**: `defaultBrowserNames(browsers)` in `packages/domain`: the kind's display name, numbered
by connection order when two connected browsers share it ("Chrome", "Chrome 2"). Both the agent's list
(server) and the panel's peers row (relay → worker `browser-peers`) use it, so the agent and the owner
always see the same name. Numbering can shift when the first browser closes; agents act on
identifiers, never names (tool descriptions say so).

## R-270 — The mcp-server resolves the browser before anything runs

**Decision**: the server is the only process that sees the agent, the session and every browser. A
pure `resolveBrowser({connected, sessionChoice, remembered})` answers `use(id)`,
`refuse-not-chosen(list)` or `refuse-disconnected(name, list)`, evaluated in `placeCall`
(`mcp-server.ts` ~1792) before pairing (~1832) and before any dial — until a browser is resolved,
nothing exists in any worker (FR-272: refused before anything runs). With exactly one browser the
server dials at `initialize` as today (SC-131). A session that started with one browser and sees a
second connect keeps the first for the rest of the session (pinned, not remembered), so a working
session is never suddenly refused.

## R-271 — The remembered choice is a host file keyed by agent

**Decision**: `%LOCALAPPDATA%\hallpass\browser-choice.json` `{choices: {agentId: browserId}}`, written
temp-then-rename. Several servers may write it and the last writer wins — which is exactly "the
browser chosen last". Nobody dials it and it claims no liveness, so it cannot repeat the 004 failure.
It cannot live in an extension: no single browser spans the choice. Note: `agentId` comes from one
`agent-id` file per LOCALAPPDATA (`host-paths.ts` ~62, `mcp-server.ts` ~475-497), so today it is one id
per machine user, shared by every MCP client — see "Owner questions" in plan.md.

## R-272 — Per-browser state in the server; tab identifiers carry their browser

**Decision**: the server's link becomes a map by browser; pairing state, worker features and the
browser run are kept per browser (today singletons, `mcp-server.ts` ~537-550, ~625-666), so a new
browser asks for pairing again (FR-275). On a switch the old link drains its running calls, then
closes; the mux then ends the session in the old worker (releasing its tab group); the screenshot
cache is cleared. Chrome tab ids are small per-browser integers that can collide: the server records
which browser issued each tab id (from `tabs_*` answers) and refuses, before forwarding, a `tabId`
issued only under another browser; element refs ride on tab ids and fail the same way (FR-276).

## R-273 — Browser tools answered by the host; the in-browser choice coordinated by the server

**Decision**: `list_browsers`, `select_browser`, `request_browser_choice` are host-answered (like
`upload_image`, `tool-offering.ts` ~61-67): always offered, no pairing, exempt from FR-272. The
in-browser choice is coordinated by the requesting session's server (it holds the 2-minute bound): it
opens choose-only links (`hello.intent: "choose"`, no session card, no tab group) to the browsers whose
record advertises the feature; the first confirm settles, records the choice, and withdraws the other
cards; decline everywhere or the bound ends with "no browser chosen". The worker side is a card
controller mirroring the pairing card with withdraw (015), with the existing prompt-waiting, badge
and closed-panel rules.

## R-274 — Stand-by is retired, not kept as a fallback

**Decision**: remove the stand-by branch and the cross-browser exit in `native-host.ts`, narrow
`decideOnAck` to legacy `bridge.json` ownership, remove the worker's stand-by status, backoff cap,
persisted record and panel text, and the `relay-standby` frame from the contract (a 0.10.x relay that
still sends it to a new worker is dropped as an unknown frame, harmless).

## R-275 — Uploads and FR-275 (open)

The "from now on" upload directories live in the machine-wide `config.json` (`upload-config-store.ts`,
014 FR-194). FR-275 says upload approvals stay in their browser. Either key the directories by browser
(slice S7) or amend FR-275 to say the directory list is the machine user's, not a browser's. Owner
question 4 in plan.md.

## Architecture review of this plan (2026-10-03): sound with changes — applied below

## R-276 — Same-browser replacement is keyed on the run, not on the browser identity (review M2)

**Decision**: a relay exits only when its own `<browserId>.json` names another live pid **with the same
browser run id** (the worker-restart replacement of 004/T169, as `decideOnAck` keys it today). Same
`browserId` with a different run id and a live pid/port is an **identity collision** (a copied profile
directory, a machine image): the newer relay does not write, sends `browser-identity-conflict` to its
worker, and the worker mints a new identity (keeping the name with a numbered suffix). Without this,
two live browsers sharing one id would replace each other in a loop — the 2026-10-02 flap on the new
file. Relay process test in S2.

## R-277 — The legacy record during an upgrade (review M3)

**Decision**: (a) a new server also reads `bridge.json` and lists it as one legacy browser when its
pid is alive and its port is not already in a per-browser record — routing is still "which socket";
this keeps a browser whose relay predates 0.11.0 (Chrome keeps the relay it spawned for the browser's
life, `native-host.ts` ~226-228) visible until its worker restarts. (b) every 0.11.0 relay polls
`bridge.json`: absent or dead pid → claim it; another live pid → leave it; a relay that loses the
claim race keeps serving through its own record and never exits for it.

## R-278 — When the browser is resolved (review M4, M1)

**Decision**: the resolver runs (1) at `initialize`, deciding whether and what to dial (today
`startLink` runs at `oninitialized`, `mcp-server.ts` ~1924-1933, and the greeting already registers a
session in the worker, `agent-runtime.ts` ~2137-2157); (2) on every dial attempt (the directory replaces
the single record read at `bridge-link.ts` ~416 / `mcp-server.ts` ~1811); (3) in `placeCall`, which is
where a refusal is answered. A session is **pinned at its first forwarded call** (or pairing request),
not at dial: before that, a change in the connected set re-resolves and an idle link to the wrong
browser is drained (it only removes an idle session card). Once pinned (or after a select), an absent
pinned browser is `refuse-disconnected` regardless of how many others are connected — after waiting the
existing attach bound (`waitForAttach`, ~1811-1824), so a worker recycle (the relay retracts its record
on stdin end, `native-host.ts` ~475-481) does not produce a refusal. This replaces R-270's "pinned at
start".

## R-279 — Smaller decisions from the review

- Choice links (in-browser choice) use a derived session id: a `hello` with a live session id replaces
  the existing connection (`relay-mux.ts` ~165-171). The record's "can show the choice card" flag comes
  from the worker's ack features, not from the relay's version (new host + old extension is routine).
  `hello.intent` is sent only to relays whose record carries the flag (an old relay's strict parse would
  refuse it).
- The remembered choice is one file per agent (`choices/<agentId>.json`), so adding keys later (owner
  Q5) cannot lose updates.
- The worker's identity read uses the relay's ack bound (10 s), not the 1 s run-id bound; a new worker
  with no identity yet is "not yet published", not legacy — otherwise a slow `storage.local` read
  creates a second, run-scoped entry for a browser that has a proper record.
- Sweeping a dead-pid record is read-then-delete; it is safe only because each owning relay keeps the
  `absent → republish` repair for its own record (as `native-host.ts` ~238-246 does for `bridge.json`).
  Directory listing matches `*.json` exactly (temp files are `X.json.<pid>.<rand>.tmp`). Pre-0.10.0
  extensions (no run id on the ack) get `pid-<pid>` identities that change on every worker restart.
- `relay.log` lines carry the browser id on `relay.started`; `relay-started.recordPath` is the
  per-browser record; uninstall removes `browsers/` and `choices/`.

## Security review of S4a + S4b (T507, 2026-10-03): pass with fixes

- M1 (fixed in the review round): a screenshot answered by the old browser after `select_browser`
  could be carried into the new browser by `upload_image`; cache entries now carry their browser.
- m1 (recorded, not fixed): the legacy `bridge.json` entry is one pseudo-browser (`legacy-bridge`)
  that names whichever 0.10.x relay holds the record. With two 0.10.x browsers, a bound session can
  move to the other one when the holder exits inside the attach bound — the same behaviour as 0.10
  (FR-278) and gone once both browsers run 0.11.
- m5 (recorded): two concurrent `select_browser` calls of one unbound session can leave the session's
  binding and the remembered file disagreeing (last completion wins); agent-induced, same agent.
- m2, m3, m4 fixed in the review round (batch / new-tab provenance, select during close, Windows
  reserved device names).

## Final code review (T515, 2026-10-03): pass with fixes

Fixed in the review round: identity-conflict + failed re-mint no longer reconnects without backoff
(M1); a relay being replaced ignores renames (m1); choice cards cleared when a fresh relay starts
(m2); the panel-closed attention sentence on an unanswered choice (m3); a foreign record counts as
live only when its pid is alive **and** its port answers (m4); legacy-record wording (m6).
Recorded, not fixed: m5 — a worker whose identity read outlasts the 9 s ack bound is published as a
legacy (`run-…`) browser for that link (no in-browser choice, remembered choice does not match) until
its next reconnect; rare (slow `storage.local`).

## T513 regression finding (2026-10-03): no ack without identity

The single-browser regression showed relays published as legacy (`run-…`) browsers 9 s after start —
a worker whose `storage.local` did not answer acked without identity (the m5 gap), and the ghost record
next to the real one made agents see two browsers. R-279 is now implemented as written: a worker that
has an identity store never sends `relay-ack` without `browserId`; an identity read that does not
answer within 3 s (or fails) drops the port and reconnects through the normal backoff (not reset while
the read keeps failing), so the relay publishes nothing for it. A worker with no identity store acks
as before.

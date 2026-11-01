# Research: Extra MCP Servers for Side-Panel Conversations

## R-417 — Where the list lives

**Decision**: `panel-mcp-servers.json` in Hallpass's data folder (`%LOCALAPPDATA%\hallpass`), shared by every
browser's broker on the computer, as 024 R-375's shared files are. `{ "servers": [ ... ] }`, written to a
temp file and renamed. Unreadable or invalid: the page says so, conversations get no extra server, and a
save is refused until the owner removes the file (nothing silently overwrites it).

## R-418 — What a server is (FR-425, FR-431)

`name` 1-40 of `A-Z a-z 0-9 _ -`, not starting with `hallpass` in any case (the browser entry is
`hallpass`, or `hallpass_panel` beside an owner's Codex `hallpass`), unique ignoring case; `command` 1-400 chars;
`args` up to 30 of up to 400 chars; `variables` up to 10 names (`[A-Za-z_][A-Za-z0-9_]*`, up to 100);
`agents` a non-empty subset of Claude Code, Codex, Hermes (D-027-1). At most 10 servers.

## R-419 — Handing them to a session (FR-426, FR-427, FR-428)

**Decision**: when a run starts (`start`, so also a resume and a mode restart) the conversation reads the
list once and keeps the entries for that run; every `session/new`, `session/load` and `session/resume` of
the run carries the browser entry (when it has one) and then the extras ticked for its agent, each as a
stdio server `{ name, command, args, env }` where `env` holds the named variables that are set in the
broker's environment, with their values. A variable not set is left out. DeepSeek takes no servers
(023 R-365) and gets none. A running conversation keeps its run's list until it continues again.

**Rationale**: one read per run, so a list changed mid-run does not hand a session/load a different set
than its session/new had.

## R-420 — Codex (edge case)

Codex deep-merges a session entry over the owner's entry of the same name (019 R-322). An extra whose
name matches an owner Codex entry that cannot be merged over (a URL server, or one switched off) is not
handed to Codex, and the row says so. `codex-config.ts` reads an entry by any name for this.

## R-421 — Check (D-027-2, FR-432)

**Decision**: the broker starts the server with the same command, arguments and environment a
conversation would hand, through the MCP SDK's stdio client (which runs a `.cmd` such as `npx` on Windows),
initialises, lists the tools and closes; then ends the process tree (an `npx` leaves children). Bounded at
30 s. Works: up to 50 tool names and the count. Failed: the first line of the error or the server's last
stderr line, with every variable's value removed, up to 300 chars. Kept in the broker's memory with the
time; the page shows the last result per server, and `checking` while one runs.

## R-422 — What the page sees (FR-428, FR-430)

Each server as stored, each variable as `{ name, set }`, the last check, and `codexSkipped` when R-420
applies. Never a value. The agents that take servers are Claude Code, Codex and Hermes; the page says
DeepSeek takes none.

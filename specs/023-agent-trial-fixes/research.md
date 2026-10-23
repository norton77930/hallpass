# Research: Fixes from the Owner's First Hermes Trial (023)

All Hermes facts are from reading the Hermes Agent 0.22.2 source (tested version, D-021-2); Hallpass facts
from this branch. Nothing was run for this research. File references to Hermes are relative to its
source tree.

## R-363 — The saved-logins tool can only be removed with Hermes' whole `browser` group (D-023-1)

- **Finding**: Hermes has no per-tool switch. Tools are removed only by tool group through
  `agent.disabled_toolsets`, which in ACP mode filters the direct tools, the look-up-on-demand catalog,
  the look-up call gate and the tool list rebuilt after MCP registration (model_tools.py 336-337, 718-720,
  741-744; tool_search.py 532-538; acp_adapter/server.py 458-461). `browser_vault` is not a group name, and
  an unknown name is skipped silently in ACP's quiet mode (model_tools.py 308-310) — this is why 0.15.1's
  setting did nothing. The tool is registered in group `browser` (tools/browser_vault_tool.py 657-664). Its
  own availability check cannot be switched off without also hiding the other browser tools, and Hermes'
  own vault is always on (config_defaults.py 2452-2464).
- **Decision**: the Hallpass-owned settings layer disables group `browser` (in place of `browser_vault`) in
  both modes: strict `[terminal, code_execution, delegation, browser]`, automatic `[browser]`.
- **Consequence**: Hermes' own browser tools (its navigate, snapshot, click, type, scroll, back, press,
  images, vision, console, cdp, dialog, vault, exec) are also gone. They drive a browser Hermes starts
  itself, not the owner's browser; from the panel the browser is Hallpass's (its `hallpass` tools, which
  are an MCP server and not in group `browser`). Web search is a different group and stays.
- **Rationale**: the only removal that covers every path the agent could reach the tool by. A managed list
  replaces the owner's own list rather than merging (config.py 1496-1501), so the managed layer must carry
  every group it needs; the owner's settings stay untouched.
- **Risk kept in view**: a managed file Hermes cannot parse is ignored (fail-open, managed_scope.py 86-93),
  so the written text is pinned by a unit test and the real tool list is measured (R-364).
- **Alternatives rejected**: a per-tool deny list (does not exist); making the tool's availability check
  fail (also hides the other browser tools and depends on the owner's machine); leaving the group on and
  relying on the asking card (the tool reads saved secrets; the promise is that it is never offered).

## R-364 — Measuring the real tool list without a model call (FR-363)

- **Decision**: a scratch measurement runs Hermes' own interpreter from the owner's Hermes installation with
  `HERMES_MANAGED_DIR` pointing at a copy of each Hallpass layer, and lists the names Hermes would offer
  directly and in its catalog for the ACP tool set; plus one live ACP start per mode where Hermes' log line
  "refreshed tool surface (N tools)" is read from the agent's output (R-367). Acceptance: `browser_vault`
  absent in both modes, `hallpass` tools present when the `mcp` component is installed. Kept under
  `.scratch/023`, not shipped (it depends on the owner's installation).
- **Alternatives rejected**: asking the model to list its tools (costs calls, the answer is not evidence).

## R-365 — Knowing whether an agent took the browser tools (D-023-2, FR-364)

- **Finding (Hermes)**: Hermes answers `session/new` (and `session/load`) only after it has tried to start
  every MCP server it was given (acp_adapter/server.py 445, 611-614). Without the optional `mcp` component it
  gives up with a debug-level log only and never starts the server (mcp_tool_discovery.py 541-543); nothing
  in the ACP reply says so.
- **Finding (Hallpass)**: the `hallpass` server an agent starts greets the relay with the conversation's
  panel token; the extension's service worker already maps that greeting to the conversation
  (agent-runtime.ts 2462-2497, panel-sessions.ts 21-47). The broker sees nothing of it today.
- **Decision**: the service worker tells the broker when a conversation's browser server greets (new
  frame, R-368). After the session is created or loaded, the broker waits up to 10 s for that frame; if it
  does not come, it raises a `browser-tools-missing` notice with an agent-specific hint. DeepSeek's
  description says it takes no MCP servers, so its notice is raised at once without waiting. The check runs
  only for agents whose description says they should take them and are known to start them during session
  creation (Hermes); Claude and Codex are not checked in 023 (FR-374, no false alarms). One notice per
  conversation.
- **Alternatives rejected**: reading Hermes' log lines (version-specific text, default level does not say
  "skipped"); asking Hermes whether `mcp` is importable (Hermes-specific, misses other causes such as a
  blocked server entry).

## R-366 — The tab as a file for agents without page context (D-023-3, FR-365/366)

- **Decision**: when the agent does not accept embedded context, the broker writes the tab's title, address
  and text into a UTF-8 `.txt` file in the same `hallpass-attachments` folder as attached files (name from
  the tab title through the existing name sanitiser, `.txt` added, numbered on collision) and names it in
  the same text block as files. The `attachment-not-accepted` refusal for tabs is removed; the image refusal
  stays. The panel stops greying "current tab" for such agents. Agents that accept page context keep the
  resource block (no change). Same expiry and cleanup as files (attachments.ts).
- **Alternatives rejected**: inlining the tab text in the message (long pages swamp the message and the
  conversation history); a separate folder (two cleanup paths).

## R-367 — Agent output kept for diagnosis (D-023-8, FR-371/372)

- **Finding**: agents are started with their error output discarded (conversation.ts 426-436). Hermes
  writes at info level to it, including provider error text that is not redacted
  (agent/api_error_summary.py 194-199, 226) and child-server output tails (mcp_tool_discovery.py 229-240).
  Values from Hermes' own `.env` are loaded inside Hermes, so the broker's environment does not hold them.
- **Decision**: read the error output into a per-run ring of the last 50 lines, each line cut to 500
  characters, each passed through both `withoutEnvironmentValues` (values of the environment the agent was
  started with) and `redact()` (token- and key-shaped text). The stream is always drained so the agent never
  blocks on a full pipe. Never logged, never written; dropped when the run's conversation is removed or the
  broker exits. The panel asks for it with a new request and shows it in the conversation details.
- **Risk**: R1 (secret handling, lifecycle). Key-shaped text that matches no pattern could remain;
  mitigation: show only on request, never persist, review.

## R-368 — Contract additions (version-paired, additive)

- Worker → broker: `conversation-browser-attached { conversationId }`.
- Broker → panel notice codes: `browser-tools-missing` (with agent id; hint chosen by agent),
  `key-env-not-in-browser` (with the variable name only).
- Panel → broker `ui.conversation.diagnostics { conversationId }` and the reply
  `{ conversationId, lines: string[] (≤ 50, each ≤ 500) }`.
- All `strictObject`; contract tests pin the new enums. Panel and host versions stay paired.

## R-369 — A key variable the browser cannot see (D-023-6, FR-369/370)

- **Finding**: Hermes reads the variable name from `model.key_env` (or `model.api_key_env`) in
  `config.yaml` in its home (`HERMES_HOME`, otherwise `%LOCALAPPDATA%\hermes`) (hermes_cli/auth.py 357-404;
  config.py 431-433; hermes_constants.py 51-58, 111-169). Hermes also loads `.env` from that home at start
  (acp_adapter/entry.py 81-91), so a key kept there reaches it regardless of the browser.
- **Decision**: only when a Hermes start or first turn fails with an authentication or model-setup error,
  the broker: reads the variable **name** from the owner's Hermes `config.yaml` (only the `model:` block's
  `key_env`/`api_key_env` line, no YAML library); checks the name is absent from its own environment and
  not defined in Hermes' `.env` (names only, line prefixes); lists the **names** under the current user's
  environment settings; if the name is there, adds `key-env-not-in-browser` with the name. Values are never
  read into Hallpass: the names come from a query that returns names only.
- **Alternatives rejected**: passing the key through (changes the credential path, R2); re-reading the
  environment in the broker (needs the value).

## R-370 — Waiting feedback (D-023-5, FR-367/368)

- **Decision**: panel-only, no contract change. The starting line shows for every agent with the agent's
  expected first start (Claude/Codex/Hermes "30–60 s"; DeepSeek keeps "a few minutes"). From the moment a
  message is sent until the first update of that turn (message text, thought, tool call or permission
  card), the turn shows "Waiting for the model… N s" (seconds, updated each second, announced politely to
  screen readers only at 30 s), and from 30 s on the server/VPN hint. Any update clears it; Stop stays.
- **Alternatives rejected**: a broker timer (the panel already knows send time and updates).

## R-371 — The agent's thought ends the wait (FR-368, amends R-370)

- **Decision**: the broker dropped `agent_thought_chunk`, so a reasoning model's thinking never ended the
  wait and the 30 s hint fired while it thought. Additive event `{ type: "activity", activity: "thinking" }`
  (strictObject, never the thought's text), sent once per live turn on its first thought (none in a
  replay or after Stop); the panel takes it as the turn's first update and shows a muted "Thinking…"
  while it is the conversation's newest item. `plan` updates stay dropped.

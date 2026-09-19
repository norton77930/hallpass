# Contracts: Local Agent MCP Bridge

Three closed boundaries, all defined in `packages/contracts/src/agent-tools.ts` (Zod), consumed by the
host, the worker bridge, and the tests. Behaviour is normative; field names are indicative.

## 1. The MCP tool surface (agent ⇄ host)

Each tool is one `registerTool` with a Zod input schema; results are MCP content blocks (`text`, and
`image` for screenshots). Grouped by user story. "Gate" = whether the per-site mode applies.

| Tool | Args (indicative) | Result | Gate | Story |
| --- | --- | --- | --- | --- |
| `tabs_context` | — | list of `{ tabId, url }` in the session group | none | US1/US4 |
| `tabs_create` | `{ url? }` | `{ tabId }` | none | US4 |
| `tabs_close` | `{ tabId }` | `{ closed }` | none | US4 |
| `navigate` | `{ tabId, url \| "back" \| "forward" }` | `{ url }` or failure | none | US4 |
| `resize_window` | `{ tabId, width, height }` | `{ width, height }` | none | US4 |
| `get_page_text` | `{ tabId }` | `{ text }` (bounded) | none | US2 |
| `read_page` | `{ tabId, filter?, depth?, ref? }` | element tree with refs, truncation noted | none | US2 |
| `find` | `{ tabId, query }` | up to N `{ ref, role, label }`; `no-match`; `too-broad` | none | US2 |
| `screenshot` | `{ tabId, region? }` | `image` (PNG) | none | US2 |
| `click` / `right_click` / `double_click` / `triple_click` | `{ tabId, ref? , x?, y? }` | `{ observed }` | **mode** | US3 |
| `hover` | `{ tabId, ref?, x?, y? }` | `{ observed }` | **mode** | US3 |
| `drag` | `{ tabId, from, to }` | `{ observed }` | **mode** | US3 |
| `type` | `{ tabId, text }` | `{ observed }` | **mode** | US3 |
| `key` | `{ tabId, key, modifiers?, repeat? }` | `{ observed }` | **mode** | US3 |
| `scroll` | `{ tabId, direction, amount?, x?, y? }` \| `{ tabId, ref }` | `{ observed }` | **mode** | US3 |
| `form_input` | `{ tabId, ref, value }` (text/bool/option) | `{ value }` | **mode** | US3 |
| `browser_batch` | `{ tabId, steps: ToolCall[] }` | ordered results; stops at first failure | **per step** | US5 |
| `wait` | `{ tabId, forMs }` \| `{ tabId, condition, ref?, maxMs }` | `condition-met` \| `bound-reached` | none (Stop ends it) | US5 |
| `read_console` | `{ tabId, pattern? }` | matching messages | **diagnostics grant** | US6 |
| `read_network` | `{ tabId, pattern? }` | matching requests | **diagnostics grant** | US6 |
| `evaluate` | `{ tabId, expression }` | result; visible effects still gated by mode | **diagnostics grant** | US6 |
| `file_upload` | `{ tabId, ref, paths[] }` | `{ files }` | **mode** + allowed path | US7 |

Rules that hold for every tool:

- Every call names a `tabId` in the caller's session group, or is refused (FR-034).
- One call in flight per tab; a second is `busy` (FR-043).
- A reference that no longer resolves is `stale` (FR-043).
- A restricted page answers `not-readable` (reads) / `not-actionable` (effects) (FR-039).
- An effect under `ask` prompts the owner and runs only on yes; a `no` or no answer runs nothing
  (FR-041, SC-023).
- No tool result claims an effect that was not observed (FR-040), reusing the 002 executor evidence.

## 2. The native frame (worker ⇄ host)

Length-prefixed JSON both ways. Request `{ callId, tool, tabId?, args }`; response
`{ callId, outcome, result? }` where `outcome` is the ToolCall outcome enum. Control frames on the
same channel: `pair-request`/`pair-result`, `unpair`, `stop`. The host never logs page-derived content;
only stable codes (`agent.call.completed`, `agent.pair.requested`, …), mirroring the remote proxy's
redaction test.

## 3. The site-mode contract (worker ⇄ side panel)

Projection to the panel: per site `{ site, mode, diagnosticsGranted }` and the list of paired agents
and live sessions with their tabs. Commands from the panel: `set-site-mode`, `grant-diagnostics`,
`revoke-diagnostics`, `accept-pairing`, `decline-pairing`, `unpair`, `stop`. The panel is the only
place a mode or a pairing changes; the agent can never change its own mode.

## Test obligations (traced in tasks)

- **Contract tests** (`tests/contract/agent-*.contract.test.ts`): every tool arg/result schema
  round-trips; the native frame rejects unknown fields; the outcome enum is closed; the site-mode
  projection is closed.
- **Unit tests**: the router's one-in-flight-per-tab and correlation; the site-mode gate for each mode;
  the tab manager's group ownership and stale/gone; the pairing reducer's pending→paired→unpaired.
- **Packaged attach-mode journeys** (`tests/e2e/packaged/agent-*.spec.ts`): one per story; SC-020–027
  each map to at least one journey.
- **Headless host harness** (`tests/harness/mcp-client.ts`): drives the host over stdio without a
  browser, to prove the MCP surface independently of Chrome.

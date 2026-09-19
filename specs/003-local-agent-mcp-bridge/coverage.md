# Coverage map: Local Agent MCP Bridge (T069, SC-022)

What proves each part of this feature, recorded on 2026-09-08 against the run whose numbers are in
[quickstart.md](./quickstart.md) "Regression gate". Every row names a *passing* test, not a plan.

The journeys all run in attach mode on the bundled Chromium probe (Chrome 151) in both locales; the
branded Chrome 152 cells are the owner's, and are still unrun (see
[tests/acceptance/owner-remaining-runbook.md](../../tests/acceptance/owner-remaining-runbook.md)).

Journey shorthand used below:

| Key | File | Test title |
| --- | --- | --- |
| P | `tests/e2e/packaged/agent-pairing.spec.ts` | pairs once, answers tabs_context, needs no second prompt, and refuses after unpair |
| R | `tests/e2e/packaged/agent-reads.spec.ts` | reads text, structure and pixels, and calls every restricted page not-readable |
| A | `tests/e2e/packaged/agent-actions.spec.ts` | runs each effect under skip-checks, and asks and obeys the owner under ask |
| T | `tests/e2e/packaged/agent-tabs.spec.ts` | creates, navigates, goes back, lists only its own, closes, and survives a reconnect |
| B | `tests/e2e/packaged/agent-batch-wait.spec.ts` | runs a five-step form fill in one call, stops at a failed step, waits, and obeys one plan answer |
| D | `tests/e2e/packaged/agent-diagnostics.spec.ts` | refuses diagnostics without the grant, reads the page's own console and network with it, and detaches on revoke |
| U | `tests/e2e/packaged/agent-upload.spec.ts` | uploads a file from an allowed root and refuses one from outside every root |
| V | `tests/e2e/packaged/agent-privacy.spec.ts` | does a full round of agent work while the remote service sees nothing and the logs carry no page text |

## 1. Every tool in `contracts/README.md` §1

| Tool | Journey | What it does there |
| --- | --- | --- |
| `tabs_context` | P, T | lists the session's tabs after pairing; refused after unpair |
| `tabs_create` | T (and every other journey) | opens the session's own tab, which joins the marked group |
| `tabs_close` | T (and every other journey) | closes it; a hand-closed tab answers `stale`/`tab-gone` |
| `navigate` | T, B, D | url, `back`, `forward`; the destination's site mode applies afterwards |
| `resize_window` | T | resizes the agent's window and reports the size it got |
| `get_page_text` | R, V | the `ordinary` fixture's text, and `not-readable` on each restricted kind |
| `read_page` | R, A, B, U, V | interactive and `all` filters, depth, ref-rooted read |
| `find` | R, A, V | `resolved`, `no-match` and `too-broad` |
| `screenshot` | R, V | a real PNG for the agent's tab; a restricted page is `not-readable` |
| `click` | A, B, D, V | the fixture's safe button and its own submit control |
| `right_click` | A | the gestures fixture's context target reports `contextmenu` |
| `double_click` | A | the double-activation control opens |
| `triple_click` | A | the same target reports a `detail: 3` click |
| `hover` | A | the menu opens through the page's own script |
| `drag` | A | the list reorders |
| `type` | A, B, V | text lands in the field, and in a batch |
| `key` | A, V | Enter commits a tag; `repeat` is unit-covered |
| `scroll` | A | the page moves and the tool says how far |
| `form_input` | A | text, a checkbox and a select option |
| `browser_batch` | B, V | the five-step login in one call, under 10 s |
| `wait` | B | ends at the condition, and at its bound |
| `read_console` | D | the sentinel the page logged, filtered |
| `read_network` | D | the fixture's own document request, with no header or body |
| `evaluate` | D | a script's value; gated by the mode as well as by the grant |
| `file_upload` | U | an allowed file reaches the input; a path outside every root is refused |

## 2. Success criteria SC-020..SC-027

| Criterion | Proof |
| --- | --- |
| SC-020 pair once, first tool works | P — the prompt appears once, `tabs_context` answers, a second session is not prompted |
| SC-021 five-step login as one batch under 10 s | B — the batch is timed and every step is checked on the page |
| SC-022 every tool in a passing journey | this file's §1; the tool list is the closed `AGENT_TOOL_NAMES`, pinned by `packages/agent-host/tests/mcp-server.test.ts` ("offers exactly the tools the contract's table names") |
| SC-023 `ask` prompts, a "no" runs nothing | A — the prompt is answered Deny and the page is unchanged; unit: `apps/extension/tests/site-mode-gate.test.ts`, `agent-effects.test.ts` |
| SC-024 never a tab outside the group | T and A — a call naming the owner's own tab is `denied`/`tab-not-owned`; unit: `apps/extension/tests/agent-tab-manager.test.ts` |
| SC-025 nothing leaves the device | V — the redacting proxy in front of the (unused) remote service logs no request during a full round of agent work, and neither `relay.log` nor the server's stderr contains the fixture's text; unit: `packages/agent-host/tests/host-logging.test.ts` |
| SC-026 unpair stops the next call | P — the call after Unpair is `denied`/`not-paired`; unit: `apps/extension/tests/pairing-controller.test.ts` |
| SC-027 restricted pages are "not readable" | R — every restricted-page kind, for every read tool |

## 3. The consent and privacy rules that are not a single tool

| Rule | Proof |
| --- | --- |
| FR-049 diagnostics only under the per-site grant, and the debugger goes when the grant does | D; unit `apps/extension/tests/agent-diagnostics-gate.test.ts` |
| C1 a navigation nobody asked about detaches the debugger | D (a link click to `:19445`); unit, same file |
| FR-051 uploads only from the owner's configured roots | U; unit `packages/agent-host/tests/upload-policy.test.ts` |
| FR-035 the owner reads the panel in their own language | the whole agent gate runs in `zh-TW` as well as `en-US`; contract `tests/contract/locales.contract.test.ts` walks `AGENT_PANEL_KEYS` |
| The archived 001/002 path still works | the launched packaged gate in both locales (quickstart "Regression gate") |

# Contract additions (024)

All additions are `z.strictObject`, additive, and pinned by contract tests; host and extension versions
stay paired (an older host refuses an unknown command, and the page shows "the helper needs updating",
R-386). `<agent>` is a `ConversationAgent` id.

## Settings page → worker (port `hallpass-settings`, R-373)

Closed union `settingsCommandSchema`; anything else is refused and logged.

| Command | Payload | Effect |
|---|---|---|
| `ui.settings.choices-set` | `{ enabled?: Record<agent, boolean>, default?: agent \| null }` | updates AgentChoices; worker applies D-024-15 and replies with the new record and a `defaultMovedTo` |
| `ui.settings.appearance-set` | `{ theme?, language? }` | updates AgentAppearance (D-024-20) |
| `ui.agent.site-mode` / `ui.agent.site-clear` / `ui.agent.transition-clear` | as today | unchanged semantics, now accepted from the page |
| `ui.agent.set-diagnostics` | as today `{ site, granted }` | the per-site diagnostics grant (004 FR-049), moved with the site row; revoking detaches the debugger (added 2026-10-24, gate finding) |
| `ui.agent.unpair` | as today | |
| `ui.agent.upload-root-clear` | as today | |
| `ui.agent.browser-rename` | as today | |
| `ui.conversation.consent` | as today | the side-panel-agent switch (019 FR-309) |
| `ui.conversation.check-agents` | `{ agent?: agent }` | forwarded to the broker (below) |
| `ui.conversation.install` | as today | now also from the page; the broker's consent check stays (FR-299) |
| `ui.conversation.install-cancel` | `{ agent }` | forwarded |
| `ui.conversation.test` | `{ agent }` | forwarded |
| `ui.conversation.diagnostics` | `{ agent }` (new optional form) | forwarded |

Not accepted from the page: session stop / interrupt / release, site-plan withdraw, prompt and consent-card
answers, conversation start / send / attach.

## Worker → settings page

- `worker.settings.state` — the settings projection (data-model.md), sent on connect and on every change.
- `worker.settings.result` — `{ commandId, ok, error?, defaultMovedTo? }` per command.
- `worker.settings.diagnostics` — `{ agent, readAt, conversationId?, lines }`, the reply to
  `ui.conversation.diagnostics {agent}` from that page only (added 2026-10-24, Wave A finding).
- `worker.settings.toast` — `{ kind: "install-done" \| "install-failed" \| "test-done" \| "default-moved", agent }`
  sent once per event to every open settings page (FR-379 "told once").

## Worker → broker (conversation-command, new commands)

| Command | Payload | Reply |
|---|---|---|
| `ui.conversation.check-agents` | `{ agent? }` | overview with fresh readiness (R-374), each check ≤ 5 s |
| `ui.conversation.install-cancel` | `{ agent }` | `{ ok }`; overview shows Needs a download (R-377) |
| `ui.conversation.test` | `{ agent }` | `{ ok }` at start; result arrives in the overview (R-379) |
| `ui.conversation.diagnostics` | `{ agent }` (alternative to `{ conversationId }`) | `conversation-diagnostics` with `agent`, `readAt`, `lines` |

## Broker → worker: overview additions (optional fields on `conversationAgentAvailabilitySchema`)

- `checkedAt` — ISO time of the local check.
- `version` — the version the program printed, ≤ 64 chars.
- `setupSteps` — Hermes only: `[{ step: "git" \| "hermes" \| "mcp-component" \| "key-variable" \| "browser-restart", found: boolean }]`.
- `browserTools` — `available \| needs-helper \| missing-component \| not-supported`.
- `install` — InstallState without `pid` (data-model.md), including `interrupted`.
- `lastTest` — TestResult (data-model.md).
- `testing` — `true` while a TestRun for the agent is live.

## Panel projection additions (extension-internal)

- `conversation.choices` — AgentChoices.
- Session card: `site` (canonical origin) when the session acts on one, for the permissions link: the
  session's main tab (the one it last opened, claimed or acted on), http(s) only.

## Removed from the panel's use (still in the schema for one release)

Panel no longer sends `ui.agent.site-mode`, `site-clear`, `set-diagnostics`, `transition-clear`, `unpair`,
`upload-root-clear`, `browser-rename`, `ui.conversation.consent` or `ui.conversation.install`; the worker
still accepts them from the panel in 0.16.0 so a panel document opened before an update keeps working
until reloaded.

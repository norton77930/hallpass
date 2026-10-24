# Data Model: Settings Page (024)

## Per browser (extension, `chrome.storage.local`, written only by the service worker)

### AgentChoices — key `agentChoices` (R-380, FR-382..384, FR-396)

| Field | Type | Rule |
|---|---|---|
| `enabled` | `Record<ConversationAgent, boolean>` | every agent present; first run all `true` |
| `default` | `ConversationAgent \| null` | must be enabled and ready when set; `null` = no default |

- **Set default**: allowed only for an enabled agent whose readiness is Ready or Ready with warnings.
- **Switch off the default**: `default` becomes the first agent in `claude-code, codex, hermes, deepseek`
  that is enabled and ready, else `null`; the page is told which (FR-383).
- **Readiness changes later** (an agent stops being ready): `default` is kept; the picker shows the reason
  and the settings link (FR-384), so a conversation never starts on an agent that cannot start.
- **Migration**: on first read, `conversationLastAgent` seeds `default` if ready, then is removed.

### AgentAppearance — key `agentAppearance` (R-382, D-024-20)

| Field | Type | Default |
|---|---|---|
| `theme` | `"system" \| "light" \| "dark"` | `"system"` |
| `language` | `"system" \| "en-US" \| "zh-TW"` | `"system"` |

Read by the side panel and the settings page; changed from the page's top bar; both follow a change at once
(`chrome.storage.onChanged`).

### Side panel tab — key `agentPanelTab` (R-381)

Values `"conversation" | "sessions"`; a stored `"connections"` reads as `"sessions"`.

### Unchanged, managed elsewhere now

`agentSiteModes`, `agentTransitionAllowances`, `agentPairings`, `agentPanelConsent`,
`agentBrowserIdentity` — same shapes and writers; only the page that sends the commands changes.

## Per computer (host, `%LOCALAPPDATA%\hallpass\agents\<agent>\`, R-375)

### InstallState — `install-state.json`

| Field | Type | Rule |
|---|---|---|
| `phase` | `preparing \| downloading \| finishing \| done \| failed \| cancelled \| interrupted` | |
| `percent` | `number \| null` | estimate from installed package folders ÷ expected count (R-376 addendum); `null` before the first folder; ≤ 95 before `done` |
| `etaSeconds` | `number \| null` | from the last 30 s rate, `null` below 10 % |
| `startedAt`, `endedAt` | ISO time | |
| `browserId`, `pid` | string, number | the installing broker; a dead `pid` with phase not final → `interrupted` (R-378) |
| `error` | owner-words text | for `failed` |

Transitions: `preparing → downloading → finishing → done`; any running phase → `failed` | `cancelled`;
running phase with dead pid → `interrupted`; a new attempt overwrites.

### InstallLock — `install.lock`

Created exclusively with `{ pid, browserId }`; removed at the end; stale when `pid` is gone.

### TestResult — `last-test.json` (R-379)

| Field | Type |
|---|---|
| `outcome` | `passed \| partial \| failed` |
| `start` | `ok` or a start-failure code (`agent-missing`, `agent-version`, `agent-exited`) |
| `model` | `{ answered: true, ms } \| { answered: false, reason }` |
| `browserTools` | `available \| missing-component \| not-supported` |
| `keyHint` | key variable *name* only, when R-369 finds it outside the browser's environment |
| `ranAt` | ISO time |

`partial` = model answered, browser tools missing. No key value, prompt text or model answer is kept.

## Broker memory

- **Readiness cache** per agent: last `check-agents` result with `checkedAt`; dropped on Check again, a
  finished install or a settings-page connect (FR-397).
- **TestRun**: at most one per agent; its process and folder `agent-tests\<id>\` live only while it runs.
- **Diagnostics**: unchanged ring of 50 scrubbed lines per run; tests keep one too (R-387).

## Projections to extension pages

### Settings projection (worker → settings page, port `hallpass-settings`, R-373)

`bridge` state and versions (extension, host, match), `browsers` (018 peers, this one marked),
`browser` name, `paired` outside agents, `sites` with modes and transitions (each site row also carries
its diagnostics grant `diagnosticsGranted` and who changed it last, `changedBy`/`changedAt` - the panel's
own site record, 004 FR-049, 019 FR-308), `uploadRoots` (with the list file's `path`, 014 FR-191),
`consent` (side-panel-agent switch), `agents[]` (readiness state, version, checks, notes, warnings,
install state, last test, browser-tools status), `choices` (AgentChoices). No prompts, consent cards,
session details or conversation contents.

### Panel projection additions (worker → side panel)

`conversation.choices` (AgentChoices) and, per agent, the readiness state used by the picker's reason
line. Site list, uploads and browser name stay in the panel projection only as far as the Sessions tab's
session cards need the current site (for the permissions link).

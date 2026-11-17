# Contract: session card controls (036)

No frame changes (FR-557, SC-244). Each control sends exactly what it sends at d747ed4:

| Control | Where now | Sends |
|---|---|---|
| End session | footer, right, danger text | `onStop` → `ui.agent.session-stop` (unchanged) |
| Take back tabs (n) | footer, left | `onRelease` (unchanged) |
| Interrupt | header primary (working, not held) | `onInterrupt`, with the 014 FR-178 "nothing to interrupt" line when `inFlight` is 0 |
| Resume | header primary (held) | `onResume` → `ui.agent.session-resume` |
| Answer | header primary (waiting) | nothing; focuses `#agent-consent-card` |
| Withdraw site plan | "Sites and permissions" title | `onWithdrawSitePlan` |
| Manage (per site) | site row icon button | `onManageSite(origin)` → `ui.agent.open-settings` with that origin |
| Open/fold | header | nothing (panel-local) |

DOM hooks kept for tests and the packaged suites: `section[data-session-id]`, `data-session-state`,
`aria-labelledby` title id. Added: `data-open="true|false"` on the card, `data-group="attention|idle"`
on the two lists, `aria-expanded` on the open/fold button.

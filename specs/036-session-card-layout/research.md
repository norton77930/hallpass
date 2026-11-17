# Research: 036 session card

- **R-533 - the prototype is a reference, not code** (FR-552..554). Decision: rebuild in `SessionCard.tsx`
  and `agent.css` with the panel's own class names and tokens; match `shots/v-E.png`. Rationale: the
  prototype has no tests, overrides button styles with `!important` and fakes data. Alternative: lift
  `variant-e.tsx` - rejected for those reasons.
- **R-534 - site rows** (FR-545..547). Decision: `sitesOf(session)` builds one row per origin: first the
  origins of the tabs it holds (from each tab's `url`; a tab whose url does not parse falls back to its
  host from `sites`, with no origin), then grant origins in the order given, then site-plan origins. Rows
  are keyed by origin, and an origin is matched by exact string. Each row: `origin?`, `host` (display:
  `displayOrigin` minus the scheme; port kept when present), `tabHere`, `inPlan`, `grants[]` (kind,
  source in order). Rationale: `sites` holds hosts only; tabs carry urls; grants and plans carry origins.
  Alternative: prefix `https://` to hosts (prototype) - wrong for http and ports.
- **R-535 - activity rows** (FR-549, FR-550, FR-555). Decision: `rowsOf(activity)` walks newest first.
  A `resume` whose next (older) item is a `hold` starts a pair; consecutive pairs fold into one row with
  `count`. A `site-plan` item followed by a `consent` with `question: "site-plan"` whose `at` is within
  2 s folds into one row carrying the consent's place. Every other item is one row whose sentence comes
  from today's `activityText` with schemes removed by `displayOrigin`-then-strip, and whose result is the
  outcome word (or the consent answer) with a tone: `ok` for an allowed answer (consent allowed, site plan approved), `danger` for refused/deny, `warn` for timed-out/held/interrupted, `muted` otherwise.
  Rationale: the worker's order is kept; merging is display-only. Alternative: change the worker to send
  merged items - rejected (FR-557).
- **R-536 - groups and order** (FR-538). Decision: `needsOwner(s)` = `state` is `waiting` or `working`, or
  `heldAt` is set. `groupSessions(list)` keeps today's newest-activity-first sort and splits into
  `{ attention, idle }` preserving that order.
- **R-537 - fold state** (FR-539, FR-540, edge cases). Decision: the shell keeps
  `Map<sessionId, boolean>` of owner choices and a `Map<sessionId, boolean>` of the last seen
  `needsOwner`. On each picture: a session whose `needsOwner` went false→true loses its choice (opens);
  one that went true→false while open gets choice `true` (stays open). `isOpen` = choice ?? (needsOwner
  || only session). Choices for sessions no longer in the picture are dropped. Rationale: matches FR-540
  with no storage.
- **R-538 - Answer** (FR-542). Decision: `PromptCard`'s root gets `id="agent-consent-card"` and
  `tabIndex={-1}`; Answer calls `scrollIntoView({block: "nearest"})` and `focus()` on it, or on the panel's
  top when it is absent. No frame is sent.
- **R-539 - tokens** (FR-552..554). Decision: one new token `--line-soft` (hex, both themes) for the
  inner hairlines; the card border uses `--line`; the faint shadow and the attention ring use
  `color-mix()` of existing tokens (no literal colour). `panel-a11y.test.tsx` adds `line-soft` to the
  required tokens. Rationale: 006 FR-091/FR-092 keep every colour a token.
- **R-540 - icons** (FR-546, FR-549). Decision: five 16-unit line icons drawn here (tab, plan, check,
  terminal, browser) plus chevron and external-link, `aria-hidden`, `currentColor`; every icon has its
  words next to it or an accessible name on its button.
- **R-541 - words** (FR-555, FR-556). Decision: new keys under `agent.session.*` / `agent.activity.*`
  registered in `agent-panel-keys.ts` so the locale contract checks both languages; zh-TW
  `agent.activity.interrupt|hold|resume` change to the second person; the hold/resume rows carry no
  outcome word. Keys no surface uses any more are removed from both locales and the key list.

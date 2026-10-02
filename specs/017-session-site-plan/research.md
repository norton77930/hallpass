# Research: Session Site Plan (017)

Decisions R-245 – R-253. Reference behaviour: the private evidence for 017.
Code facts read at 8ff9ee8 (0.9.0 + two-browser relay fix).

## R-245 — Where the plan is decided: an input to the one gate

- **Decision**: the pure gate (`agent-tools/gate.ts` `decideGate`) gains one input, "this session's
  approved plan covers this site" (boolean, computed by the caller from the session plan store and
  the tab's current top-level origin). When true and the tool is a covered page action (FR-254), the
  gate admits regardless of the site mode, except `skip-checks`, which already admits. `evaluate`,
  `file_upload` and `upload_image` never read the input (FR-255).
- **Rationale**: the gate is already the single place that turns (site mode, tool, plan) into
  admit / prompt / refuse, and it is pure and fully unit-tested; one more input keeps every call path
  (standalone, batch step, coordinate tools) on the same decision. Computing coverage outside keeps
  the gate free of storage.
- **Alternatives**: wrapping each runner (rejected: many paths, easy to miss one — the 004 lesson
  "one funnel"); temporarily switching the site's mode to `skip-checks` (rejected: persists, affects
  other sessions, shows in the site list).

## R-246 — Store: per session, per browser run

- **Decision**: a new session-plan store in `chrome.storage.session`, keyed by session id:
  `{ origins: string[], approvedAt }`. Read on every gate decision (worker restarts survive, FR-258);
  cleared by `releaseSession` (every session-end path: named stop, unnamed stop, relay session end,
  stale sweep, owner stop), by `unpair` for every session of that agent, and implicitly by a browser
  restart (session storage). Interrupt does not touch it.
- **Rationale**: same lifetime and storage as the 014 per-session transition allowances, which are
  already wired into `releaseSession`; unpair is added here because a plan is an authorization and
  must not outlive the pairing that carried it (the transition store's unpair gap is noted, not
  changed).
- **Alternatives**: in-memory only (rejected: lost on worker eviction mid-task, then the owner is
  asked again for what they approved); `storage.local` (rejected: must never persist, FR-258).

## R-247 — The card: a prompt kind beside the batch plan card

- **Decision**: a third question type in the prompt controller (`agent-tools/prompts.ts`), modelled on
  `askPlan` / `decidePlan`: `askSitePlan` raises it, `decideSitePlan(proposalId, approvedOrigins)`
  answers. Panel state gains an optional `sitePlan` field (strict schema), the panel command union
  gains `ui.agent.site-plan-decide { proposalId, approve, origins[] }`. The worker accepts only
  origins that were in the proposal (subset check) — the panel cannot add a site.
  `PromptCard` arbitration (`questionOnTop`) treats it like the batch plan card (one question on top).
- **Rationale**: reuses the busy/one-question rule, the panel-closed wait and badge (011), the
  card-expiry on call end, and session-end withdrawal (FR-261) that every prompt already has.
- **Alternatives**: a separate card system (rejected: duplicates the arbitration that took 011 and
  014 to get right).

## R-248 — The tool runs in the worker; the host only forwards and checks support

- **Decision**: new tool `propose_sites` (args: `origins` 1–10, `purpose` ≤ 200, `steps` ≤ 10 × ≤ 120
  chars), strict schema in contracts, listed in `IMPLEMENTED_AGENT_TOOL_NAMES`, not a batch step.
  The host forwards it like other worker tools, after checking the worker advertised the feature
  `site-plan` on pair-result (as `upload-consent` / `pair-withdraw`). Validation (FR-250) runs in the
  worker before any card and also in the schema (shape); the worker check names the first bad entry.
- **Rationale**: consent lives in the worker (constitution: authority in the worker or host); the
  host has no reason to see the origins beyond forwarding.
- **Alternatives**: host-side card (rejected: the panel talks only to the worker).

## R-249 — Batch: skip the per-batch plan card when the session plan covers the site

- **Decision**: in `agent-tools/batch.ts`, a `follow-a-plan` site covered by the session plan (D-017-9)
  takes the same path as an `ask` site covered by it: no `askPlan`; each effect step goes through the
  gate, which admits by R-245. Upload and evaluate steps still prompt (their own consent).
- **Rationale**: one decision for the session, as the owner chose; the gate keeps per-step checks.

## R-250 — Covered tools

- **Decision**: the covered set is the gate's effect tools minus `evaluate`, `file_upload`,
  `upload_image`, and minus the forced `navigate` / `tabs_close` (leaving past a "leave this site?"
  prompt): click / double / triple / right click, hover, drag, type, key, scroll, form_input,
  `computer` press/type/scroll actions, `dialog` accept. A constant in contracts names the set; a
  contract test pins it against `requiresGate`.
- **Amended 2026-10-02 (architecture review of S1)**: the first draft also covered forced
  `navigate` / `tabs_close`. FR-254 as approved does not name them, so including them would widen the
  owner's approval beyond the spec; they keep asking under a plan.
- **Rationale**: FR-254 / FR-255 as an explicit list, so a future effect tool is uncovered until
  someone decides otherwise.

## R-251 — Version skew (FR-265)

- **Decision**: tool always listed by a 0.10.0 host; a worker without `site-plan` → host answers
  `unavailable` with "reload the extension" hint, no card. A 0.9.0 host never lists the tool. New
  panel-state field and command are optional/additive; a 0.9.0 panel never sees `sitePlan` because a
  0.9.0 worker never sets it (panel and worker ship in one extension).
- **Rationale**: MCP `tools/list` is answered at agent start, before pairing; the 014 precedent.

## R-252 — Session card summary and withdraw

- **Decision**: projection `sessions[]` gains optional `sitePlan: { origins }`; the card shows "Site
  plan: N sites" (expandable) and "Withdraw site plan"; command `ui.agent.site-plan-withdraw
  { sessionId }` clears the store entry and writes an activity line.
- **Rationale**: FR-259, revocation where the grant is visible (D-014-3 principle).

## R-253 — Evidence

- **Decision**: unit (gate matrix incl. 4 exclusions; store lifetime incl. unpair and interrupt;
  prompt subset check; validation table), contract (tool schema, panel state/command strictness,
  covered-set pin, version pins 0.10.0), extension-ui (card: untick, approve disabled with none,
  warning copy en/zh, session-card summary/withdraw), packaged gate `agent-site-plan.spec.ts` on
  Chromium 151 attach with the real side panel (SC-121 – SC-124), owner's branded Chrome run, paid
  probe S17 (SC-126) at release.

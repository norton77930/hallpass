# Research: 043 page scripts on a local dev site

## R-580 - who decides that the hint applies (US1, FR-620, FR-621)

- **Decision**: the worker says so. `prompt-raised` gains an optional `alwaysInBrowser: true`, allowed only on
  `kind: "effect"`. The worker sets it when the panel card for that question shows *Always allow on <site>*:
  an effect question whose deciding site is known (030 FR-458). The host adds the hint when the field is
  present and the offered choices do not include `session`.
- **Rationale**: for a frame whose site is unknown the frame carries the page's site (prompts.ts:720), so the
  host cannot tell the two cases apart. The worker already decides the card's buttons; one flag keeps the two
  in step without the host recomputing consent rules.
- **Alternatives**: host-side rule on `choices` alone (wrong for an unknown frame site: it would name the page's
  site as the one to waive); a free-text hint from the worker (the host owns the message wording, 031).

## R-581 - the hint's words (US1)

- **Decision**: appended to the existing message, en-US labels quoted exactly:
  `To stop these questions on <site>, choose "Always allow on <site>" on the Hallpass side panel, or set
  <site> to "Skip checks" on the Hallpass settings page. Either one lets every action on <site> run without
  asking.`
- **Rationale**: names both places and the cost (FR-620). It is a sentence, not a choice (FR-622, D-031-2).

## R-582 - the loopback test (US2, FR-623, D-043-5)

- **Decision**: a new pure helper in `packages/domain`: a site is loopback when it is a canonical http(s)
  origin whose `URL.hostname` is exactly `localhost`, `127.0.0.1` or `[::1]`. The worker and the side panel
  both import it.
- **Rationale**: the owner chose the three hosts. The existing `isLoopbackOrigin` in
  `agent-tools/transitions.ts:127-137` accepts all of `127.0.0.0/8` for a different purpose (014 transitions)
  and stays as it is. Inputs the URL parser normalises to one of the three (`http://127.1`,
  `http://LOCALHOST`) are the same canonical origin Chrome keys the site under, so they count; a trailing
  dot (`localhost.`), `app.localhost`, `127.0.0.2` and `[::ffff:7f00:1]` do not.
- **Alternatives**: reuse `isLoopbackOrigin` (wider than D-043-5); a host string compare without URL parsing
  (misses the canonical form).

## R-583 - a third session grant kind `scripts` (US2, FR-625, FR-626, FR-628)

- **Decision**: `session-grant-store.ts` kind becomes `"page-actions" | "diagnostics" | "scripts"`, with a
  `scriptsGrantsFrom` factory beside `pageActionGrantsFrom` and `diagnosticsGrantsFrom`
  (`page-action-grants.ts`). The session card projection's `grants[].kind` enum (contracts
  `agent-tools.ts:4281-4291`), the panel key map (`agent-panel-keys.ts:67-71`) and both locales gain it.
  Clearing on session end, agent forget and site forget is kind-agnostic already.
- **Rationale**: a separate kind keeps FR-626 structural: `covers(..., "page-actions")` can never answer for a
  script. A reader that does not know the kind drops the session's record on read
  (`session-grant-store.ts:109-124`); that cannot meet stored data from this version, because
  `chrome.storage.session` is emptied when the extension updates, and host and extension ship pinned.
- **Alternatives**: widen the page-actions kind to include `evaluate` on loopback (breaks FR-626).

## R-584 - where the grant admits (US2, FR-625)

- **Decision**: `GateInput` gains `scriptsGrantCovers?: boolean`, read by `decideGate` only for `evaluate` and
  only where it would otherwise prompt, in the same place `sitePlanCovers` is read. The evaluate effect path
  (`agent-tools/diagnostics.ts:552-594`) computes it as: deciding site known, loopback (R-582), and the
  session holds a `scripts` grant for it.
- **Rationale**: gate.ts states that every path to "it may run" is visible in one function. A `null` site
  still prompts (030 FR-464) and `skip-checks` still admits, unchanged.

## R-585 - where the choice is offered and recorded (US2, FR-624, FR-627)

- **Decision**: `clientChoicesFor` (prompts.ts:506-518) offers `once, session, deny` for `evaluate` when the
  deciding site is known and loopback. `PromptCard.tsx` shows *This session* on the same condition, using the
  same helper on the prompt's deciding site. On an Allow with `session`, the evaluate path records a
  `scripts` grant only when the tool is `evaluate` and the site is loopback; otherwise the answer is a once
  and `agent.session-grant.not-applicable` is reported, as `recordSessionGrant` does for page actions.
- **Rationale**: the client cannot pick an unoffered choice (prompts.ts:859-864); the worker's own check is
  the second fence for the panel path (031 R-456).

## R-586 - what does not change

- The diagnostics question, the site plan (017: `evaluate` stays outside `AGENT_SITE_PLAN_COVERED_TOOLS`),
  uploads, a forced leave and closing a tab, on every site. The 014 transition rule for loopback.

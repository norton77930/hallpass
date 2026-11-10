# Research: Consent Follow-ups After the Terminal Trial

Decisions R-484..R-490. Code facts were read at private main 37037d9 on 2026-11-09.

## R-484 - Transition and site-plan questions use the 031 raise path (FR-484, FR-485, FR-486, FR-487, FR-489)

**Decision**: `prompts.ts` raises a client question for `kind: "transition"` and for site-plan proposals
through the existing `onRaised` → `prompt-raised` → elicitation → `prompt-answer` → `decideByCall` path,
with the same `promptId` rules. The upload-directory card and the plan card stay out of
`CLIENT_ASKABLE_KINDS` and are never raised.

- Transition offers `["session", "deny"]`. A client `session` settles the effect prompt as
  `{ decision: "allow", answeredFrom: "client" }` with no `rememberTransition`. That is exactly the card's
  *Continue*: `heldByTransition` then calls `transitionStore.allowForSession` for the pair and nothing else
  (agent-runtime.ts:1764-1781).
- Site plan offers `["session", "deny"]`. `decideByCall` learns the site-plan pending question: `session`
  settles it as an approval of every proposed origin (`approved` = the proposal's origins, `leftOut` = []);
  `deny` settles it as `declined`. Narrowing the list stays a card-only action.
- Both raise right after the card is armed, as effect questions do today (prompts.ts:606-619).

**Rationale**: the path already guarantees one answer per question, a late answer is refused, a dismissed
client form leaves the card, and the worker alone decides what an answer means (031 R-450, T929 I1).

**Alternatives considered**: a separate frame type per question (more surface, same guarantees); offering
`once` for a transition (the card has no "once"; it would be a new meaning the owner did not choose).

## R-485 - The frame and the client wording (FR-484, FR-486)

**Decision**: `promptRaisedFrameSchema.kind` gains `"transition"` and `"site-plan"`. Two optional fields are
added: `from` (the site the tab came from), required when the kind is `transition`, and `sites` (the
proposed sites, 1..the proposal bound), required when the kind is `site-plan`. The choices rule
becomes: `effect` and `diagnostics` must offer `once` and `deny`, as today; `transition` and `site-plan`
must offer exactly `session` and `deny`. `terminal-consent.ts` words the message and the `session` title
for each kind (see contracts/terminal-consent-032.md).

**Rationale**: the host stays a relay of a closed shape; the worker decides choices; one schema refine keeps
"a question the owner cannot decline" impossible.

**Alternatives considered**: carrying the from-site inside `action` (bounded to 200 characters, while sites
can be longer); a free-text message from the worker (the host would then show worker-composed text it
cannot bound).

**Compatibility**: host and extension versions are pinned to each other. An older host given a new kind
fails its own schema and asks nothing, so the card alone stands (fail closed). An older worker never sends
the new kinds.

## R-486 - Every question's keep-alive counts from when it was shown (FR-488)

**Decision**: the host router derives the cap's fixed point from each `prompt-waiting` tick as
`now - waitedMs`, instead of from the latest `prompt-raised` or the admission, and keeps the latest such
point. The worker sends a tick with `waitedMs: 0` the moment a question is armed (`arm`), so there is no gap
between the raise and the first five-second tick. `prompt-raised` keeps moving the fixed point as today.

**Rationale**: the tick already carries how long its own question has waited. Card-only questions never
send `prompt-raised`, which is why a late one is cut at admission + 130 s (#61). The cap still bounds
every call: a stuck question's ticks grow `waitedMs`, so its fixed point does not move.

**Alternatives considered**: sending `prompt-raised` for card-only questions with no choices (the host would
have to tell asked from not-asked; and an empty choice list breaks the "always declinable" rule).

**Toolbar mark**: already shown for every pending question (`deriveAttention` reads
`prompts.currentSession()`, agent-runtime.ts:613). A test pins it for transition, plan, site-plan and
upload-directory questions; no code change is expected.

## R-487 - A revoke removes the site from every session admission store (FR-490..FR-493)

**Decision**: `runtime.clearSiteMode(site)` (agent-runtime.ts:3447-3453), after its current work, also
calls:

- `sessionGrants.forgetSite(site)`: removes page-action and diagnostics grants with that site for every
  session (new method; agentSessionGrants).
- `sitePlans.forgetSite(site)`: removes that origin from every session site plan, keeping its other origins;
  a plan left with no origin is removed (new method; agentSessionSitePlans).
- `transitionStore.forgetSessionPairsTo(site)`: removes every session-allowed pair whose destination is that
  site, for every session (new method; agentTransitionsAllowed). `agentTransitionAllowances` (*always*) is
  not touched.

Each removal compares canonical sites exactly as the store's own `covers` does. A pending question is not
answered or withdrawn by a revoke (spec edge case). The revoke remains a settings-page action.

**Rationale**: these three stores are the only session-scoped admissions (Explore reconnaissance of
2026-11-09); every gate already reads them on each call, so removing the entry makes the next call ask.

**Alternatives considered**: ending the sessions that hold grants (too broad: other sites stop too);
a revoke generation counter checked by every gate (touches every gate for the same effect).

## R-488 - One activity line per settled consent question (FR-494, FR-495)

**Decision**: the prompt controller reports every conclusion through a new `onConcluded` callback with the
question kind, the site, the channel and the answer. The runtime turns it into one activity item of the new
kind `consent` (contracts/activity-consent.md) through `noteActivity`, which keeps the 20-entry cap.

- Question kinds: `effect`, `diagnostics`, `transition`, `site-plan`, `plan`, `upload-directory`, `dialog`
  (`dialog-accept` and `beforeunload-force`).
- Answers: `once`, `session`, `always` (a mode remembered, a transition pair or a directory remembered, the
  diagnostics checkbox), `deny`, `timed-out`.
- Channel: `client` or `browser`; `none` for a timeout.
- Endings by stop, interrupt, release or session end add no consent line; those already have their own
  activity or end the session. A question the host's backstop withdraws (`cancel` after a transport
  failure; with R-486 no longer a normal timeout) adds none either (032 review N3).

**Rationale**: the controller is the one place every question ends and knows where the answer came from.

**Alternatives considered**: noting in every runner (seven places to keep in step).

## R-489 - Restart reconciliation of debugger attachments (FR-496, FR-497)

**Decision (revised 2026-11-09 after implementation)**: no production change. `runtime.start()` runs
`diagnostics.start()` on every worker wake, which reads `attachedTabIds()` and detaches every tab this
worker has no record of (diagnostics.ts ~700-712; pinned by agent-diagnostics-gate.test.ts ~901-915). After
a restart that is every attachment, so the "being debugged" bar goes at once, well inside FR-496's bound.
No holder survives a restart (no viewport, dialog or recording state is persisted), so nothing is raced.

**Why revised**: slice D first added a second reconciliation in input.ts that armed the idle countdown for
left-over tabs. It duplicated the start-up detach, which always runs first, so in production it only ever
reported `detach-noop`. It was reverted to keep one rule in one place.

**Alternatives considered**: persisting the countdown's deadline in storage (more state, no visible gain);
the input.ts countdown above (redundant).

## R-490 - Screenshot past its bound (FR-498)

**Decision**: start with a test that fails if a surface capture that misses `SURFACE_CAPTURE_TIMEOUT_MS`
leaves the call's hold in place. Reading photograph.ts:291-310 shows `held?.done()` runs in `finally` on
every path, so the expected result is that the test passes and FR-498 is closed by the pin. Code changes
only if the test fails.

**Rationale**: project rule "measure before fixing"; the browser-side command cannot be cancelled (no
cancel in debugger.ts:88-95), and a later idle detach ends it.

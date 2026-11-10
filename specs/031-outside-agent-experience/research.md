# Research: Outside-Agent Consent and Capture Experience (031)

Facts were read at private main 0535499 on 2026-11-08 by three read-only passes over this repository and
one pass each over the installed reference products and MCP clients. Reference evidence stays out of this
file beyond observable behaviour (see spec.md). Decisions are numbered from R-450.

## Consent channel (slice 1)

### R-450 - the host asks; the worker stays the only judge

- **Decision**: the worker keeps the single pending question (one per session, `prompts.ts`) and remains
  the only party that admits or refuses. When a question is raised, the worker sends a new
  `prompt-raised` frame for that call to the host. The frame carries the site, the action summary and
  the choices the client may offer. If the client supports form elicitation, the host asks it and sends
  the owner's choice back as a `prompt-answer` frame keyed by `callId`. The worker settles the question
  through a new `decideByCall`, the first answer wins (D-031-4), and then sends `prompt-settled` so the
  host can abort its elicitation.
- **Rationale**: today the host never learns `promptId`. The tick carries only `callId` and `kind`
  (`promptWaitingFrameSchema`, contracts ~3475). Questions are matched by call already (`isCall`,
  prompts.ts:325). Keeping the decision in the worker means the gate, the remember paths and late-answer
  logging are unchanged. The host is only one more place an answer can come from.
- **Alternatives**: (a) the host decides by itself from the elicitation result. Rejected, because consent
  would move out of the extension and the card would need a second source of truth. (b) Reusing the
  waiting tick to carry question details. Rejected: the tick is a keep-alive with a fixed vocabulary, and
  overloading it would blur the contract the router relies on.

### R-451 - which clients are asked

- **Decision**: the host asks only when the client advertised elicitation at initialize, either
  `elicitation.form` or a bare `elicitation: {}`. Per the MCP revision that introduced modes, a bare
  object means form support for backward compatibility. Because SDK 1.32.2's `elicitInput` refuses a
  bare object (`server/index.js` ~351), the host sends `elicitation/create` itself through the low-level
  request API with the SDK's result schema.
- **Rationale**: Claude Code 2.1.319 sends `{form,url}` only while a client-side flag is on, otherwise a
  bare object. Codex 0.166.0 was captured sending `{form,url}`.
- **Alternatives**: rely on `elicitInput`. Rejected, because it would silently skip one supported Claude
  Code configuration.

### R-452 - the form

- **Decision**: one required single-select field, `choice`, whose options are those R-450 sends: `once`,
  `session` (offered only when D-031-8 permits), and `deny`. The message names the site, the action and
  the agent session label. A result with `action: "accept"` and a valid `choice` is an answer. `decline`,
  `cancel`, a schema-invalid result, an error or an abort is *no answer* (D-031-5). The worker is not
  told about these, and the card keeps waiting.
- **Rationale**: an explicit deny inside the form is the only way to refuse from the terminal, so a client
  that auto-dismisses can neither refuse nor admit.

### R-453 - one bound for every question, kept alive end to end

- **Decision**: `ASK_TIMEOUT_MS` becomes the same 120 s as `CLOSED_PANEL_TIMEOUT_MS`, and the two
  constants merge. Waiting ticks start at every raise, not only when no panel is visible, so the host
  router's 30 s per-call backstop (router.ts:40, extended by ticks at 193-211) never fires first. The
  elicitation request uses a timeout just under the worker's bound and the call's abort signal.
- **Rationale**: FR-473. Today a visible panel means a 25 s bound and no ticks (prompts.ts:416-425).

### R-454 - the badge

- **Decision**: `deriveAttention` becomes `pairingPending || promptPending`, so presence no longer
  suppresses the mark. Panel presence still drives the card projection and its tests.
- **Rationale**: FR-473. The truth table in `prompt-waiting.test.ts` ~225-239 is rewritten to the new rule.

### R-455 - timeout text

- **Decision**: a `timed-out` answer always carries the hint, panel or not. Its sentence changes to tell
  the agent to ask the owner to answer the question in Chrome (the side panel) and retry. The consent
  attention sentence (`ATTENTION_SENTENCES.consent`) says the question is also shown in the agent's
  client when it can ask.

### R-456 - session grants: their own store

- **Decision**: a new `session-grant-store` in `chrome.storage.session`, keyed by agent session. It holds
  `{site, kind: "page-actions" | "diagnostics", source: "client" | "browser", grantedAt}` entries and adds
  them one at a time. It is cleared on the same end paths as the 017 site plans: `releaseSession`,
  unpair by agent, and session clear. The gate input's `sitePlanCovers` becomes "covered by this
  session's plan or by its page-actions grant for the site". The covered tool set stays
  `AGENT_SITE_PLAN_COVERED_TOOLS`.
- **Rationale**: the 017 store replaces a session's whole plan on `set` (site-plan-store.ts:142-149), so a
  grant stored there would erase an approved proposal. `chrome.storage.session` survives a worker
  restart and dies with the browser, which matches spec Assumption 4.
- **Alternatives**: in-memory only. Rejected, because a worker restart mid-session would silently drop a
  grant the owner gave and re-ask, which contradicts SC-209.

### R-457 - dialog OK and the session grant (amends D-031-8, owner-confirmed 2026-11-08)

- **Decision**: the session grant covers exactly `AGENT_SITE_PLAN_COVERED_TOOLS`, which already includes
  `dialog` (contracts 195-198, dialogs.ts:374). Page JavaScript, uploads, a forced leave and
  `tabs_close` stay asked each time, and their client questions offer only `once` and `deny`.
- **Rationale**: D-031-8 says "the same page actions a spec 017 site plan admits" and also lists dialog
  OK as always asked. Spec 017 admits dialog OK, so the two halves contradict each other. Following 017
  keeps one covered set instead of two. Spec.md is amended once the owner confirms.

### R-458 - grant source shown

- **Decision**: every allow records `source`. Session grants carry it in the store (R-456). A once-allow
  and a remembered mode carry it in the session's activity entry. The side panel's session card lists the
  session's grants as "site - this session - from terminal/Chrome", and the activity line names the
  channel.
- **Rationale**: FR-475. `changedBy` (contracts ~3814) records the kind of author, not the channel, so a
  separate field is needed.

### R-459 - capability advertising

- **Decision**: the worker advertises `terminal-consent` in `pair-result.features`, in the same way as
  `upload-consent` (agent-bridge.ts:720-736). The host sends `prompt-answer` only to a worker that
  advertised it. The new frames do not bump `AGENT_LINK_PROTOCOL`, as in that precedent. The relay
  forwards them unchanged. `relay-mux` must keep a call routable after `prompt-raised`, which follows the
  same exception as `prompt-waiting` (relay-mux.ts:344).

## Diagnostics (slice 2)

### R-460 - ask, then re-check, then attach

- **Decision**: `diagnostics.ts` replaces the refusal at 422-428 with a question of kind `diagnostics`.
  The question is raised only when no session diagnostics grant covers the site. Answers: `once`,
  `session` (stored as a `diagnostics` grant, R-456), `always` (card only, which sets the existing
  `diagnosticsGranted` like the checkbox does), and `deny` (the existing `diagnostics-not-granted`
  refusal). After an allow, the tab's site is read again before attaching, for all three tools. Today
  only `evaluate` re-checks (474-490). `evaluate` then goes through the effect gate exactly as today
  (FR-477), which can raise a second, separate question.
- **Rationale**: closes the gap the recon found. A site change while the question waits must not let
  diagnostics attach to the new site.

### R-461 - the "always" flag

- **Decision**: `ui.agent.effect-decide` gains an explicit `grantDiagnostics` flag, valid only on a
  diagnostics question. The contract comment that forbids the diagnostics grant from riding on it
  (contracts ~4495-4497) is rewritten to say that only this flag may set it, and only for that question
  kind. The card for a diagnostics question shows *Allow once*, *This session*, *Always on this site* and
  *Refuse*. A consent card shows *Allow once*, *This session*, *Allow always* and *Refuse*.

## Capture and debugger (slice 3)

### R-462 - measure before choosing the capture path (blocks slice 3 implementation)

- **Decision**: the first slice 3 task is a measurement on branded Chrome. For three tab states (active
  in a covered window, background tab in a visible window, background tab in a covered window), change
  the page and take `Page.captureScreenshot` with `fromSurface: true` without activating the tab, then
  compare the picture with the page. Ten runs each, and record staleness.
- **Rationale**: today both capture paths activate a background tab first, because "a background tab's
  surface may be stale" (capture.ts:499-500, 548-550). Nothing in the repository shows that a
  non-activated capture is fresh. D-031-10 depends on this.
- **Outcome rule**: fresh in 10 of 10 runs for a state means that state uses the non-activating path. A
  stale result keeps activation for that state, and the owner is told which states still flicker before
  implementation continues.

### R-463 - minimized windows

- **Decision**: before any capture, the window's state is read. `minimized` answers a new refusal code,
  `window-minimized`, with the hint "ask the owner to restore the Chrome window", and nothing is
  activated or restored. The same measurement session (R-462) also tries a click and typing in a
  minimized window (FR-483). If they do not land, effects in a minimized window answer the same code
  instead of failing obscurely. If they do land, nothing changes for effects.

### R-464 - fallback

- **Decision**: when the attachment cannot be acquired (refused, or a debugger is already present) the
  current `captureVisibleTab` path with activation runs, unchanged. Under emulation there is still no
  fallback (capture.ts:459-460).

### R-465 - focus emulation

- **Decision**: the per-attach hook (input.ts:136-143) sends `Emulation.setFocusEmulationEnabled
  {enabled: true}` on every attach and re-attach. A failure is logged and ignored. Nothing needs to
  clear it on detach, because the measurement session confirms whether it ends with the attachment.

### R-466 - idle release and its holders (amends D-031-13, owner-confirmed 2026-11-08)

- **Decision**: effect and capture calls hold the attachment for the call's duration, with a per-tab
  in-flight count. When the count reaches zero and no lifetime holder remains, a 20 s timer starts, and
  when it fires the tab is detached by **dropping** the input holder (never `release`, which would run
  the viewport clear). Lifetime holders are `recording`, `viewport` **and `diagnostics`**: a site whose
  console or network buffer is being kept for `read_console` / `read_network` keeps the attachment, or
  the buffer would be lost (diagnostics.ts:299-307).
- **Rationale**: D-031-13 names recording and viewport only. Diagnostics buffers live on the attachment,
  so detaching would silently lose console and network history the agent asked to read. `input.ts` needs a
  holder accessor, because `state()` does not expose holders today.
- **Costs carried**: dialog tracking ends at detach (dialogs.forget), as accepted in the spec. Frame
  sessions are recreated on re-attach, as they are today after a navigation.

## Change log

### 2026-11-08 - R-462 / R-463 measurement (T938), Playwright Chromium

Run with `node --experimental-strip-types tests/harness/capture-freshness-031.ts` on Playwright's bundled
Chromium 151.0.7922.34 (headed, fresh profile, raw CDP, Windows 11), three runs of 10 per state. The
tab in a covered window reported `visibilityState` "hidden", so occlusion was real.

| State | Fresh / stale / hung (runs 1, 2, 3) |
|---|---|
| a. active tab, covered window | 10/0/0, 10/0/0, 10/0/0 |
| b. background tab, visible window | 1/0/9, 3/0/7, 4/0/6 |
| c. background tab, covered window | 6/0/4, 5/0/5, 8/0/2 |
| minimized window, active tab | 4/0/0 in each run (1.3-4.1 s) |

- No capture that returned was stale (0 of 90). The failure mode of a background tab is a
  `Page.captureScreenshot` that never returns (timed out at 10-15 s), often for every later run too.
- By the R-462 outcome rule only state a may skip activation. States b and c keep activate-and-restore.
- In a minimized window, a click and typing landed in all three runs, and capture returned fresh.
  So R-463's assumption (a minimized window cannot be photographed) does not hold on this build.
- Caveat: not branded Chrome in attach mode, and not through `chrome.debugger`. To be repeated on branded
  Chrome (`CAPTURE_FRESHNESS_CHROMIUM=<chrome.exe>`) before slice C relies on the minimized result.

### 2026-11-08 - T938 repeated on branded Chrome 156.0.8078.80 (owner's machine, temporary profile)

| State | Fresh / stale / hung (10 runs) | Latency of returned captures |
|---|---|---|
| a. active tab, covered window | 10/0/0 | 61-81 ms |
| b. background tab, visible window | 2/0/8 | 4.1-8.3 s |
| c. background tab, covered window | 3/0/7 | 0.1-9.6 s |
| minimized window, active tab | 4/0/0 | 210-606 ms |

Clicks (3/3) and typing landed in the minimized window, as in the control window. Same conclusions as the
Playwright run: state a and the minimized active tab use the non-activating protocol capture; background
tabs keep activate-and-restore; effects get no minimized refusal (FR-483 settled). Still not through
`chrome.debugger`; the packaged live checks (T946) cover that path.

## Clean-room note

Reference behaviour informed *what* to measure and which outcomes the owner wants. Nothing here copies a
reference product's code, identifiers or protocol. The host-directed permission path one reference uses
is a private protocol and is out of scope (spec Non-goals).

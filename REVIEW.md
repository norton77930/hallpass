# Review guide

What failure looks like in Hallpass, for `code-reviewer` and for people. The
checks come from the fix history of 2026-09-16 to 2026-11-21 (254 fix commits).

## What failure looks like

- **Consent:** an agent acts on a site, frame or control the owner did not agree
  to, or the consent card describes something other than what will be acted on.
  Neither tests nor a live run show this: the action simply goes through.
- **Broker permissions and redaction:** a conversation rule allows more than the
  owner chose or outlives a mode change; a string shown to the owner or to an
  agent carries a secret, the browser token or an environment value.
- **Waiting on Chrome or the page:** a call that never settles holds a tool call,
  a relay acknowledgement or every later lookup until the host gives up at 30 s.
- **State across awaits:** the MV3 worker serves calls, Stop, greetings, alarms
  and panel messages side by side, so a value read before an `await` can be
  stale after it.
- **Answers:** a late answer overrides a newer one, or an answer names the wrong
  cause (stopped instead of page-not-responding, stale instead of timed out).

## Reliability checks

Each check names a trigger you can read from the diff, what to check, and the
commits that fixed the miss behind it. Read the diff, then apply only the checks
whose trigger it matches.

- **Unbounded waits.** Trigger: a new or changed `chrome.scripting.executeScript`
  with `allFrames`, a CDP command, a `chrome.storage` read, or a message to the
  page or an agent that a tool call or relay awaits. Check: it is bounded
  (all-frames calls go through `executeInAllFrames` in
  `apps/extension/src/chrome-adapters/all-frames.ts`, page operations race
  `CONTENT_OPERATION_DEADLINE_MS`, agent requests have their own deadline); a
  timeout keeps its mark, so the answer says page-not-responding rather than a
  refusal or stale; a read that left frames out says `truncated: true`; a memory
  that shortens later waits stays with the caller that set it.
  Source: eb221c1, 93a4416, f9cd4a3, e32cac4, 5bdb146, afdb18d, 0fc5f27,
  f19f29f, 163563a.
- **State read before an await.** Trigger: code in `agent-runtime.ts`,
  `hold-store.ts`, `agent-tools/input.ts`, `agent-tools/effects.ts` or
  `agent-tools/frame-consent.ts` that reads a hold, a lease, a countdown entry, a
  session's registration or a site, awaits, and then acts on what it read.
  Check: it reads again after the await, because a Stop, a replaced countdown or
  a released lease can land during it; nothing is marked delivered or recorded
  before the site re-check passes. Source: ca45330, 33c4f7d, fdff726, 7795bd8,
  0697424, 5616bc0, b569ee6.
- **Ordering and late answers.** Trigger: broker frame handlers, handler
  registration in `packages/agent-host/src/broker/conversation.ts`, or a request
  that can time out and still succeed later. Check: a read and a write of the
  same value are ordered (1a3dc21); a late answer is followed only when it is
  newer than the last one followed (a060055, e6aee82); a runner's result after an
  interrupt is discarded (4670342); a request cannot overtake the update it
  depends on (9975ef1); a page refusal after the budget answers
  page-not-responding (7635ffd).
- **Coordinate spaces.** Trigger: a point, clip, box or hit-test that crosses
  screenshot pixels, CSS pixels, device pixels, viewport and document
  coordinates, or a frame's offset. Check: both sides use one space (screenshots
  come back at CSS size; a CDP clip and `DOM.getNodeForLocation` take document
  coordinates, the latter in whole pixels; the holder box check is in viewport
  coordinates), and a point is refused once the page is no longer as wide as its
  picture. Source: e39ea49, 374cc52, d676b7e, 39c8844, 1fff8d3, c12399a.
- **Frame identity.** Trigger: code that pairs the page's frame list with the
  debugger's frame tree, picks a frame by a point, or decides a frame's site.
  Check: pairing never falls back to sibling order when counts or urls disagree
  (an unpaired frame is not located); the site comes from the browser's sender
  origin after a hit-test, never from the frame's own report; a point outside
  the viewport is refused before its site is asked about; a frame inside an
  out-of-process frame gets its own session. Source: 9f2cda0, 5d62e93, 2c05e5b,
  281d1de, d87f718.
- **Conversation permission rules.** Trigger: `permissionRuleKey`, an "allow for
  this conversation" rule, a mode switch or restart in `broker/conversation.ts`,
  or an adapter shim in `broker/agents.ts` or `broker/codex-strict.ts`. Check: a
  rule key forms only for a named action (an unnamed `other` acts as allow once);
  a switch into strict clears the conversation's rules; a mode the agent fixes at
  start is refused rather than switched; strict fails closed and declines wider
  sandbox requests. Source: bd1cf1a, 2361a93, 4d50e0a, ea7c010, f253f13.
- **Redaction.** Trigger: a new string shown to the owner or to an agent that
  comes from a process, a server's stderr, an error or session parameters.
  Check: it passes `redact()` and, where a launch environment exists,
  `withoutEnvironmentValues()` (`packages/agent-host/src/broker/redact.ts`); a new
  secret shape (header values, URL passwords containing `/`, vendor key ids) gets
  a test. Source: 2361a93, ead2e51, bd1cf1a, c19748e.
- **Page text on the consent card.** Trigger: the card's target description,
  `target-role.ts`, or collector naming that the card uses. Check: the name is
  what the owner sees (an input's value or alt, never its `name` attribute); a
  role outside the closed list reads as a page element; quote neutralising
  covers look-alike marks, so a page-supplied name cannot close the quote; a read
  that fails or passes its bound says so. Source: 7f4ed1c, 7df9e07, 0021bfa,
  16c6b2c.
- **DOM structures.** Trigger: `apps/extension/src/content-runtime/collector.ts`
  or the focus check in `content-runtime/index.ts`. Check: open shadow roots
  (including a host reached by leaving one), a ref's root that is hidden or
  removed, ARIA widget roles, an editable body in a subframe without focus, and
  page-supplied role strings such as `__proto__` (own-property lookups only).
  Source: 87844c2, f309f26, c55f884, 16c6b2c.
- **Worker and panel ports.** Trigger: `chrome.runtime` ports,
  `agent-panel-port.ts`, worker start-up or `chrome.alarms`. Check: the panel
  reconnects on `onDisconnect`; every connected panel document is served, not
  only the newest; a worker Chrome evicted is woken by an alarm and reconciles at
  start-up. Source: 1b4837f, dc52453, 0697424.

## Adding a check

Hallpass has no pull-request history, so the bar is commits: add a reliability
check only when its failure class was fixed in at least two commits from
different features or days (review rounds of one change count once), or when
the original diff, replayed to `code-reviewer` three times, showed the defect in
at least two runs although the original review missed it. Every check states its
trigger, check and source commits. Remove a check when its trigger no longer
matches any code.

Below the bar on 2026-11-22: a Windows system program started by its bare name,
which Node looks up in the working directory first (549bbc2).

## Always review

A change touching one of these paths is at least the tier named, whatever the
declaration would otherwise be. A change to how consent, a grant or a permission
rule decides is still R2 (authorization).

- `apps/extension/src/service-worker/agent-tools/effects.ts`,
  `agent-tools/frame-consent.ts`, `agent-tools/gate.ts`,
  `agent-tools/frame-site.ts`, `service-worker/hold-store.ts`: R1. They decide
  whether the owner agreed, to which site and frame, and whether a Stop holds;
  a mistake lets an action through and nothing fails.
- `agent-tools/page-action-grants.ts`, `service-worker/session-grant-store.ts`:
  R1. A session grant stands in for the consent card.
- `packages/agent-host/src/broker/conversation.ts`, `broker/redact.ts`,
  `broker/agents.ts`, `packages/agent-host/src/upload-policy.ts`: R1. They decide
  what a conversation may do, what is hidden from view and which files may be
  uploaded; a mistake grants too much or shows a secret, and nothing fails.

`agent-runtime.ts` is not listed: most of its changes are wiring, and the
state-before-await and ordering checks cover its known failures.

## Limits

- Report at most three `Nit` findings.
- Skip, unless the change is to them: `THIRD_PARTY_NOTICES.md` and
  `package-lock.json` (generated), `tests/acceptance/probe-*/reports/**`
  (recorded evidence), `docs/reference-*.md` (dated analyses),
  `specs/**/tasks.md`, `specs/**/checklists/**` and `specs/**/coverage.md`
  (bookkeeping), `.claude/skills/**` (agent tooling).
- What CI enforces (typecheck, contract tests, `snapshot:check`) and the test
  timing rules in `CLAUDE.md` are not review findings.
- Cite the file and line that shows each defect.

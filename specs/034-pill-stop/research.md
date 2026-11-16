# Research: Stop the Agent from the Page

Decisions R-512..R-523 for [spec.md](spec.md). Facts were read at private main a71f19e (spec commit
8d79ec3); `path:line` are at that commit.

## R-512 - Where a hold refuses calls (FR-515)

- **Decision**: in `handleToolCall` (`apps/extension/src/service-worker/agent-runtime.ts:2307`), right
  after the session lookup (2318) and its `session-ended` refusal (2327), before admission (2329), the
  panel start-tab claim (2336) and `dispatchTool` (2359). A held session's call answers
  `{ callId, outcome: "stopped", reason: "owner-held", hint }` and nothing else runs.
- **Rationale**: this is the one entry every bridge call passes (`agent-bridge.ts:535` → `callTool`
  wired at `agent-runtime.ts:2966`). Before `dispatchTool`, so no pointer step, no dialog check, no
  runner and no page message happens for a refused call (US1.2, SC-226).
- **Alternatives**: in `dispatchTool` (1965) - too late, `showPointerStep` and dialog probing run there;
  in each runner - seven places, and read-only tools would still touch the page.

## R-513 - The hold is a store mirrored in memory, loaded before the first call (FR-518)

- **Decision**: a new `hold-store.ts` beside `site-plan-store.ts`, in `chrome.storage.session` under its
  own key, a map `sessionId -> { at, tabId }`. The worker keeps a memory mirror; `start()` loads the
  store once into the mirror, and `handleToolCall` awaits that load (a promise made at start) before its
  check. Writes go to the mirror synchronously, then to storage, serialised like the site-plan store.
- **Rationale**: the session registry is memory only (`sessions`, 1166), so after a worker restart a
  call from a session that has not greeted again already answers `session-ended` before anything runs
  (2318-2327). When the same session greets again it keeps its id (`onSessionAnnounced`, 2764-2767),
  and the mirror - loaded from storage - holds it again before its first call is answered. Nothing
  lifts the hold on its own (D-034-5). A memory check per call costs nothing; the one await is resolved
  after the first load.
- **Alternatives**: read storage on every call like site plans (`site-plan-store.ts:15-16`) - also
  correct, but the projection for the side panel would then need async reads at every repaint; keep the
  hold in the session record of `agent-tab-manager.ts` - that store is the tab manager's, and the hold
  must exist for a session with no tab.

## R-514 - What clears a hold

- **Decision**: `releaseSession` (2371-2440, every end path including agent-changed at 2817 and the
  reconciliation at 3469-3478) and unpair (3485-3541) delete the session's hold from mirror and store,
  next to `endSitePlans` / `endSessionGrants`. Resume deletes it too, and so does a session greeting as a
  side-panel conversation (review round 1: a press that came before such a session greeted a restarted
  worker cannot know its kind). That last one is decided from what the worker recorded at the press, never
  from what a greeting says (review round 4, owner's choice, after rounds 2 and 3 found greeting orderings
  that lifted a hold): the hold records whether the worker had the session registered when Stop was
  handled. A hold set while the session was known is never dropped by a greeting, before or after a
  restart. A hold set while it was not known is settled by the session's first greeting after the press:
  with a side-panel token it is dropped (the conversation case), without one it becomes a known hold. The
  token is not checked against a live conversation, because after a restart a conversation's server
  usually greets before the broker has sent its token again. Nothing else deletes a hold.
- **Known limit (round 4)**: a hold set after a worker restart, before the session greeted again, is
  dropped by a first greeting that carries any token. Only a link client that writes its own greeting
  can do that to an outside session; the shipped server reads its panel identity once at start. If the
  write that turns such a hold into a known one fails (diagnostic `agent.hold.record-failed`), the store
  still says not known, and after another restart the next greeting settles it again. Likewise, if a
  restarted worker cannot read the holds at all (every read fails) and the owner presses Stop again
  before the session greets, the new record says not known and replaces the stored known one, so the
  session's first greeting with a token can drop it (round-4 review N1; it needs `storage.session`
  reads to keep failing).
- **Known limit**: after a worker restart, unpair clears the holds of the sessions this worker knows; a
  session that has not greeted again keeps its record (it has no agent id, per the data model) until it
  greets and is resumed, ends through the reconciliation, or the browser session ends. It fails closed:
  such a session answers `owner-held` until resumed.
- **Rationale**: D-034-5 and US3.3 - the hold lives exactly as long as its session.

## R-515 - Stop for an outside session: hold first, then end what is in flight (FR-514)

- **Decision**: on an accepted Stop press for an outside session: (1) set the hold in the mirror (sync),
  (2) `stops.interruptSession(sessionId)` and `prompts.cancelSession(sessionId, "interrupted")` exactly
  as `interruptSession` does (3627-3653), (3) note activity, (4) persist the hold, (5) re-raise every
  pill of the session and send each held tab a "Stopped" pointer caption (R-519), (6) `notify()` the
  panel, (7) reply to the page.
- **Rationale**: the mirror is set before anything is interrupted, so a call that arrives while the
  in-flight ones unwind is refused, never dispatched. Calls that were in flight answer
  `owner-interrupted` with the existing hint - that step ended the way Interrupt ends it (D-034-1) - and
  the agent's next call answers `owner-held`. No prompt decision is added: the consent card is withdrawn
  with the existing `interrupted` decision, and the site keeps its mode (014 FR-179).
- **Alternatives**: answer `owner-held` also for the calls in flight - would need a new consent-card
  decision value in the panel contract (`agent-tools.ts:3339`) and a branch in every runner that maps
  `interrupted`; the agent learns the same thing one call later.

## R-516 - A new stop reason `owner-held` and its hint (FR-521, FR-525, D-034-9)

- **Decision**: `AGENT_STOP_REASONS` (`packages/contracts/src/agent-tools.ts:2901`) becomes
  `["owner-stopped", "owner-interrupted", "owner-held"]`; a `HELD_HINT` constant next to
  `INTERRUPT_HINTS` (2974-2981) carries the FR-523 agent message. The pinned list in
  `tests/contract/agent-tools-014.contract.test.ts:74-77` is updated in the same change.
- **Rationale**: the host has no per-reason text table: `toolReply` (`packages/agent-host/src/mcp-server.ts:1498-1585`)
  returns `{ outcome, reason, refusal?, hint? }` as JSON, and `reason` is a free string on the wire
  (`agent-tools.ts:3094`). So the host needs no change; agents see one new reason value and a hint.
  `outcome: "stopped"` already carries other reasons (`owner-released-tabs`, batch `not-run`), so a new
  value is within what clients already handle.
- **Review**: an exposed interface (what agents read) changes → `architecture-reviewer` on this slice.

## R-517 - Page presses: two new internal messages with a reply (FR-513, FR-522, FR-524)

- **Decision**: the pill sends `{ type: "ui.agent.pill-stop" }` or `{ type: "ui.agent.pill-resume" }`
  through `runtime.sendMessage` and awaits the reply; the worker's listener answers with
  `sendResponse({ accepted: true })` or `{ accepted: false }` and returns `true` for these two types only.
  No field names a session or a tab. The worker takes the tab from `sender.tab.id` after checking
  `sender.id` (as `focusMainTab`, 2501-2520), finds the session from the tab's lease, and refuses a tab
  no session holds. The shapes are in [contracts/pill-messages.md](contracts/pill-messages.md).
- **Rationale**: today nothing replies to content messages (`agent-entry.ts:35-44` ignores the result;
  the listener at 3443-3455 returns `false`), and FR-522 needs a confirmation. A reply to the sending
  call is the smallest channel and keeps the trust decision on the worker's side.
- **Retry and not-delivered**: the page resends once if no reply after 1 s, and shows the
  not-delivered words if none after 2 s (D-034-7). A rejected `sendMessage` (extension context gone)
  counts as no reply. Because the worker may be the thing that is unreachable, it sends the
  not-delivered words in advance with the pill's state (R-518).

## R-518 - The pill's state and words come with the indicator message (FR-512, FR-520, FR-523)

- **Decision**: the existing `indicator` message (`content-runtime/indicator.ts:14-21`, worker copy
  `agent-tools/indicator.ts:24-29`) gains optional fields: `mode` (`working` | `held` | `conversation`),
  `stop`, `resume`, `heldLabel`, `stopUndelivered`, `resumeUndelivered`. The composer's `shown()`
  (72-80) takes the session's hold and kind and fills them in the owner's locale. `raise` is called for
  every leased tab of the session on Stop and on Resume; `answerAnnouncement` (96-101) uses the same
  composer, so a page that navigates or reloads while held draws the held pill (US3.4).
- **Rationale**: one message, one composer, one place where words are chosen (FR-524). The two
  hand-copied types (content and worker, recon flag F) are both changed and the contract doc pins them.
- **Frames**: the indicator is sent with `frameId: 0` (`agent-runtime.ts:680`), so the pill exists only
  in the top document; the spec's frame edge case is corrected accordingly (change log).
- **After a worker restart**: pills already on a page keep what they last drew (start() sends no
  indicator, recon flag D) - a held pill stays held, which is the safe side. A navigation re-announces
  and gets the composer's answer from the loaded mirror.

## R-519 - The pointer caption says "Stopped" (spec edge case)

- **Decision**: on Stop, each held tab's top document gets one 033 pointer step with the `agent.pointer.stopped`
  words in `rest` mode (rest captions do not fade, 033 FR-501). On Resume nothing is sent; the next call's
  caption replaces it.
- **Rationale**: reuses the 033 message unchanged; the arrow moves out of the way and the words stay.

## R-520 - Side-panel conversations (FR-519, D-034-6)

- **Decision**: a press from a tab held by a session whose `kind` is `panel` maps the session to its
  conversation through `panelTokenOf` (1172) and `panelTokens.conversationOf` (2798), interrupts its
  in-flight calls (`stops.interruptSession`), and forwards `{ type: "ui.conversation.stop", payload: {
  conversationId } }` through `conversations.command` (3363-3372), the same command the conversation's
  own Stop sends (`ConversationTab.tsx:1204`). No hold is set. The reply is `accepted: true` when the
  command was handed to the broker, `false` when no broker is connected (`conversation-relay.ts:576-579`)
  or the mapping is missing.
- **Rationale**: the worker has no turn state; the broker ends the turn (`conversation.ts:1682-1687`). The
  in-flight interrupt makes the browser step stop at once rather than when the broker's cancel lands.
  Pills of a panel session get `mode: "conversation"`: Stop, never Resume.

## R-521 - Side panel card (FR-520)

- **Decision**: the session view (`agentSessionViewSchema`, `agent-tools.ts:4160-4249`) gains an optional
  `heldAt` (ISO time); the projection (3288-3314) fills it from the mirror. `SessionCard.tsx` shows
  "Stopped from the page" and a Resume button when `heldAt` is set, keeps End session, and hides
  Interrupt while held. A new panel command `ui.agent.session-resume { sessionId }` joins
  `agentPanelCommandSchema` (4672) beside `session-interrupt` (4839-4842) and is routed in
  `agent-panel-port.ts` beside 395-404. Activity gains kinds `hold` (outcome `held`) and `resume`
  (outcome `resumed`) in the activity schema (4063-4135), labelled in `agent-panel-keys.ts`.
- **Rationale**: `state` (working | waiting | idle) stays what it is - a held session can still be
  "waiting" on nothing; a separate field keeps every existing state rule untouched.
- **Known limit**: activity lines are worker memory (1363-1366), so stop/resume lines do not survive a
  worker restart, like every other activity line. The hold itself does (R-513).

## R-522 - Trust (FR-513, SC-229)

- **Decision**: the page acts only on `isTrusted` presses (the existing `trusted()` seam,
  `indicator.ts:234`), and the worker trusts nothing in the message: no session, no tab, no state. A
  page cannot send `ui.agent.pill-stop` itself - content-script `runtime.sendMessage` is not reachable
  from page script - so the page-made-click case is closed on the page side, and the tab-and-session
  decision on the worker side. Both are tested: the jsdom test for an untrusted click, the worker test
  for a sender with a wrong id, no tab, and a tab no session holds.
- **Look-alike pills**: a page can draw its own pill; a press on it reaches nothing. Covered as an edge
  case, not a requirement to detect.

## R-523 - Locale keys land first

- **Decision**: all new keys (`agent.indicator.stop`, `.resume`, `.held`, `.stopUndelivered`,
  `.resumeUndelivered`, `agent.session.heldFromPage`, `agent.session.resume`, activity labels,
  `agent.pointer.stopped`) go into `en-US.ts` and `zh-TW.ts` in the contracts slice, so the worker and
  panel slices only read them. `tests/contract/locales.contract.test.ts:4-19` checks parity.
- **Rationale**: both locale files would otherwise be edited by three parallel slices.

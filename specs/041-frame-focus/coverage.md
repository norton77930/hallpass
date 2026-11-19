# Spec 041 - coverage and measurements

## Requirement -> evidence

| Requirement | Success criterion | Evidence |
| --- | --- | --- |
| ~~FR-578 frame focus walk~~ | SC-263 (pin) | withdrawn (D-041-1); packaged `agent-frame-focus-041` overlay case, out-of-process and same-site frame, passes on 0.26.2 and after |
| FR-579 top document unchanged | SC-264 | `agent-type-drag-039`, `agent-input` |
| ~~FR-580 key too (walk)~~ | - | withdrawn with FR-578; `key` is FR-583 |
| FR-581 editable body, out-of-process frame | SC-265 | packaged `agent-frame-focus-041` third test, fixture `frame-body-041` + `frame-body-041-child` |
| FR-582 type refuses an unknown check | SC-267, SC-268 | unit `effects-focus-drag-039.test.ts` ("does not type at all when the focus check could not run"); packaged `agent-frame-focus-041` SC-267 `type` (remove, replace) |
| FR-583 key checks before the key | SC-267, SC-268 | unit `effects-focus-drag-039.test.ts` ("key with a named target checks before the key"); `agent-effects.test.ts` T128/B65; packaged SC-267 `key` (remove, replace) |
| FR-584 key verdict after the key; key with no target | SC-268 | unit `effects-focus-drag-039.test.ts` ("the check after the key") |
| FR-585 time-bounded retry | SC-268 | unit `effects-focus-drag-039.test.ts` ("the check is bounded by time, not by attempts"), incl. an ask that never answers under fake timers |
| FR-586 unresolvable target is unknown | SC-268 | unit `content-runtime-active-039.test.ts` ("could not check, not a miss"); worker mapping is the existing `stale-target` -> `stale-context` -> `undefined` path of `resolveHandleOnTab` |
| FR-587 verdict in the closed schema | - | `AGENT_EFFECT_VERDICTS` (`agent-tools.ts`), `ATTENTION_REQUIRED_CAUSES` (`common.ts`), `POST_EFFECT_VERDICTS`; contract `agent-effect-tools.contract.test.ts` accepts it |

## Design as built

- A: no code. A frame focus walk was built and removed before review (D-041-1): it changed no outcome on 0.26.2.
- C: see the slice C notes below once built.

## Measurements (2026-11-19, test Chromium 151, private profile, window in front unless stated)

1. **The frame's own document after focus left it.** With a frame field focused and then a top-document input focused
   by the page (overlay click, or the frame asking its parent), the frame's own `document.activeElement` is `BODY`,
   `hasFocus()` is `false`, on both an out-of-process frame and a same-site frame. On 0.26.2 (production files at e0b4a6e,
   rebuilt, same spec) the overlay case was therefore already refused `focus-lost` with neither input changed: **the
   packaged overlay scenario does not fail on 0.26.2**, so SC-263's "on 0.26.2 the same run types into the overlay input"
   is not reproducible in this Chromium. The walk was therefore withdrawn (D-041-1) and the overlay scenario kept as a pin.
2. **Editable `body` in an out-of-process frame, window in front (SC-265).** `type` at a point on the text, insert mode:
   answered `verified`, text in the child body and echoed to the top document.
3. **Same call with the browser window behind another window.** A second window created and focused through
   `chrome.windows.create({focused: true})`; the agent tab's window `focused: false`. Before the call: child
   `hasFocus() === false`, `activeElement` `BODY`; top document `hasFocus() === true` (focus emulation, 031).
   Answer `verified`, `focusRetained: true`, 7 characters; after the call the child's `hasFocus()` was `true`, the text
   in the body. No refusal behind another window, no write anywhere else.

## Slice C notes (2026-11-19)

### Design as built

- **Verdict.** `focus-unconfirmed` joins `AGENT_EFFECT_VERDICTS`, `POST_EFFECT_VERDICTS` and `ATTENTION_REQUIRED_CAUSES`
  (the last because `POST_EFFECT_VERDICTS` is declared `satisfies` that list). No tool description or doc lists the
  verdicts, so there is nothing else to extend; the `mcp-server.ts` mention of `target-unconfirmed` is a comment about a
  different call-level fact and is untouched.
- **How the verdict reaches the answer.** `focusRetained` stays a fact the check observed (`true` / `false` / absent).
  "Could not ask" travels beside it as `focusUnconfirmed` on `verifyPageEffect`'s input (the way `pointConfirmation` does for
  clicks): `enter-text` and `key-press` answer `focus-unconfirmed` when it is set, `focus-lost` when `focusRetained === false`,
  `verified` otherwise. The `key-press` clause used to read `focusRetained === true ? verified : focus-lost`, so a key
  with no target answered `focus-lost` on 0.26.2 (pinned RED by the unit test, now `verified`).
- **Budget (`pollFocusRetained`).** Time, not attempts. First ask at t0. A confirmed `false` settles on 50 ms of polling
  (asks every 10 ms, counted in sleeps as in 0.26.2: five misses then a hit still reads as a hit), whatever comes after it:
  an unknown or cut-off answer never replaces a miss already seen, and a later hit still wins (review I1). Only a check that
  has seen no miss is ended by the retry window, a parameter: 2000 ms for the checks before the keys (`type`, `key`), and
  50 ms after a key (the key is sent, and a key that navigates must not wait). Each ask, whenever it starts, is raced
  (`withinMs`, a real `setTimeout`, not the injected `sleep`) against what is left of a 2000 ms budget from t0, before
  and after the key alike, so a renderer that is busy for 120 ms after a key is awaited, not dropped (review N1); no ask
  starts once the budget is spent, and a late reply is ignored with its rejection swallowed. So a check ends within 2000 ms
  plus one interval of t0. Unit pins (`effects-focus-drag-039.test.ts`): never-resolving asks before and after the key end the
  call at the budget; post-key re-asks of an unknown answer stay inside 50 ms; a 120 ms post-key answer is `verified`; five
  post-key misses then a hit is `verified`; a miss followed by prompt unknowns settles `focus-lost` in about 50 ms and sends
  no key; a miss followed by an ask that never answers stays `focus-lost` after the key. The last two fail (`focus-unconfirmed`)
  when the guard `if (answered === false) last = false` is replaced by `last = answered` (mutation run, review round 2).
- **`type`.** After the poll: `false` -> `focus-lost` (as before); unknown with a named target -> `focus-unconfirmed`,
  `charactersChanged: 0`, hint, no key; no target -> no check, keys as before.
- **`key`.** The same poll runs right after the focusing click and before `keysMayLeave()` and the key: `false` ->
  `focus-lost`, unknown -> `focus-unconfirmed` (hint: not sent, read the page again), no key either way. The check after the
  key stays: `false` -> `focus-lost`, unknown -> `focus-unconfirmed` (hint: sent, where focus ended up unknown). The on-path
  receiver hint comes from the check before the key (the field the key went to). A pre-key `focus-lost` refusal for `key` carries a hint that the key was not sent (review N2).
  The comments on `focus-lost` in `common.ts` and `effect-verification.ts` no longer say the key was always delivered.
- **Unresolvable target (`content.resolve-active-element`).** A handle the frame's registry cannot resolve answers
  `{ ok: false, reason: "stale-target" }`, the reply `content.resolve-point` already gives for a target that left the document.
  `resolveHandleOnTab` already maps `stale-target` with a `targetHandle` to `stale-context`, and the confirmer maps `ok: false`
  to `undefined`. No contract schema changed beyond the verdict lists.
- **Not done on purpose.** A hint that is localised: hints are English constants in `effects.ts` (as `linkHint`,
  `receivedByHint`), so no locale file changed.

### Existing unit tests changed

- `agent-effects.test.ts` "verifies a key press whose target kept focus, and reports focus-lost when it did not (T128/B65)":
  still `focus-lost`; added the assertion that no key was dispatched (FR-583).
- `agent-effects.test.ts` "polls for focus rather than trusting one sample after a fixed wait": `calls` 2 -> 3 (two asks
  before the key, one after); the one 10 ms sleep is unchanged.
- `effects-focus-drag-039.test.ts` "does not type at all when the focus check could not run": rewritten. It asserted only
  `outcome: ok` and no hint; it now asserts `focus-unconfirmed`, `charactersChanged: 0`, no key sent, the hint.

### Measurement: SC-267 on 0.26.2 (RED) and after

Page `frame-removal-041` (same site) frames `frame-removal-041-child`. The child field's `focus` handler focuses the
top-document input `#top-field` (text `keep`, selected) through `parent.document` and then removes its own frame
(`frameElement.remove()`), or replaces its document (`location.replace('about:blank')`). The focusing click is therefore
the call's own click. `key` takes `Backspace`: the key list is closed (`KEY_PRESS_KEYS`) and has no printable key; a
Backspace on the selected top text is as observable as a character.

Production files at e0b4a6e (5 files copied aside, `git restore --source=e0b4a6e --worktree`, rebuilt), same spec:

| Case | 0.26.2 answer | Top input after | After the change |
| --- | --- | --- | --- |
| type, frame removed | `verified`, `charactersChanged: 6` | `secret` | `focus-unconfirmed`, 0, `keep` |
| type, document replaced | `verified`, `charactersChanged: 6` | `secret` | `focus-unconfirmed`, 0, `keep` |
| key Backspace, frame removed | `focus-lost`, `verified: false` | empty | `focus-unconfirmed`, `keep` |
| key Backspace, document replaced | `focus-lost`, `verified: false` | empty | `focus-unconfirmed`, `keep` |

The RED is deterministic (two runs of the type cases, one of the key cases, same result). The 0.26.2 `key` answer
`focus-lost` is the false report D-041-4 names: the key had gone into the wrong field. Out-of-process variant: not built.

## Review (code-reviewer, three rounds) and follow-ups

- Round 1: I1 fixed. A cut-off ask overwrote a confirmed miss. Nits N1 and N2 were fixed with it. Round 2: I1 fixed. The guard had
  no test pin, and the pins are now proved by a mutation run. Nit N1 (the settle variable) was fixed with it. Round 3: no Important finding.
- Follow-ups, not done:
  - The settle rule counts the 50 ms in sleeps from the first ask, not from the first miss. Before the keys, a first miss that
    arrives after five or more unknown passes refuses at once. That fails safe: no key is sent.
  - No test tells `waited` from the clock in the settle rule.
  - An unknown answer that cannot recover within the call (`stale-context`, `stale-target`) is still asked again for the full
    2000 ms. A definitive `ok: false` could refuse at once.
  - A dialog opened after the focusing click's dispatch returned is not raced by the focus poll. This was already so for
    `type`, and the refusal comes without the dialog.

# Coverage: 025 side-panel model picker

## Baseline

| Suite | Result |
| --- | --- |
| typecheck | see gate m-typecheck |
| unit + extension-ui | see gate m-unit |
| contract | see gate m-contract |
| build | see gate m-build |
| snapshot:check | see gate m-snapshot |

Gate results are filled in by main after the gate runs; "result: see gate run" means only a live or visual gate
covers the row and its outcome is not recorded here yet. Gate ids are those of
`.claude/acceptance/025-model-picker.json`. Fixtures use invented model names in the shapes of research R-398;
the gate runs use the fake ACP agent with `FAKE_ACP_MODELS`.

Short names for test files (all under the checkout):

- **contracts** = `packages/contracts/src/conversation.test.ts`
- **offer** = `packages/agent-host/tests/broker-model-offer-025.test.ts`
- **store** = `packages/agent-host/tests/broker-model-store-025.test.ts`
- **start** = `packages/agent-host/tests/broker-model-start-025.test.ts`
- **change** = `packages/agent-host/tests/broker-model-change-025.test.ts`
- **resume** = `packages/agent-host/tests/broker-model-resume-025.test.ts`
- **chip** = `apps/extension/tests/side-panel-model-chip-025.test.tsx`
- **relay** = `apps/extension/tests/conversation-relay.test.ts`
- **polish** = `apps/extension/tests/settings-polish-025.test.tsx`
- **fake agent** = `tests/harness/fake-acp-agent.test.ts`
- **019 contract** = `tests/contract/agent-conversation-019.contract.test.ts`
- **gate** = `tests/e2e/packaged/agent-model-picker-025.spec.ts` (packaged gate, attach mode only)

## Requirement → tasks → evidence

Status: ✓ named test(s) pass in the unit/contract suites (gate m-unit / m-contract confirm); gate = needs the gate
run; GAP = nothing covers it; pending = not run yet.

| Requirement | Tasks | Evidence | Status |
| --- | --- | --- | --- |
| FR-398 chip, popup, order, effort below a divider, popup stays open | T808, T809, T813 | chip: "sits after the mode chip, reads the remembered model, and adds the effort only when it is not the default"; "lists the models (the agent's default first, the current one checked), a divider and the efforts"; "keeps a long name whole for the pointer and the screen reader"; "keeps the popup open when a model or an effort is chosen, and moves the chip"; "offers no efforts and no divider for an agent that has none (Hermes)". Gates live-L2, vis-a2-*, vis-a3-*, vis-a5-* (long list scrolls); gate test "a3: a running Codex conversation shows 'model · effort' on its chip (config shape)" | ✓ unit; visual: result: see gate run |
| FR-399 only model and effort are offered or changed | T800, T801 | offer: "reads only the model and thought-level options, never mode or the other categories"; "ignores the models field and every other option, and has no default when none is listed"; "skips boolean options and uncategorised ones, and takes the first select of each category"; "offers no effort when only the model option is there, and sets no effort id" | ✓ |
| FR-400 remembered list and choice, offered before the first message; "Default" with no list | T803, T804, T807, T808 | store: "starts empty with no file, and writes the offer with when it was seen"; "writes a choice beside the offer and keeps it when the offer is replaced"; start: "availability carries the store's offer and choice (no current); a stopped view carries the entry's model"; chip: "says Default and that the list comes with the conversation when nothing is remembered (FR-400)"; relay: "025 projects the overview's remembered offers and a view's models as they came". Gates live-L1, live-L3, vis-a1-* | ✓ unit; live: result: see gate run |
| FR-401 start on the last choice or the agent's default, applied before the first message, no change line | T805, T806, T808 | start: "sets model then effort after the mode is confirmed and before any prompt; no line; entry, store and view follow"; "an effort alone in the start sends that one effort request before the prompt; the store's choice takes the agent's model"; "without a choice in the start uses the store's, sending only the part that differs"; "sends nothing when the agent already reports the choice, and nothing with no choice anywhere"; chip: "sends the choice with the start, and nothing extra when the owner chose nothing"; "sends the model alone, with the remembered effort, when only the model was chosen"; "sends the effort alone when only an effort was chosen and no model is known (no default, nothing remembered)". Gates live-L2, live-L3 | ✓ unit; live: result: see gate run |
| FR-402 nothing written to an agent's own configuration; only `session/*` requests | T805, T806 | start: first test (its last check, "nothing but the protocol's own requests is sent", comment FR-402); gate m-order. File comparison is SC-181 (T825) | ✓ requests; files pending (see SC-181) |
| FR-403 change only between turns; chip shown, not open, reachable, says when | T811, T813 | change: "busy while a turn runs, while a card waits, and while another switch is in flight"; "a message is refused busy while a switch is in flight, and a switch while a mode reload is"; "DeepSeek's fixed mode does not block a model change"; chip: the two cases of "running" / "waiting-for-owner" (it.each), "is available again once the answer is finished", "is shown but not open while a permission card waits". Gates live-L7, vis-a4-* | ✓ unit; live and visual: result: see gate run |
| FR-404 one line per accepted change; names the effort when the model moved it | T811, T813, T814 | change: "a model change: one request, one line with the model's name and no effort; entry, store and view follow"; "an effort change: the line names the model and the effort, without effortChanged"; "D-025-12: a model change that moves the effort names the effort now reported, with effortChanged"; contracts: "names the model, the effort and whether the effort moved"; chip: "draws one line for an accepted change, naming the effort too when the model moved it"; "says the change line in zh-TW too". Gates live-L4, live-L5, vis-a6-* (gate test "a6 [idle]") | ✓ unit; live and visual: result: see gate run |
| FR-405 refusal keeps the model, notice with the agent's text, no retry, no typed command | T805, T811, T813 | change: "refused: result model-refused with the agent's scrubbed text, one notice, no line, nothing retried, nothing kept"; "model-unknown for a value the live offer does not list, or an agent that reports none; nothing is sent"; start: "a refused start-time switch still starts: one model-refused notice with the agent's scrubbed text, the first message goes after it"; contracts: "answers model-unknown and model-refused"; "names the two notices"; 019 contract: "names exactly the twenty-nine ConversationError codes, including … 025's two"; chip: "says a refused change in the panel's words with the agent's own text, once (no second error card)"; "says the command refusals the panel can get from the picker". Gate live-L6 | ✓ unit; live: result: see gate run |
| FR-406 continued conversation put back on its model before the next message; list keeps model and effort | T806, T807, T816, T817, T818 | resume: "a resume after the idle stop re-applies the entry's model after the mode, before the prompt, with no line"; "a resume after a crash, and an open, re-apply it too"; "DeepSeek's session/resume is followed by its model as well"; "Claude's mode reload (session/load on the same run) re-applies the current model after the new mode"; "Hermes' mode restart re-applies its model with session/set_model"; "sends nothing when the agent already reports the entry's model"; "an unknown-session resume is refused as before, and nothing of the model is sent"; "R-406: the agent's own change is in the entry, so the resume after an idle stop does not revert it"; contracts: "carries the choice on an index entry"; chip: "shows the model the conversation was left on, by the agent's remembered names, and cannot be opened"; "shows the value itself when the agent's remembered offer does not know it, and no chip when nothing is known". Gate live-L8 (gate test "L8 [idle]") | ✓ unit; live: result: see gate run |
| FR-407 a model no longer offered is replaced by the agent's default, one notice | T800, T805, T816 | offer: "calls a model the offer does not list unavailable, whatever the effort"; "drops an effort the offer does not list"; start: "a remembered model the agent no longer offers sends nothing, says model-unavailable once, and the agent's own replaces it"; resume: "a model no longer offered at a resume: nothing sent, model-unavailable, the entry takes the agent's"; store: "a later session/new with a different list replaces the offer; a choice it no longer lists becomes the agent's (R-405)"; chip: "says a remembered model that is no longer offered in the panel's words, in zh-TW too". No gate scenario drives this live | ✓ unit |
| FR-408 session options win over the older list; Hermes switched through the older list | T800, T801, T805, T811 | offer: "Codex-like session options win over the older list (R-399)" (describe); "Hermes-like older list (R-399)" (describe); "builds set_config_option for the session options, model first, then effort"; "builds set_model for the older list and never sends an effort"; start: "Hermes' older list is switched with session/set_model"; change: "Hermes' older list: session/set_model, and the asked model becomes current"; resume: "Hermes' mode restart re-applies its model with session/set_model". Gate test "a5: Hermes (the models shape) offers its list and no effort", vis-a5-* | ✓ unit; visual: result: see gate run |
| FR-409 chip shows what the agent reports, including its own change, no line | T811, T813 | change: "R-406: the agent's own config_option_update moves the live state with no line"; fake agent: the `self-model:<value>` case ("switches its own model mid-turn and says so with config_option_update"); chip: "follows the model the agent now reports (the broker's view, not the press)"; "shows what the agent reports, and sends one set-model per choice with the popup left open" | ✓ unit. Not in any live gate (the fake agent's self-model keyword is not used by L1–L9) |
| FR-410 lists and choices stay on this computer, not published, not sent but to their agent | T803, T804 | store: "lives in the data folder as agent-models.json". Nothing asserts that the file stays out of the public snapshot or is sent nowhere else | GAP (by construction only: the file is in the per-user data folder, outside the tree that `snapshot:check` scans; no test asserts non-transmission) |
| FR-411 English and zh-TW text; keyboard, screen reader, contrast; 320 px without sideways scroll | T808, T810, T813 | `apps/extension/tests/accessibility-localization.test.ts` (en-US and zh-TW key sets equal, line 14); chip: "moves with the arrows, closes on Escape with the focus back on the chip, and on a press outside"; "closes when the focus goes on to something outside it (Tab), but not for its own chip's press"; "closes the mode menu when it opens, and the other way round"; "says the change line in zh-TW too"; "says a remembered model that is no longer offered in the panel's words, in zh-TW too". Gate test "L10: by keyboard alone at 380 and 320 px, light and dark - every control reachable and nothing scrolls sideways"; gates vis-a1..a6-* (en/zh-TW × light/dark, 380 px) | ✓ unit (text, keys, keyboard); contrast and 320 px: result: see gate run. Uncertain: no jsdom accessibility test covers the chip (`conversation-a11y.test.tsx` does not mention it) |
| FR-412 no model or effort setting on the settings page; everything else as in 0.16.1 | T821, T822 | settings polish: "FR-412 the settings page gains no model or effort setting (D-025-10)" › "shows nothing of a remembered model list or choice the overview carries". Regression by the existing suites: gates m-unit, m-contract and the packaged `agent-*` gate run | ✓ unit; regression: result: see gate run |
| SC-178 pick model and effort before the first message in at most three presses | T808, T809 | chip: "sends the choice with the start, and nothing extra when the owner chose nothing"; "keeps the popup open when a model or an effort is chosen, and moves the chip". Gate test "L2 + a2: a model and an effort picked before the start - at most three presses, set before the prompt, no change line" (gate live-L2) | unit covers the choice; the press count: result: see gate run |
| SC-179 the agent is on the chosen model before the first or next message, in 100% of cases | T805, T816 | gate m-order; start: first test and "without a choice in the start uses the store's, sending only the part that differs" (recorded request order, helper that checks no set request follows the first `session/prompt`); resume: all of T816's tests above; "DeepSeek's grouped values go back byte for byte, with no effort and no mode request". Gates live-L2, live-L3, live-L8 | ✓ unit (stand-in agent records the order); live: result: see gate run |
| SC-180 each accepted change leaves one line; a refused one leaves the model and shows the agent's text, no retry | T811, T813 | change: "a model change: one request, one line …"; "refused: result model-refused with the agent's scrubbed text, one notice, no line, nothing retried, nothing kept"; chip: "draws one line for an accepted change, naming the effort too when the model moved it"; "says a refused change in the panel's words with the agent's own text, once (no second error card)". Gates live-L4, live-L6, vis-a6-* | ✓ unit; live and visual: result: see gate run |
| SC-181 no agent configuration file changed by any picker action | T825 | Gate live-L14, the free real-agent probe (four agents, offer parsed, set accepted, agent config hashes before and after). The unit tests only show that Hallpass sends nothing but `session/*` requests (FR-402) | pending: T825 has not run; result: see gate run |
| SC-182 the picker makes no model call before the owner sends a message | T805, T811 | Indirect: start and change tests show a pick sends only `session/set_config_option` or `session/set_model` (change: "a model change: one request …"; refused: "exactly one request"). No test asserts that no `session/prompt` is sent by picker actions alone; the fake agent's request log is read in gate L2 ("set before the prompt"). Direct: change: "SC-182: choosing a model and an effort makes no model call - no session/prompt reaches the agent" (a start carrying a choice plus two changes: four `session/set_config_option`, no `session/prompt`) | ✓ unit |
| SC-183 every control by keyboard alone, both languages and themes, 320 px and 380 px | T808, T813 | chip: arrow, Escape and Tab tests under FR-411; "is shown but not open while a permission card waits" (focusable while disabled). Gate test "L10: by keyboard alone at 380 and 320 px, light and dark - every control reachable and nothing scrolls sideways"; gate test "L7 + a4: while the agent answers the chip is disabled but focusable, says when it can change, and is by keyboard" (gate live-L7) | unit covers the keys in one language; both languages, both themes and 320 px: result: see gate run. Uncertain: L10 has no gate id in the acceptance file |

## Supporting tests (no requirement row of their own)

- **T798/T799 contracts** (`contracts`, describe "025 model picker contracts"): "takes a model entry with an
  optional description and refuses every bound"; "takes an offer from the session options or from the older
  list, and one that reports none"; "keeps configIds for the session options only, and no efforts for the older
  list"; "names defaults that are listed values"; "bounds the lists at 64 models and 16 efforts, and the option
  ids"; "takes a choice of values and refuses anything else"; "takes the live state as an offer with what the
  agent last reported, under the offer's own rules"; start: "takes the chip's choice, and still starts without
  one", "takes an effort alone, as set-model does", "refuses a choice that is not values"; set-model: "takes a
  model, an effort or both, in the broker and panel unions and on the link", "needs at least one of model and
  effort, and nothing else"; "carries the remembered offer and the last choice on an agent entry", "carries the
  live state or the stored choice on a view".
- **T800/T801 offer parser** (`offer`): bounds and bad entries (R-400), "is undefined only when the answer is not
  an object", "reports none for an object with neither source, or with unreadable ones", "survives an object that
  throws when read", the DeepSeek-like grouped options cases.
- **T802 fake agent** (`fake agent`, describe "fake ACP agent models (025 T802, FAKE_ACP_MODELS)"): the shapes
  none, config, config-no-effort, models, refuse, and the load default.
- **T803/T819 store** (`store`): "re-reads the file before every write, so another broker's agents stay"; "keeps
  an unreadable file aside as .bad-<time>, logs it, and starts empty"; "refuses an offer the contract would not
  carry, and a version it does not know"; "keeps no choice for an agent it has no offer of"; "an agent that
  reports none is recorded with an empty offer (no chip)"; "two brokers on one file keep both agents".
- **T815 relay** (`relay`): "025 forwards set-model and a start's model choice unchanged".
- **T820 chip** (`chip`): "shows each agent's own offer and choice, and no chip for an agent with an empty
  offer"; "has no chip once the agent on the chip reports none". Gate test "L9: an agent that reports no models
  has no chip after the start, and none at the next new conversation" (gate live-L9).
- **T816 resume** (`resume`): "a load or resume never replaces the stored offer".

## Settings slices (#18, #19, #20)

These ride in 0.17.0 beside the picker; they do not map to FR/SC numbers. Task numbers follow `tasks.md`
(T821, T822, T824); the brief for this file said T817–T820 for them, which are the resume and remembered-list
tasks above.

| Slice | Tasks | Evidence | Gate | Status |
| --- | --- | --- | --- | --- |
| #18 DeepSeek card shows its download size | T821 | polish: "#18 DeepSeek names its download size" › "says about 730 MB on the download button and in the note" | live-L11 | ✓ unit; live: result: see gate run |
| #19 time left while downloading | T822 | polish: "#19 time left while downloading" › "shows the estimate on the collapsed row too, and nothing when the worker has none"; "words it for zh-TW" | live-L12 | ✓ unit; live: result: see gate run |
| #19 toast close button | T822 | polish: "#19 the toast's close button" › "is a dedicated control with a name, a 24 px hit area and its own focus ring" | live-L12 | ✓ unit; live: result: see gate run |
| #19 "Accepts" row | T822 | polish: "#19 the Accepts row" › "says Not known yet for an agent that has not reported its input types" | live-L12 | ✓ unit; live: result: see gate run |
| #19 Theme and Language select labels | T822 | polish: "#19 the Theme and Language selects" › "show their labels, with System as a value only" | live-L12 | ✓ unit; live: result: see gate run |
| #19 zh-TW says 代理程式 in running text | T822 | polish: "#19 zh-TW says 代理程式, not Agent, in running text" › "has no English 'agent' in a settings sentence" | live-L12 | ✓ unit; live: result: see gate run |
| #20 `agent-settings-024` L2 timing | T824 | No unit test: the fix is in the wait of `tests/e2e/packaged/agent-settings-024.spec.ts`, measured first (`.scratch/025/gate-020.md`) | live-L13 (three full green runs) | pending; result: see gate run |

## Gaps and open points

- FR-410: GAP — no test asserts that the remembered file is not published or sent elsewhere.
  It holds by construction: the store is written only by the broker into the per-user data folder,
  outside the tree `git archive` publishes, and the host makes no network request with it; the code
  review of the combined diff found no other reader.
- FR-412 and SC-182: closed after the first draft by the two tests named in their rows.
- SC-181: pending T825 (gate live-L14).
- FR-409 and FR-407 are covered by unit tests only; no live gate scenario drives them.
- FR-411 / SC-183: gate test L10 has no gate id in the acceptance file, and there is no jsdom accessibility
  test of the chip.
- #20 (T824) and the gate runs (T823 results) are open.

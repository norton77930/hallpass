# Research: Side-Panel Model Picker (025)

Decisions R-398..R-410. Measured shapes: a free probe on 2026-10-26 (`initialize` + `session/new`, no
prompt) of claude-agent-acp 0.81.2, codex-acp 1.13.1, dsh 0.2.1-rc.2 and Hermes 0.22.2; the raw answers
are kept in the private evidence folder (`.scratch/025/acp-shapes`) and are **not** test fixtures: the
DeepSeek and Hermes answers name the owner's own provider and model, so tests use invented names with the
same shape.

## R-398 - What each agent reports, and what Hallpass reads

| Agent | Field read | Model option | Effort option | Other options (never read) |
|---|---|---|---|---|
| Claude Code | `configOptions` | `category: "model"`, 13 values, `default` = "Default (recommended)" | `category: "thought_level"`, 6 values incl. `default` | `mode`, `model_config` (fast) |
| Codex | `configOptions` (also reports `models`, 40 `model[effort]` pairs - ignored, R-399) | `category: "model"`, 7 values, no `default` | `category: "thought_level"`, 6 values, no `default` | `mode`, `collaboration_mode`, `model_config` (fast) |
| DeepSeek | `configOptions` | `category: "model"`, **grouped** options (`group` = provider), each value a JSON-string tuple | none | none |
| Hermes | `models` (`availableModels[]` `{ modelId, name, description? }`, `currentModelId`) | all entries | none | none |

- **Decision**: the broker reads, from the answer of `session/new`, `session/load` and `session/resume`
  (and from every `config_option_update` and `session/set_config_option` answer), exactly one `select`
  option of category `model` and at most one `select` option of category `thought_level` - the first of
  each in the agent's order. Any other category, any `boolean` option, and any option without a category
  is never read and never set (FR-399). Groups are flattened in order; the group's name is kept as the
  entry's description when the entry has none.
- **Values are opaque**: an option value (Claude `opus`, DeepSeek's JSON tuple, Hermes `provider:model`)
  is passed back exactly as received; Hallpass never parses or builds one.
- **Rationale**: categories are the ACP way to tell a model selector from a mode selector; a client
  "MUST handle missing or unknown categories gracefully", so an unknown one is simply not offered.

## R-399 - Session options win; Hermes through the older list

- **Decision**: when `configOptions` has a `model` option, it is the source (`source: "config"`) and
  `models` is ignored, even when present (Codex). Otherwise `models` with at least one entry is the source
  (`source: "models"`, no effort). Neither: the agent reports no models (US4: no chip once known).
- **SDK check**: `@agentclientprotocol/sdk` 1.9.0's client `request()` maps responses without validating
  them (`agentRequestSpecsByMethod[method]?.mapResponse`), so the unstable `models` field reaches the
  broker as received, and `session/set_model` (listed in the SDK's session-header methods) can be sent
  with the same `request()`. The broker validates both with its own closed zod schema (R-400).
- **Setting**: `session/set_config_option { sessionId, configId, value }` for `config`; its answer is the
  full new `configOptions`, read as in R-398. `session/set_model { sessionId, modelId }` for `models`; its
  answer carries nothing the broker needs, the model is then the one asked for unless a later report says
  otherwise.
- **Alternatives**: parsing Codex's `model[effort]` pairs - rejected, it duplicates the session options
  with a naming convention of one agent.

## R-400 - One normalised offer, bounded and closed

- **Decision**: `model-offer.ts` (pure) turns an agent's answer into a **model offer** (data-model.md):
  `source`, `configIds` (for `config`), up to 64 models and 16 efforts with `value`, `name` (clipped to
  120), optional `description` (clipped to 300), the agent's `default` value if it has one, and the
  `current` values. Entries whose value is not a string of 1-512 characters are dropped; a list left
  empty means "reports none". It never throws on an agent's answer: anything it cannot read is "reports
  none" plus a broker log line (no names logged).
- **Default**: an entry whose value is `default` is the agent's default (Claude, model and effort);
  otherwise there is none, and the current value at `session/new` before Hallpass set anything is what
  "the agent's default" means for the start (spec assumption). The default entry is listed first.
- **Rationale**: the panel and the store see one shape for four agents; bounds keep the overview frame far
  under the 1 MB link cap.

## R-401 - The remembered list and last choice: a host file

- **Decision**: `<data>\agent-models.json` = `{ version: 1, agents: { <agent>: { offer, seenAt, choice? } } }`,
  written by `model-store.ts` the way the conversation index is (re-read, then temp + rename,
  `writeHostFileAtomically`), so the brokers of two browsers keep each other's agents. `offer` is replaced
  at every `session/new` of that agent (D-025-11, FR-400) - not at a load or resume, whose list belongs to
  an older session. `choice` (`{ model, effort? }`) is written when a start carried a choice and when a
  change was accepted (D-025-4). An unreadable file is kept aside as `agent-models.json.bad-<time>` and
  the store starts empty (logged; no panel notice - the cost is one "Default" chip until the next start).
- **Overview**: each agent's availability entry gains `models?: { offer, choice? }` from the store; the
  offer's `current` is dropped there (it is a session's, not the agent's).
- **Why the host, not `chrome.storage`**: two browsers on one computer share one list (edge case), the
  broker is the one that sees `session/new`, and the list never has to cross the link to be stored.
- **FR-410**: the file is in the host data folder only; nothing of it is logged by name; the store's path
  is derived from the data folder, never written into a tracked file.

## R-402 - Wire changes (contracts/frames.md)

- `ui.conversation.start` gains `model?: { model, effort? }` - the chip's choice, applied after the session
  opens (FR-401). Absent: the store's choice, else the agent's own.
- New `ui.conversation.set-model { conversationId, model?, effort? }` (at least one), panel and broker
  unions. Refused `busy` during a turn or with a card open (FR-403), `model-refused` with the agent's own
  text when the agent refuses (FR-405), `model-unknown` when the value is not in the conversation's offer.
- New event `{ type: "model", model, effort?, effortChanged?: true }` - names, not values, so the line and
  replay need no lookup; `effortChanged` marks the D-025-12 case (a model change that moved the effort).
- New notice codes `model-refused` (`text` = asked, kept, agent's text) and `model-unavailable`
  (a remembered or kept model no longer offered; replaced by the default, FR-407).
- `conversationViewSchema` gains `models?: ConversationModelState` (the live offer with `current`) while
  the agent runs, and `model?: { model, effort? }` (values) from the index entry otherwise.
- `conversationEntrySchema` gains `model?: { model, effort? }` (FR-406). The index file stays version 1:
  an optional field; an older host reading a newer file refuses it (strict) - the same one-way step as
  every earlier entry field, and 0.17.0 ships both together.
- Link protocol stays 2 (R-323): new frame content only, no new frame type.

## R-403 - When the choice is applied

- **Decision**: after the session is open and the mode is set and confirmed (R-316, unchanged), and before
  the start returns - so before any prompt can go out (SC-179) - the conversation applies its **target**:
  the start's `model`, else (new) the store's choice, else (continued) the index entry's `model`. Only the
  parts that differ from the reported current are sent (model first, then effort, each one request).
- **Every session opening**: first start, resume (idle stop, crash, list), Claude's mode reload
  (`session/load` on the same run) and Hermes' mode restart. A reload or restart re-applies the
  conversation's current model; nothing is re-applied when the agent already reports it.
- **Not a change**: no `model` line at the start or at a re-apply (FR-401); the index entry and the store
  are written with what the agent then reports.
- **Rationale**: the start's existing ordering point (after the mode confirmation, before `idle`) is the
  one place every opening passes through.

## R-404 - The conversation list keeps the model

- **Decision**: the index entry's `model` is written at the first start (what the agent reports after
  R-403), after each accepted change, after a re-apply, and when the running agent reports its own change
  (`config_option_update`, R-406), so a later resume ends on what the agent last reported rather than
  reverting it (review round 1, 2026-10-26). The per-agent store's choice is not written on the agent's own
  change; it stays the owner's last choice. A continued conversation's target is that
  value (D-025-6). The panel's list shows nothing new (the spec keeps the list as it is); the view carries
  `model` so a stopped conversation's chip can show it.

## R-405 - Refusals and fallbacks

- **Change refused** (`set-model` answered with an error): no retry, no slash command; the conversation
  keeps the model it reports; one `notice` `model-refused` and the command's result `model-refused` with
  the agent's scrubbed text (FR-405). The panel shows the notice; the chip stays on the kept model.
- **Start-time switch refused**: the start still succeeds on the agent's model; one `model-refused`
  notice; the first message goes out after it (edge case). The store's choice is left as it was.
- **No longer offered** (target value not in the new offer): not sent; the agent's default stays; one
  `model-unavailable` notice naming the remembered model (FR-407); the store's choice and the entry's
  `model` are replaced by what the agent reports.
- **Agent ends mid-switch**: the request fails with `AgentExited`; the existing crash path says so
  (FR-298); the next continue re-applies (R-403).

## R-406 - Following what the agent reports

- **Decision**: `config_option_update` (and a `set_config_option` answer) replaces the conversation's live
  offer and `current`. A change of `current` the owner did not ask for adds no line (FR-409). A model
  change the owner asked for whose answer moves the effort to a value other than the chosen one sets
  `effortChanged` on its line and names the effort the agent now reports (D-025-12, FR-404). The overview
  follows every change.

## R-407 - The chip and its popup (prototype A)

- **Decision**: one chip after the mode chip (`data-chip="model"`), text = model name, plus " · " and the
  effort name when the effort is not the agent's default (or, with no default, when it is not the one
  reported at the start). `ModelMenu.tsx` mirrors `ModeMenu.tsx`: a radiogroup of models (default first,
  current checked, long names ellipsised with the full name in `title` and the accessible name), a
  divider, a radiogroup of effort pills when the offer has efforts. A choice sends at once and keeps the
  popup open (FR-398); Escape closes it with the focus back on the chip; the shared outside-press closes
  it. The prototype `.scratch/025-prototypes/index.html` variant A and its screenshot are the look.
- **Before the start**: the chip reads the agent's remembered offer and choice from the overview; with no
  offer, it says "Default" and its popup has one line saying the list appears once the conversation starts
  (FR-400); an agent known to report none has no chip (US4). The choice is view state until Send, then
  goes with `ui.conversation.start` (FR-401).
- **While a turn runs or a card waits**: the chip is `aria-disabled`, focusable, and its description says
  it can be changed when the agent's turn ends (FR-403).
- **Width**: the chip row already wraps (T605); the model chip gives way after the folder chip.

## R-408 - The worker

- **Decision**: no worker logic. The relay validates panel commands with `conversationPanelCommandSchema`
  and forwards; the overview and views pass through. The worker's own tests gain one case: a `set-model`
  command is forwarded unchanged.

## R-409 - #18 and #19 (settings page)

- **#18**: DeepSeek's card gains its download size (~730 MB) in `DOWNLOAD_SIZE`
  (`apps/extension/src/settings/agent-model.ts`); a text change with its test.
- **#19**: an estimated-time row while a download runs (from the install state's `etaSeconds`, already in
  the overview); a toast close button with a visible focus ring and a larger hit area; the "Accepts" row
  says "Not known yet" instead of "-"; the two selects read "Theme" / "Language" with "System" as a value
  only; zh-TW uses **代理程式** where the settings page says "Agent" in running text (an assumption the
  owner can overrule; product names and the chip labels stay as they are).

## R-410 - #20 (gate timing)

- **Decision**: measure first (project rule): run the `settings-024` spec in full three times with the
  broker's readiness log on, record when the first readiness answer arrives versus the L2 assertion. Fix
  from that measurement - expected: wait for the broker's first overview instead of a fixed time inside
  the 5 s SC-177 bound. Test-only; no product change.

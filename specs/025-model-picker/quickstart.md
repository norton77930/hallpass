# Quickstart: validating the model picker (025)

## Prerequisites

- `npm install`, `npx tsc -b`, `npm run build`.
- The packaged gate set-up from CONTRIBUTING.md (debug-port browser, private `LOCALAPPDATA`,
  `HALLPASS_FOREIGN_AGENT_SERVERS=allow`, `HALLPASS_TEST_MODE=1`, `HALLPASS_BROKER_TEST_AGENT` = the fake
  agent), with `FAKE_ACP_MODELS` choosing the fake agent's model shape (`config`, `config-no-effort`,
  `models`, `none`, `refuse`), documented in the fake agent's header.

## Machine gates

```powershell
npm run typecheck
npm test
npm run build
npm run test:contract
npm run snapshot:check
```

Expected: all green; the broker tests include the recorded-order check (every `session/set_config_option`
/ `session/set_model` before the first `session/prompt`, SC-179) and the "no request but `session/set_*`"
check (FR-402).

## Live gates (packaged gate, fake agent)

| Gate | Steps | Expected |
|---|---|---|
| L1 first use | New conversation, agent with no remembered list | Model chip "Default"; popup says the list appears once the conversation starts |
| L2 pick before start | After one conversation (list remembered): open chip, pick model 2 and effort "High", send | ≤ 3 presses after opening (SC-178); fake agent records set before prompt; no change line |
| L3 last choice | Start another conversation | Chip preselects model 2 / High |
| L4 change between turns | In the running conversation, pick model 3 | One line "Model: <name>"; chip shows it |
| L5 effort fallback | Pick a model that does not offer the chosen effort | One line naming model and the effort now reported |
| L6 refusal | `FAKE_ACP_MODELS=refuse`, pick a model | Notice with the agent's text; chip unchanged; one set request, no retry |
| L7 busy | While a turn runs / a card waits | Chip shown, not openable, says when it can change; keyboard reachable |
| L8 continue | Let the conversation idle-stop (short idle), send again | Fake agent set to the conversation's model before the prompt |
| L9 none | `FAKE_ACP_MODELS=none` | No model chip after the start; none at the next new conversation |
| L10 a11y / width | Keyboard only, en + zh-TW, light + dark, 320 px and 380 px | Every control reachable; no sideways scroll; screenshots in `.scratch/025/shots` |

## Free real-agent probe (no prompt, no model call)

For each of Claude Code, Codex, DeepSeek and Hermes on the owner's machine: `initialize`, `session/new`,
read the offer, set the second model (and an effort where offered), read the answer, close. Compare a hash
of each agent's own configuration files before and after (SC-181). Report: offer parsed (models/efforts
count, source), set accepted, config unchanged. The probe script lives in `.scratch/025` (private), its
report in `.scratch/025/probe-*.md`.

## #18 / #19 / #20

- #18: settings card for DeepSeek shows the download size.
- #19: settings screenshots (en, zh-TW): ETA row during a download, toast close button, "Not known yet",
  "Theme"/"Language" labels, zh-TW wording.
- #20: `settings-024` spec run in full three times, L2 green each time; the measurement noted in the slice.

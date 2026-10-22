# Research: Hermes and DeepSeek in the Side-Panel Conversation

Evidence: spike runs on 2026-10-21 with our own scratch ACP client (scripted mock model, then the owner's own
local model started by the owner, Q37). Raw logs are kept outside the repository.

## R-345 — How each agent is obtained

- **Decision**: three kinds in one descriptor table — `adapter` (an npm ACP adapter over an installed CLI:
  Claude Code, Codex; unchanged), `installed` (an installed program that speaks ACP itself: Hermes, found with
  `where.exe hermes` then `%USERPROFILE%\.local\bin\hermes.exe`, version from `hermes --version`, must equal
  0.22.2), `fetched` (an ACP package fetched into the agent folder: DeepSeek, `@deepseek-ai/dsh` exactly
  0.2.1-rc.2, committed `package.json` + `package-lock.json`, `npm ci --omit=optional --ignore-scripts`).
- **Rationale**: D-021-2/3 (Q34–Q36, Q38). Hermes is a Python program installed by its own installer;
  DeepSeek ships as an npm package like our adapters, so it reuses the existing fetch, integrity and staging.
- **Alternatives**: community `dsh-acp` / `deepseek-acp` (rejected, G29); installing Hermes from Hallpass
  (rejected, Q38: Python toolchain and Git are the owner's).

## R-346 — DeepSeek fetch size and time

- **Decision**: per-agent install timeout; DeepSeek 30 min (measured 9–13 min for 611 packages on this disk),
  others keep 10 min. The first-use card states the size from the measured fetch.
- **Rationale**: a 10-minute bound would fail a slow first fetch that would have finished.

## R-347 — Hermes strict: launch-time tool switch-off

- **Decision**: Hallpass writes `%LOCALAPPDATA%\hallpass\agents\hermes\managed\<strict|agent-review>\config.yaml`
  with fixed content `agent.disabled_toolsets` = strict: `terminal, code_execution, delegation, browser_vault`;
  agent-review: `browser_vault`, and starts `hermes acp` with `HERMES_MANAGED_DIR` pointing at it. Hermes mode
  `default` under strict, `accept_edits` under agent-review (never `dont_ask`).
- **Rationale**: Hermes' own default mode asks before edits but runs shell commands unasked (mock: yes;
  owner's model: `echo`, `ls` and `rm a.txt` ran unasked). The managed layer has administrator-override
  meaning, so it holds over the owner's own settings without writing them. With it, on the owner's model:
  the edit was asked, a file creation the model tried through `write_file` was asked, and the delete could not
  run at all (no command tool) — SC-157 bar met for Hermes.
- **Alternatives**: a separate `HERMES_HOME` (loses the owner's model and keys); a Hallpass guard that
  intercepts commands (Hermes runs them in-process, there is nothing to intercept).

## R-348 — Hermes Git requirement

- **Decision**: discovery also looks for Git Bash (`where.exe bash` within a Git for Windows install, or
  `%ProgramFiles%\Git\bin\bash.exe`); missing Git is an availability **note** (agent still usable under
  strict, where command tools are off anyway), with setup guidance.
- **Rationale**: only Hermes' terminal tool needs Git Bash; strict switches it off.

## R-349 — DeepSeek strict and automatic

- **Decision**: env `DSH_PERMISSION_MODE` = `read-only` (strict) / `workspace-write` (agent-review); never
  `danger-full-access`. Always set explicitly: the `acp` profile alone defaults to `workspace-write`.
- **Rationale**: measured on the mock — read-only asks before edits, commands and anything outside the folder;
  workspace-write runs in-folder actions unasked and asks outside. On the owner's model (2026-10-21, rerun
  after the batch start failure of R-356): read-only asked before the edit, the file creation and the
  delete command, and none took effect; workspace-write ran the in-folder edit, creation and delete unasked
  and asked before writing outside the folder (not written) — SC-157 bar met for DeepSeek strict.

## R-350 — DeepSeek telemetry

- **Decision**: env `DSH_TELEMETRY_MODE=DISABLED` at every launch.
- **Rationale**: the package's default (`FEEDBACK_ONLY`) wires an exporter to the vendor's collector; the
  `DISABLED` value constructs no pipeline and reads no endpoint (package type declarations). Q40.

## R-351 — Launch-time modes and mode changes

- **Decision**: a descriptor declares per panel mode either `agentMode` (set with `session/set_mode`, Claude,
  Codex) or `launch` (env + managed layer: Hermes, DeepSeek; Hermes additionally sets its agent mode). Changing
  a launch-time mode between turns closes the agent and starts it again with the new launch settings, then
  continues the session — Hermes `session/load` (replays), DeepSeek `session/resume` (no replay; the panel
  keeps its own log). Not allowed while a turn runs (same rule as today).
- **Rationale**: tool sets and sandboxes are fixed when the agent starts.
- **Amended 2026-10-22**: the DeepSeek half is replaced by D-021-16 (R-359) - DeepSeek's mode cannot be
  changed by a restart, so it is never restarted for a mode change. Hermes is unchanged.

## R-352 — Old conversations

- **Decision**: Hermes resumes with `session/load` (loadSession true). DeepSeek has no `session/load`; a
  conversation reopened after its agent stopped continues with `session/resume` when the agent still knows the
  session, without replay; the panel shows its stored log plus a note "earlier turns are not shown by the
  agent". If resume fails, `cannot-resume` as today.
- **Rationale**: FR on not-replayable history (D-021-12).

## R-353 — Permission card detail and reject-only

- **Decision**: the broker keeps, per conversation, the last `tool_call` / `tool_call_update` for each
  `toolCallId` (title, kind, rawInput summary). A permission request takes its card detail from the request
  itself; when the request has none, from that announced action. With neither, the card says the action is
  unknown and offers only Reject (`rejectOnly: true`), and an "allow for this conversation" rule never
  answers it. Options are matched by `kind` (allow_once / reject_once) as today; Hermes' `deny` has kind
  `reject_once`, DeepSeek's `allow-once` / `reject-once` have kinds allow_once / reject_once.
- **Rationale**: DeepSeek's request names only the action id (D-021-11, Q42); Allow on an invisible action
  breaks the asking promise.

## R-354 — Long starts and stopping a start

- **Decision**: no broker timeout on `initialize` / `session/new` (measured: Hermes init ~30 s, first
  session up to ~4 min; DeepSeek init 70–348 s). The panel shows "Starting <agent>… the first start can take a
  few minutes" with Stop; Stop sends `ui.conversation.stop` which, on a starting conversation, kills the agent
  process (tree) and ends the start with `start-cancelled`; the conversation goes back to not started and the
  held first message returns to the composer.
- **Rationale**: Q41. Today a starting conversation cannot be stopped and holds a slot of the cap of 3.

## R-355 — What each agent accepts

- **Decision**: unchanged mechanism (022 R-344): the "+" menu follows `promptCapabilities` read at
  `initialize`. Before the first start the descriptor's measured expectation is shown: Hermes image yes,
  context no; DeepSeek image yes, context no (measured with the owner's model 2026-10-22; it depends on the
  configured model, so the start value wins).
- **Rationale**: the mock run reported image false, the owner's model run true — the agent decides per model.

## R-356 — Model unreachable and real-model measurement

- **Decision**: an agent error during a turn that names the model endpoint (connection refused, 401/403) is
  shown with setup guidance pointing to the agent's own configuration (D-021-9); Hallpass never asks for a
  key. SC-157 is re-measured for DeepSeek on the owner's model before release; the 2026-10-21 batch failed to
  start DeepSeek inside the batch runner while a single start outside it succeeded (70 s, owner's model
  listed), so the failure is in the runner, not the agent.
- **Rationale**: G31, Q32/Q37.

## R-357 — DeepSeek is fetched with its optional dependencies

- **Decision**: the `npm ci` command line is the agent descriptor's (`npmCiArgs`). The Claude Code and Codex
  adapters keep `--omit=optional` (their bundled CLI is left out, R-315); DeepSeek is fetched without it
  (`ci --ignore-scripts --no-audit --no-fund`). `--ignore-scripts` stays for every agent.
- **Rationale**: the owner's live run of the Hallpass-fetched DeepSeek stopped at boot with "host
  preparation failed: No usable native binding found for node-addon-require-builtin-win32-x64-msvc": dsh's
  platform native bindings are optionalDependencies in its lock, so `--omit=optional` dropped them.
  Measured 2026-10-22 with the new arguments against the shipped manifest and lock in a fresh folder: 611
  packages in 7 min 30 s, `node_modules` 63 600 files, 726 MB (693 MiB), so the "about 700 MB" figure
  stands; the fetched `lib/bin.js --profile acp` answered `initialize` after 54 s (no model call made).

## R-358 — A start failure is a version problem only for another version

- **Decision**: a refused `initialize` or first `session/new` is `agent-version` ("Tested with X, found Y")
  only when the version found differs from the tested one (or the modes the agent offers do not fit,
  `session/set_mode`); with the tested version it is the start failure `agent-exited`, "<agent> <version>
  could not start", with the agent's own words. A message that says no model provider is set up (Hermes:
  "not connected to any AI provider yet. Run `hermes model`") is `agent-model-unreachable`, whose hint names
  `hermes model`. Every path keeps the SC-161 scrubbing.
- **Rationale**: the owner's live run showed "Tested with DeepSeek 0.2.1-rc.2, found 0.2.1-rc.2" for a boot
  crash (R-357) and the same version notice for a Hermes without a model; both sent the owner looking for a
  version problem that did not exist.

## R-359 — DeepSeek keeps the mode its session was created with

- **Decision**: D-021-16. DeepSeek's mode is fixed once its conversation has started: chosen with the start
  (`ui.conversation.start`'s `mode`), kept on every resume (launched with that mode's environment so the
  two agree), and a switch is refused `mode-fixed` with no restart. The agent descriptor says it
  (`modeFixedOnceStarted`), and the contract names the agents for the panel
  (`CONVERSATION_MODE_FIXED_AGENTS`).
- **Rationale**: measured 2026-10-22 against dsh 0.2.1-rc.2. The package pins a session's sandbox and
  permission mode into the session's own log at `session/new` (its `dsh-permission-presets` module,
  `pinInitialPermission`), and its sandbox policy prefers that persisted value over the launch environment
  when it resolves a session's mode (`dsh-sandbox-policy`, `resolve()`). R-351 changed DeepSeek's mode by
  restarting it with a new `DSH_PERMISSION_MODE` and `session/resume`-ing the same session, so the new
  environment was ignored: a live strict → automatic switch stayed read-only, and by the same code
  automatic → strict would have stayed `workspace-write` while the panel said "Ask first" - the wrong way
  across the consent boundary. ACP offers no other way to set it: the agent has no ACP modes, and its
  `session/set_config_option` takes only the model and the reasoning effort. FR-289's "every resume starts
  strict" cannot hold for DeepSeek for the same reason, so its resume keeps the conversation's mode.

## R-360 — The first start takes the mode chosen before the first message

- **Decision**: FR-361. For every agent the panel sends the empty conversation's mode chip with
  `ui.conversation.start` (`mode`, absent for strict) and switches nothing beside the first message; the
  broker starts the agent in that mode and confirms it as on any start (R-316: Claude's new session has no
  strict ask rules in automatic, then `auto`; Codex `agent`; Hermes its automatic layer and `accept_edits`;
  DeepSeek `workspace-write`), reports it in the first `mode` event and records it in the index.
- **Rationale**: found by the driver dry run 2026-10-22 (mode chip "Agent review" before Send, "Ask first"
  once started) and measured at the broker with the panel's own order - `set-mode` and the first `send`
  together, which the broker runs as they arrive: Claude's switch reloaded the session and the first
  message was refused `busy`; Hermes' first turn began before its restart, so the switch was refused
  `busy` and the conversation stayed strict; Codex happened to win the race. DeepSeek took Hermes' path.
  Starting in the chosen mode leaves nothing to race.

## R-361 — A resumed Hermes session keeps its stored system prompt

- **Decision**: keep `session/load` for Hermes after a mode change (the history matters) and record the
  limitation: after strict → automatic the model may still believe the old tool limits until told otherwise,
  although the command tools are available. No change to the restart. (R-357..R-360 above already cover the
  DeepSeek fetch, start-failure wording, DeepSeek's fixed mode and the first start's mode; not repeated.)
- **Rationale**: measured 2026-10-22 in Hermes 0.22.2. `agent/conversation_loop.py` reuses a session's stored
  system prompt unless the model, provider, session or working folder change, so a mode change alone leaves the
  old prompt. The tools themselves are recomputed from the current configuration on every session load
  (`acp_adapter/session.py`: `_restore` -> `_make_agent` -> `load_config`), so the Hallpass managed layer of the
  new mode applies: the request dump after the Agent review restart lists `terminal` and `execute_code`. Only the
  model's belief about them can lag; telling it once in the next message is enough.

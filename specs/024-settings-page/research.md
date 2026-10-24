# Research: Settings Page (024)

Hallpass facts are from this branch (13a6ff2), read for this plan; nothing was run. File references are
repo-relative. Owner questions raised by this research are marked **Owner question** and listed again in
plan.md; the plan proceeds on the recommended answer and changes if the owner picks another.

## R-372 — The settings page is the extension's options page, opened in a tab (D-024-1, FR-375)

- **Finding**: the manifest has no options entry (`apps/extension/src/build-config.ts` 141-150, 196-213);
  Vite builds the side panel and offscreen documents only (`apps/extension/vite.config.ts` 31-44) and
  `apps/extension/scripts/write-manifest.ts` 67-90 moves each emitted HTML to the dist root. The `tabs`
  permission is already granted (`tests/contract/manifest.contract.test.ts` 16-28 pins the list).
- **Decision**: a third HTML entry `src/settings/index.html` emitted as `settings.html`; the manifest gets
  `options_ui: { page: "settings.html", open_in_tab: true }`. The side panel opens it with
  `chrome.tabs.create({ url: runtime.getURL("settings.html#<route>") })`, or focuses an open settings tab
  found with `chrome.tabs.query({ url: runtime.getURL("settings.html") + "*" })` and updates its hash.
  Routes: `#agents`, `#agents/<agent>`, `#sites`, `#sites?site=<canonical origin>`, `#tools`,
  `#connection`.
- **Rationale**: "extension options" is the browser's own entry point (D-024-1); no new permission, so the
  pinned permission list stays equal.
- **Alternatives rejected**: `chrome.runtime.openOptionsPage()` alone (cannot carry a route for deep
  links); a page inside the side panel (the spec asks for a full tab).

## R-373 — The settings page gets its own port and its own trust check (FR-375, FR-385, FR-386)

- **Finding**: the worker accepts only the port `hallpass-panel` (`apps/extension/src/service-worker/
  bootstrap.ts` 22-31), and `isTrustedControlSender` (`service-worker/shared-port.ts` 29-34) requires
  `sender.url === sidePanelUrl` and `sender.tab === undefined`. A page in a tab fails both. The panel port
  also feeds "seen" (`agent-panel-port.ts` 120-128): a connected document in the focused window makes
  consent cards count as seen (demo-day fix 2026-09-23), with shorter pairing bounds and no badge.
- **Decision**: a second port name `hallpass-settings` with its own check: `sender.id === runtime.id`,
  `sender.frameId === 0`, `sender.tab` present, and `sender.url` without its hash equal to
  `runtime.getURL("settings.html")`. Settings ports never take part in "seen", the badge or the waiting
  count, and receive a settings projection (data-model.md) without prompts, consent cards or session
  details. They may send only a closed `settingsCommandSchema` (contracts/frames.md); session actions
  (stop, interrupt, release, withdraw plan) and prompt answers stay panel-only.
- **Rationale**: the settings page changes standing permissions (site modes including Skip checks,
  revoke, unpair, the side-panel-agent switch). Granting it the panel's whole command set, or making it
  count as a panel, would let a page with no consent cards answer for one.
- **Risk**: this widens which extension documents may change permissions — an authorization boundary
  (R2 trigger, plan.md). Code review and architecture review before release.
- **Alternatives rejected**: relaxing `isTrustedControlSender` to any extension URL (any future page would
  inherit full authority); sending settings changes through `chrome.storage` written by the page (the
  worker must stay the only writer of permission state).

## R-374 — Readiness is the existing local check, bounded at 5 s and kept (D-024-19, FR-397)

- **Finding**: `agentAvailability` (`packages/agent-host/src/broker/agents.ts` 509-552) already works from
  local facts only: `where.exe` and known per-user paths (397-435), `--version` (453-461), the pinned
  adapter's package.json (486-491), Git Bash for Hermes (438-450). Its exec bound is 15 s (282-285). It is
  refreshed on link attach, after install and after a start failure (broker.ts 316-325, commands.ts
  381-392); no command asks for it. Batch files (`codex.cmd`) are run through `cmd.exe /d /s /c`
  (agents.ts 588-606), refusing paths with quotes, `%` or newlines (598).
- **Decision**: a new `ui.conversation.check-agents` command (optionally one agent) re-runs the check with
  a 5 s bound per external command, run per agent in parallel so one hung program cannot hold the others;
  the result is kept in the broker until Check again, a finished install or a new settings-page connect.
  A `.cmd` shim counts as found, because Hallpass starts it through `cmd.exe`; one whose path Hallpass
  refuses to run counts as Not installed with that reason. This is how D-024-19's "a shim that cannot be
  started directly" applies here.
- **Amendment (2026-10-25, T794)**: a timed-out `--version` of a found program is retried once at the
  launch bound (15 s) in the background. The real Hermes 0.22.2 answers `--version` in 6-11 s on the
  owner's machine. The first answer (Not installed, "did not answer `--version` within 5 s") goes out as
  before, so SC-177 holds; a retry that answers replaces it through the next overview, and one that times
  out again or reads no version leaves it. Each check carries a generation per agent: a newer check or
  the broker's shutdown aborts the retry, which ends its process tree, and a result older than the one held
  is dropped (`commands.ts` `refreshAgents` / `retryVersion`).
- **State mapping** (D-024-14): `ready` without warnings → Ready; `ready` with notes (`git-missing`,
  `pre-release`) or Hermes setup steps not done → Ready with warnings; `needs-install` → Needs a download;
  `installing` → Downloading; `missing` or `version-problem` → Not installed, with the reason line
  (wrong Hermes version says the tested version).
- **Alternatives rejected**: a model call on open (D-024-19); a resident watcher of PATH (no gain for a
  page the owner opens rarely).

## R-375 — Per-computer facts live in shared files; per-browser choices in the extension (D-024-16, FR-396)

- **Finding**: one broker runs per browser (`broker-launch.ts` 112-165, sidecar `brokers/<browserId>.json`);
  installed trees and pointers are already shared under `%LOCALAPPDATA%\hallpass\agents\<agent>\`
  (agents.ts 296-316). An install in flight is joined only inside one broker (commands.ts 369-375).
- **Decision**: three files per agent in that folder, written atomically: `install-state.json`
  (phase, estimated percent, started-at, browserId and pid of the installing broker, outcome),
  `install.lock` (created exclusively; stale when its pid is gone), `last-test.json` (outcome, model time,
  failure, ran-at). A broker with a settings page connected re-reads them every 1 s and sends changes; an
  install request while another broker holds the lock follows that install instead of starting `npm ci`
  again. Enabled agents and the default stay in the extension (R-380).
- **Alternatives rejected**: brokers talking to each other (new IPC for one page); one broker per computer
  (undoes 019 Q4 and 018's per-browser brokers).

## R-376 — Download percent and time left are estimates from the growing install tree (FR-379)

- **Finding**: `installAgent` (`broker/install.ts` 138-215) reports phases only; npm prints no byte counts
  (57), so the panel shows indeterminate progress today.
- **Decision**: the release step records each pinned agent's installed size (bytes of its tree after a
  clean `npm ci`) in the shipped agent manifest; during `downloading` the broker samples the size of the
  staging tree every 1 s, reports `min(99, size / expected)` percent and time left from the rate over the
  last 10 s; `finishing` shows 99 % until done. Without a recorded size, progress stays indeterminate. The
  card says the figures are estimates (spec Assumptions).
- **Measurement before build**: one scratch `npm ci` of the DeepSeek and Codex trees to confirm the tree
  grows steadily (not written in one burst at the end); if it does not, percent is dropped for that agent
  and only the phase and elapsed time show. Recorded in `.scratch/024`.
- **Alternatives rejected**: replacing `npm ci` with Hallpass's own downloader (re-implements npm's
  integrity checks); parsing npm's log output (not a stable interface).
- **Addendum 2026-10-24 (T737–T738, measured; supersedes the size-based decision above)**: a clean
  DeepSeek `npm ci` took 693–844 s for 726 MB in 63 600 files; walking that tree took ~9 s, so sampling
  bytes every second is not possible. Installed package folders (a `package.json` present, two directory
  levels per scope) grow steadily instead: Codex 18 of 18 by 22 s, DeepSeek 72 at 20 s, 447 at 206 s, 609
  at 494 s, done at 693 s. So: percent = installed package folders ÷ the expected count, computed at run
  time from the shipped lockfile (entries under `node_modules/`, minus all optional ones for an adapter,
  minus optional ones whose `os`/`cpu` exclude win32/x64 for a fetched agent; measured 18 = 18 and
  613 ≈ 611), held at ≤ 95 % until the pinned package is verified; no folder yet → Preparing with no
  percent; time left only from 10 % on, from the last 30 s rate. No size is recorded at release.
  Evidence: `.scratch/024/install-growth.md`.

## R-377 — Cancel ends the install's process tree and removes its staging folder (FR-379)

- **Finding**: `runCommand` (`broker/run-command.ts` 17-24) has a timeout but no signal; `npm ci` starts
  node children; the broker's kill-on-close job (`broker/job.ts`) covers the whole broker only.
- **Decision**: `runCommand` takes an `AbortSignal`; abort ends the tree with `taskkill /T /F /PID`, waits
  for exit (bounded 5 s), then removes the `.install-*` folder and the lock, and the state returns to
  Needs a download. A new `ui.conversation.install-cancel` command carries the agent.
- **Alternatives rejected**: a nested Job Object per install (more native code for the same effect);
  killing only `npm` (its children keep writing).

## R-378 — "Interrupted" comes from a state file left by a broker that died (D-024-9)

- **Finding**: closing the browser ends the broker through the browser watch and kill-on-close job
  (lifetime.ts 47, job.ts 3-12); leftovers are removed at start by `cleanStaging` (install.ts 292,
  broker.ts 170). There is no broker-level idle exit: only conversations idle out (conversation.ts 77,
  1659-1671), and installs are not conversations.
- **Decision**: on start, a broker that finds `install-state.json` not finished whose pid is gone rewrites
  it as `interrupted` (kept until the next attempt), then runs `cleanStaging`. FR-379's "MUST NOT end itself
  for being idle" holds today; a broker test pins that an install longer than the conversation idle time
  completes and the broker stays up.
- **Alternatives rejected**: a separate download process that outlives the browser (rejected by D-024-9).

## R-379 — Test is a one-prompt conversation outside the pool (D-024-10, FR-381)

- **Finding**: `Conversation.start` (conversation.ts 643-~840) and `Conversation.send` (1046) are usable
  alone; `ConversationPool.start` (1930-1957) admits, counts against the running cap of 3 and indexes. The
  browser-tools check (839-857) waits for the worker's greeting; the key-name check is R-369.
- **Decision**: a `TestRun` builds a `Conversation` directly in a fresh folder
  `%LOCALAPPDATA%\hallpass\agent-tests\<id>\`, strict mode, not admitted, not indexed, not counted against
  the cap; sends one fixed prompt asking for the single word OK; total bound 90 s; then stops, ends the
  process tree and removes the folder. The result names: start (ok or the start failure), model (answered
  with time, or the 023 model-unreachable text, plus the key-name check for Hermes), browser tools (from the
  local check: Hermes' MCP component found, DeepSeek not supported). One test per agent at a time; the
  result is written to `last-test.json` (R-375). The test copy gets no browser token, so it never opens
  tabs or asks for consent.
- **Alternatives rejected**: testing through a pool conversation (counts against the cap, shows in the
  conversation list, could evict the owner's idle conversation); a live browser-tools greeting (would
  pair a hidden session with the owner's browser).

## R-380 — Enabled agents and the default are a worker-owned record per browser (D-024-2, D-024-15)

- **Finding**: the composer picks `defaultAgent(lastAgent, agents)` (`side-panel/agent/conversation/
  last-agent.ts` 58-65) from `conversationLastAgent` in `chrome.storage.local`; no enabled flag exists in
  any contract.
- **Decision**: a worker-owned `agentChoices` record in `chrome.storage.local`
  (`{ enabled: Record<agent, boolean>, default: agent | null }`). First run: all enabled; default from
  `conversationLastAgent` if that agent is ready, else the fallback order Claude, Codex, Hermes, DeepSeek;
  then `conversationLastAgent` is removed. Switching off the default moves it per D-024-15 and the change
  is announced on the page. The projection carries the record to the panel and the page; the picker lists
  enabled agents and preselects the default.
- **Alternatives rejected**: keeping "last used" as the default (the owner chose an explicit default);
  storing choices in the host (they are per browser, D-024-16).

## R-381 — The side panel's second tab becomes Sessions (D-024-11, D-024-18, FR-392..394)

- **Finding**: `PANEL_TABS = ["conversation", "connections"]` (`AgentShell.tsx` 464-466, stored as
  `agentPanelTab`); the tab renders StatusRow, BrowserRow, PanelConsentSwitch, session cards and SiteList
  (663-726); the waiting count counts prompts only (515-519).
- **Decision**: rename to `"sessions"` (a stored `"connections"` reads as `"sessions"`); keep the
  connection line of StatusRow, NotConnected and the session cards; remove BrowserRow, PanelConsentSwitch,
  SiteList and StatusRow's Unpair and upload path. A session card with a current site carries "Manage this
  site's permissions ↗" (route `#sites?site=`). No session → empty line and settings link. Waiting count
  unchanged.

## R-382 — Theme and language: today there is no choice to follow (FR-389, D-024-7)

- **Finding**: the side panel's theme follows the operating system (`side-panel/agent/tokens.css` 15, 66)
  and its language the browser's UI language (`side-panel/App.tsx` 15, `locales/catalog.ts` 21-23). No
  stored preference exists, yet the prototype's top bar has theme and language controls and FR-389 says
  the page follows "the side panel's language and theme (System / Light / Dark)".
- **Owner question Q-A**: add one shared appearance choice (`agentAppearance`:
  theme System/Light/Dark, language System/English/繁體中文), set from the settings page's top bar and
  followed at once by the side panel and the page, default System (today's behaviour)? *Recommended: yes.*
  Alternative: no controls; both follow the system and browser as today, and the top bar drops them.
- **Owner decision (2026-10-24)**: yes → D-024-20.

## R-383 — Upload folders have Remove only; "Add folder" does not exist today (FR-385)

- **Finding**: the only upload-root commands are list, remove (`ui.agent.upload-root-clear`,
  `packages/contracts/src/agent-tools.ts` 4515; link frames 3553-3579) and the agent-initiated consent
  request (014). A folder is added when an agent asks to upload from it and the owner agrees. An extension
  page cannot learn a folder's path from the browser's folder picker, so "Add folder" would need the host
  to open a Windows folder dialog — a new way to widen what agents may upload.
- **Owner question Q-B**: keep Remove only, with a line that folders are added when an agent asks
  (today's behaviour, FR-385 amended), or add a host-side folder dialog? *Recommended: Remove only.*
- **Owner decision (2026-10-24)**: Remove only (A) → D-024-21; the prototype's Add folder is dropped.

## R-384 — The page reuses the panel's tokens and controls (FR-389, FR-390)

- **Finding**: `tokens.css` and `agent.css` are imported by `AgentShell.tsx` 26-27; every rule is scoped
  under `.agent-shell`. The locale contract test (`tests/contract/locales.contract.test.ts` 167-210) scans
  `side-panel/agent/*.tsx` against `AGENT_PANEL_KEYS`.
- **Decision**: the page root carries `agent-shell settings-page`, imports the same two sheets plus
  `settings.css` for its layout (left navigation, 375 px top row). Moved components (site list, unpair
  list, upload folders, browser rename, consent switch) move to `src/settings/`; the scan is extended to
  `src/settings/**/*.tsx` with a `SETTINGS_KEYS` list.

## R-385 — Packaged gate: the default tab and the moved controls (FR-392)

- **Finding**: the e2e driver clicks `#agent-tab-connections` by default (`tests/e2e/fixtures/
  side-panel-driver.ts` 212-225); `unpairAgent` uses the status menu (`fixtures/agent-pairing.ts` 67-79);
  seven specs unpair through it and nine touch site rows, upload roots or the consent switch.
- **Decision**: the driver's default becomes `#agent-tab-sessions`; a new `settings-page-driver.ts` opens
  `settings.html` in a tab and drives sites, unpair, upload folders, the switch and rename; affected specs
  switch fixtures. New gate spec `agent-settings-024.spec.ts` covers the live gates (quickstart.md).

## R-386 — Contract changes are additions, versions stay paired (FR-391)

- **Finding**: host and extension versions are pinned equal (`packages/agent-host/src/tool-offering.ts`);
  an older host refuses an unknown conversation command and the panel says `host-outdated`
  (conversation.ts 788).
- **Decision**: new commands and optional fields only (contracts/frames.md); release as 0.16.0 with the host
  reinstalled. The settings page treats `host-outdated` as "the helper needs updating" in Connection &
  diagnostics.

## R-387 — An agent's last output comes from its latest run, conversation or test (FR-387)

- **Finding**: the ring of 50 scrubbed lines is per conversation (conversation.ts 887-939); the request is
  `ui.conversation.diagnostics` by conversation (commands.ts 429-434).
- **Decision**: an optional `agent` on the diagnostics request returns the most recent run of that agent
  in this broker, a conversation's or a test's, with its read time; nothing is read before the owner asks.
  Scrubbing as today (`broker/redact.ts`); user paths are replaced with `%USERPROFILE%`-relative text before
  sending (SC-174, FR-395 copy).

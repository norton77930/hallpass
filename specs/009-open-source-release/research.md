# Research: Open-Source Release as Hallpass 0.3.0

Numbering continues from 008 (R-132–R-143). Sources: the read-only repository audit of 2026-09-19,
the narrow-build dependency map of 2026-09-19 (both by Explore agents, verified where cited), and the
owner's decisions D-009-1–10.

## R-144 — The rename is a literal table, applied once

**Decision**: one mechanical pass over every tracked text file except `package-lock.json` (regenerated
by `npm install`), `tests/acceptance/probe-004/reports/**` (leaving the repository) and the private
reference documents (also leaving; renaming inside them is pointless), using this table, in this
order (longest and most specific first, so `com.poc.agent_host` is not half-renamed by `poc-agent`):

| Old | New | Where it lives |
| --- | --- | --- |
| `com.poc.agent_host` | `com.hallpass.host` | host manifest name, registry key, installer/uninstaller, `host-paths.ts`, `install/manifest.ts`, tests, docs |
| `poc-agent-host` | `hallpass` | `%LOCALAPPDATA%` directory name (`host-paths.ts`), installer, docs, upgrade proofs |
| `poc-browser-agent` | `hallpass` | `scripts/package.ts` `PACKAGE_NAME`, package README, upgrade proofs, QA guide |
| `poc-browser` | `hallpass` | MCP server name (`SERVER_NAME` in `tool-offering.ts`), installer's `claude mcp add` line, every `mcp__poc-browser__` tool prefix in docs and probe scenarios, `.mcp.json` |
| `@poc/` | `@hallpass/` | six `package.json` names + every import specifier |
| `ai-browser-assistant-poc` | `hallpass` | root `package.json` |
| `__POC_BUILD_MODE__`, `__POC_BUILD_PROFILE__`, `__POC_PRODUCTION_IDENTITY__` | `__HALLPASS_…__` | vite defines, `build-profile.ts`, `vite-env.d.ts`, tests that set them |
| `POC_` (env vars and constants, 37 distinct names) | `HALLPASS_` | test configs, fixtures, gate specs, probe harness, docs (`POC_CDP_ENDPOINT` → `HALLPASS_CDP_ENDPOINT`, etc.) |
| `POC_ACTIONS`, `POC_CAPABILITIES`, `POC_HELLO_CAPABILITIES`, `PocAction`, `isPocAction` | `BRIDGE_ACTIONS`, `BRIDGE_CAPABILITIES`, `BRIDGE_HELLO_CAPABILITIES`, `BridgeAction`, `isBridgeAction` | `packages/contracts/src/capabilities.ts` and consumers (these survive S2 because `content-broker.ts` and `action-dispatcher.ts`'s agent-side use them; S2 prunes what does not) |
| `Browser Agent Bridge` | `Hallpass` | `extName.agent`, `agent.appTitle`, `extActionTitle.agent` ("Open Hallpass"), `extCommandDescription.agent` ("Open the Hallpass side panel"), watermark assertions, QA guide |
| `瀏覽器代理橋接` | `Hallpass 瀏覽器代理橋接` in `extName.agent` and `agent.appTitle`; `開啟 Hallpass` in the two action keys | `zh-TW.ts`, QA guide |
| `0.2.0` (product version) | `0.3.0` | `AGENT_EXTENSION_VERSION`, `SERVER_VERSION`, package README, tests that pin it |

Not renamed: the word "poc" inside `epoch`/`documentEpoch` (the audit's case-insensitive count was
mostly this — verify with word boundaries); `TEST_BUILD_EXTENSION_ID`/`TEST_BUILD_PUBLIC_KEY` (the
identity key, kept on purpose, FR-125); spec and requirement identifiers (FR-, SC-, PR-, D-, R-, T-).

**Why a table and not a regex over `poc`**: `epoch` and `PocAction` both match `/poc/i`; the table
names every real identifier, and the S3 forbidden-pattern scan (word-bounded `\bpoc\b`, `@poc/`,
`poc-`, `com.poc.`, `POC_`) catches anything the table missed.

## R-145 — The identity contract test reads built artifacts, not source

**Decision**: `tests/contract/hallpass-identity.contract.test.ts` builds nothing; it reads what the
existing contract tests already read (the manifest writer's output for the agent target, the host
manifest the installer would write via `install/manifest.ts`, `SERVER_NAME`/`SERVER_VERSION`,
`PACKAGE_NAME`, the six workspace `package.json` names, both locale catalogs' `extName.agent`) and
asserts the Hallpass values, then scans the bundled host (`bundleHost` from `scripts/package.ts`,
already used by `qa-package.contract.test.ts`) and the emitted `dist/agent/**` (when present) for
`/\bpoc\b|@poc\/|poc-|com\.poc\.|POC_/`. RED against the current names, GREEN after S1.

## R-146 — What the agent worker actually composes today (verified)

`apps/extension/src/service-worker/bootstrap.ts` line 18: `export const serviceWorkerRuntime =
composeServiceWorker();` at module load, imported by both `index.ts` (narrow) and `index-agent.ts`.
`composeServiceWorker()` (`runtime.ts`) resolves the build config with the hard-coded
`SHIPPING_PROFILE = "narrow"` and stands up `AuthController`, the product task-channel client, the
control runtime (`control-port.ts`), the marker store, the content broker wiring, and registers
`chrome.runtime.onConnect` → `serviceWorkerRuntime.onControlConnect(port)` for every port that is not
the agent panel's, plus `chrome.tabs.onUpdated` → `onBoundDocumentChanged`. The agent path
(`agent-entry.ts` → `agent-runtime.ts`) needs none of it.

**Decision**: `bootstrap.ts` becomes the agent-only bootstrap: `bindActionEntry()`, `onConnect` →
`agentPath.accept(port)` when the name matches (else disconnect), no `serviceWorkerRuntime`, no
`tabs.onUpdated` (the agent path has its own tab manager). `index.ts` (narrow entry) is deleted;
`index-agent.ts` is renamed `index.ts` and the vite config's entry branch goes. `runtime.ts` and the
modules only it reached are deleted:

- worker: `runtime.ts`, `auth-controller.ts`, `task-channel-client.ts`, `context-monitor.ts`,
  `control-port.ts` (after R-147), `action-dispatcher.ts`, `page-read-controller.ts`,
  `marker-store.ts`, `operation-markers.ts`, `fetch-with-timeout.ts` (verify: only `runtime.ts`),
  `origin-safety-controller.ts` (verify), `chrome-adapters/identity.ts`, `chrome-adapters/session-storage.ts`
  (verify the agent path does not use it), `chrome-adapters/control.ts`;
- panel: `ActiveControl.tsx`, `AuthPanel.tsx`, `ConsentReview.tsx`, `GrantsPanel.tsx`, `PlanReview.tsx`,
  `SafetyReview.tsx`, `ServicePanel.tsx`, `TaskPanel.tsx`, `TaskWorkspace.tsx`, `workspace-controller.ts`,
  `human-labels.ts` (verify); `App.tsx` renders the agent shell only (the lazy import may stay — it
  is harmless — or become static; keep lazy to leave the chunking unchanged);
- tests: the 25 narrow-only files listed by the map (auth-controller, marker-*, operation-marker-store,
  page-read-controller, us3-*, action-lifecycle, control-port-*, task-channel-lifecycle,
  service-worker-runtime, service-health-http, origin-safety-fetch, auth-restore-validation,
  marker-restart-recovery, side-panel-{control,productization,task,session}, narrow-manifest-guard) and
  `tests/acceptance/narrow-manifest.pre-004.json`; mixed: `side-panel-app.test.tsx` (keep the agent
  branch cases, drop the narrow ones and the profile toggle), `side-panel-reconnect.test.tsx`,
  `side-panel-lna-bootstrap.test.tsx` (review: keep if they test the agent shell through `App`).
- `content-broker.ts`, `page-ports.ts`, `effect-verification.ts`, the whole `content-runtime/` and
  `chrome-adapters/action-entry.ts` stay: shared.

The implementer verifies each "verify" with a grep before deleting; anything the agent path still
imports stays and the brief's list is corrected in the task note.

## R-147 — Two shared exports leave `control-port.ts` first

`agent-panel-port.ts` imports `isTrustedControlSender`; `agent-tools/wait.ts` imports
`DEFAULT_WAIT_POLL_MS`. **Decision**: move both, with their tests' relevant cases, to
`service-worker/shared-port.ts` before `control-port.ts` is deleted; nothing else about them changes.

## R-148 — `export-ignore` is the exclusion mechanism; a script proves it

**Decision**: `.gitattributes` at the root lists the private set with `export-ignore`:

```
docs/reference-*.md export-ignore
tests/acceptance/probe-004/reports/** export-ignore
.specify/** export-ignore
.claude/** export-ignore
CLAUDE-CODE-HANDOFF.md export-ignore
.mcp.json export-ignore
.scratch/** export-ignore
tests/acceptance/*checkpoint*.md export-ignore
tests/acceptance/owner-remaining-runbook.md export-ignore
tests/acceptance/local-run-checklist.md export-ignore
tests/acceptance/evidence-index.md export-ignore
tests/acceptance/browser-matrix.md export-ignore
.gitattributes export-ignore
```

`git archive` honours it, so the snapshot is one command with no copy script to get wrong.
`scripts/snapshot-check.ts` runs `git archive HEAD --format=tar` into a temp directory, lists it,
fails on any path matching the private set, then scans every file for the forbidden patterns of
FR-129 (owner username, the private checkout path in both slash styles, the two reference store IDs,
the reference build hash, the five legacy identifiers) minus the entries of
`scripts/snapshot-allowlist.txt` (`path:line-substring` per line). A contract test runs it and
expects zero hits; in the public repository the private set is simply absent and the check stays
green (edge case in the spec). The forbidden strings are held in the script as split literals or
computed values so that the script does not itself trip the scan.

**Rejected**: a copy script with its own exclusion list (two sources of truth); `git filter-repo` on
the private history (D-009-1 rejected it).

## R-149 — Where the specs live, and the speckit tooling inconsistency

**Decision**: the spec trees stay at `specs/` in the private repository and are published at `specs/`
too — the owner's "docs/specs/" intent was "bring them along"; keeping the path avoids moving 73
files, keeps `.specify/feature.json` and every relative link valid, and `specs/` at the root is a
conventional location. Recorded as a deviation from the literal decision, substance unchanged.

**Inconsistency recorded (IV)**: D-009-1 says development continues in the public repository; the
owner's confirmed exclusion list keeps `.specify/` (templates, constitution, scripts) and `.claude/`
(skills, agents) out of the snapshot. Without them the speckit workflow does not run in the public
repository. This plan follows the confirmed list — the exclusion is one line each in `.gitattributes`
and reversible in a minute — and raises the question in the closing report with a recommendation:
publish `.specify/` and `.claude/skills`+`agents` after the snapshot check passes over them (they
contain no personal data; the constitution names the reference extensions only generically), keep
`.claude/settings.local.json`, `.claude/worktrees` and memory out.

**Resolved (owner, 2026-09-21)**: publish the tooling. `.specify/**`, `.claude/skills/**` and
`.agents/skills/**` (the Codex mirror of the same skills, referenced by `.specify/integrations/codex.manifest.json`)
leave the export-ignore set; `.claude/scheduled_tasks.lock`, `.claude/settings*.json` and
`.claude/worktrees/**` take their place. The forbidden-pattern scan over the 42 added files: 0 hits.
There is no `.claude/agents` directory in this repository; the earlier wording assumed one.

## R-150 — Design notes replace evidence citations

91 citation sites across the spec trees point at a private evidence document or one of its sections. **Decision**:
`docs/design-notes.md` has one numbered section per matched behaviour family (§1 cursor and click
delivery, §2 recording frames and overlays, §3 dialogs and consent chaining, §4 tab groups, banner and
ownership, §5 window sizing and restore, §6 form values and downloads, §7 what was deliberately not
matched), each stating the behaviour adopted, the reason, and what differs — in our words, no
internals. The mechanical rewrite maps each citation to its section (008's recording section →
`design-notes §2`, 004's §3f → §1, and so on; the table is in tasks.md) or, where a citation carried
only a measurement, keeps the number and drops the reference. The scan of FR-130 (SC-068) is the
check.

## R-151 — README shape and the demo GIF

**Decision**: README sections in FR-132 order. The comparison table's rows are facts checked on
2026-09-19 against the three projects' READMEs (attach target, logins, consent, stop, recording,
dialogs, platform, licence); where a competitor's README is silent the cell says "not stated". The
demo GIF is recorded with `gif_recorder` on the packaged gate (Chromium, unattended recipe): start,
navigate to Wikipedia, type a search, click, export as `demo`, copied from the download folder to
`docs/media/demo.gif`; the frames carry the Hallpass watermark, which is itself a proof the rename
reached the artifact. If the gate cannot run (browser unavailable), the README ships without the
GIF and the task is marked owed — the GIF is illustration, not a claim.

## R-152 — CI on `windows-latest` only

**Decision**: one job, `npm ci`, `npm run typecheck`, `npm test`, `npm run test:contract`. The
contract suite's four pre-existing `ENOENT` failures on a checkout that has never built `dist/` (seen
in 008) must be made conditional (skip with a reason when `dist/agent` is absent) so CI is green on a
clean clone; that is a test change, not a product change. No matrix, no cache secrets, no browser.

## R-153 — What the release proof records

**Decision**: `coverage.md` records: the identity test result; the gate run (spec list, pass counts,
Chromium version); the upgrade proof outputs (extension + host); the snapshot check output (0/0); the
from-scratch build log summary (commands, exit codes, zip name and SHA-256); the repository URL,
commit SHA, CI run URL, tag, release URL and asset SHA-256, issue #1 URL; the QA guide's page URL and
version; and the two items owed to the owner (switch to public; the R-149 question).

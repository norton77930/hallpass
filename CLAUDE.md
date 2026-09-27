# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hallpass: a Manifest V3 Chrome extension plus a local stdio MCP server that lets coding agents drive
the user's own Chrome under per-site, per-action consent given in the side panel. Windows 11 only,
Node >= 24, npm workspaces, TypeScript, React (side panel), Vite (extension bundles). The README
has the user-facing tool list and consent model; `CONTRIBUTING.md` has the build and test detail.

## Commands

```powershell
npm install
npx tsc -b                    # build the packages (workspaces consume each other's dist/)
npm run build                 # tsc -b + extension -> apps/extension/dist/agent (the only build target)
npm run agent-host:install    # register the native host for this checkout (HKCU, no admin)

npm run typecheck             # packages + extension + tests tsconfigs
npm test                      # vitest projects "unit" (node) + "extension-ui" (jsdom, *.test.tsx)
npm run test:contract         # vitest project "contract" — reads the BUILT artefacts; build first
npm run snapshot:check        # scans the next commit's tree for strings/paths that must not be published

npm run package               # release/hallpass-<version>.zip (extension + Vite-bundled host + install.ps1)
```

CI (`.github/workflows/ci.yml`, windows-latest) runs, in order: `npm ci`, typecheck, `npm test`,
`npm run build:extension`, `npm run test:contract`, `npm run snapshot:check`.

Single test: `npx vitest run --project unit packages/domain/src/foo.test.ts` (or add `-t "<name>"`).
Project membership is by path — see `vitest.config.ts`: `packages/**/*.test.ts` and
`apps/extension/tests/**/*.test.ts` are `unit`, `apps/extension/tests/**/*.test.tsx` are
`extension-ui`, `tests/contract/**` is `contract`.

After an extension rebuild, reload it at `chrome://extensions`; the host needs no reinstall unless
the checkout moves. Anything Node runs directly under `--experimental-strip-types` (`scripts/*.ts`,
`apps/extension/scripts/*.ts`, `tests/harness/*.ts`, the release runners) cannot import a sibling
`.ts` through a `.js` specifier — it must import a built `dist/` module. Typecheck and vitest accept
the `.js` form, so the mistake only surfaces when the gate's webServer exits at startup.

### Browser suites (local only, not in CI)

- **Packaged gate** — `tests/e2e/packaged/agent-*.spec.ts` via `playwright.extension.config.ts`
  (single worker, no retries, each run writes to its own `test-results/<run-id>/`). It attaches to
  a Chrome started with `--remote-debugging-port=9222` with `apps/extension/dist/agent` loaded:
  `HALLPASS_CDP_ENDPOINT=http://127.0.0.1:9222 npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/<spec> --reporter=list`.
  To stay off the bridge of the everyday browser, give both the browser and the runner a private
  `LOCALAPPDATA` and set `HALLPASS_FOREIGN_AGENT_SERVERS=allow` (refused with the default
  `LOCALAPPDATA`). The page fixtures (`npm run dev:test-pages`, `https://localhost:19443`) need the
  test TLS certificate: `npm run test:certs:install` / `test:certs:verify`.
- **Acceptance probes** — `npm run probe:004` drives the bridge with a real `claude -p` session and
  costs API calls; run for a release, not per change.

## Architecture

Three runtime parties, and the protocols between them are closed schemas in `packages/contracts`
(`strictObject` everywhere: an undeclared field is refused at the boundary).

```
coding agent ──stdio MCP──> mcp-server.js ──loopback TCP──> native-host.js ──native messaging──> service worker
 (one per agent session)    (packages/agent-host)            (relay, spawned by Chrome)            (apps/extension)
```

- **`packages/agent-host`** — `mcp-server.ts` is spawned by each agent session and is the
  long-lived side. `native-host.ts` is the relay Chrome spawns through the registered host
  manifest (Chrome always starts its own host, it never attaches to a running one). The relay
  listens and every MCP server dials in; `relay-mux.ts` routes frames by `callId`/`sessionId` so N
  sessions share one native port, and the relay forwards frames unchanged — it carries no policy.
  They find each other through `%LOCALAPPDATA%\hallpass\bridge.json`, which only the relay writes
  (`bridge-link.ts`; one writer, N diallers — an earlier N-writer design broke multi-session). `tool-offering.ts` says which contract tools this host actually carries and pins
  the host version to the extension's. `install/` writes the host manifest and HKCU registry keys
  for Chrome, Chromium, Edge and Brave. `upload-policy.ts` / `upload-config-store.ts` enforce
  `uploadRoots` in `%LOCALAPPDATA%\hallpass\config.json`.
- **`apps/extension/src/service-worker`** — all authority lives here or in the host:
  `agent-bridge.ts` (native port), `agent-runtime.ts` (sessions, pairing, dispatch),
  `agent-tab-manager.ts` (per-session tab groups), `agent-panel-port.ts` (broadcast to every open
  side-panel document — there can be several). `agent-tools/` has one runner per tool family;
  `agent-tools/gate.ts` is the single pure function deciding whether an effect may run under the
  site mode (`ask` default / `follow-a-plan` / `skip-checks`). `recording/` is the GIF recorder.
- **`apps/extension/src/content-runtime`** — injected into pages: element refs, targets, field
  state, the agent cursor and page-edge indicator. Built by a separate Vite config
  (`vite.content-runtime.config.ts`, `vite.agent-content.config.ts`) and validated after build.
- **`apps/extension/src/offscreen`** — GIF encoding/rasterising. **`side-panel/agent`** — the React
  consent/status UI (pairing cards, consent cards, session cards, site list).
  **`chrome-adapters/`** — thin wrappers over `chrome.*` APIs (debugger, tabs, tab groups, capture…).
- **`packages/domain`** — pure policy with no Chrome dependency: grants, canonical origins,
  origin safety, form-value redaction, task plans.
- **`packages/test-kit`** — shared test helpers; `tests/harness/` has the fake agent worker, an
  MCP client and the HTTPS page fixtures.

The extension manifest is generated (`apps/extension/scripts/write-manifest.ts`) with a fixed key,
so the extension ID is stable and the native host accepts only that ID. Contract tests pin the
manifest permissions, the host/extension version pairing, and that shipped source contains no test
tooling or references to other products.

## Project rules that are not obvious from the code

- **Spec-driven.** Every feature has a directory under `specs/NNN-*` (spec, plan, research
  decisions `R-###`, tasks `T###`, coverage file); code comments cite those IDs. The spec-kit
  workflow lives in `.specify/` (constitution in `.specify/memory/constitution.md`) with skills in
  `.claude/skills/speckit-*`. A behaviour change amends the relevant spec's change log or opens a
  new spec; a fix does not need one.
- **Clean room.** Hallpass matches observable behaviour of other products (`docs/design-notes.md`),
  but never copies or adapts their source, bundles, assets, identifiers or protocols. Describe the
  behaviour in your own words and implement it independently.
- **Public snapshot.** The public repository is produced by `git archive`; `.gitattributes`
  `export-ignore` keeps private files out (`docs/reference-*.md`, probe reports,
  `CLAUDE-CODE-HANDOFF.md`, `.mcp.json`, `.scratch/`…). `npm run snapshot:check` fails on the
  maintainer's account name or local checkout path, other extensions' IDs, and the project's old
  pre-release identifiers — so never write absolute local paths into tracked files. Exceptions go in
  `scripts/snapshot-allowlist.txt` as `path::substring`.
- **Test first, two attempts then stop.** A behaviour change comes with the one focused failing test
  that would have caught its absence. If a fix fails twice, stop guessing: take one measurement
  (log line, timing, gate screenshot) and restart from it.
  This overrides the "tests are optional" default in `.claude/skills/speckit-tasks`: task lists
  generated here include a test task for every behaviour change.

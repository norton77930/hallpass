---

description: "Task list for The QA Installation Package"
---

# Tasks: The QA Installation Package

**Input**: `/specs/007-qa-package/spec.md`

**Tests**: contract test on the zip's contents and the bundle's imports; the existing host tests run
against the bundle; the install itself is proven by hand on this machine from a temp folder (SC-052).

**Numbering** continues from 006 (T188–T200): this feature starts at **T201**.

## Plan (short)

- Bundler: Vite 8's JS API (`build()` with `ssr` entry, `target: "node24"`, `ssr.noExternal: true`,
  `rollupOptions.external: [/^node:/]`, `format: "es"`) from a script `scripts/package.ts` run with
  `node --experimental-strip-types`. Three entries: `packages/agent-host/src/mcp-server.ts`,
  `native-host.ts`, `install/cli.ts` → `host/mcp-server.js`, `host/native-host.js`, `host/install.js`.
  The installer resolves `native-host.js` relative to its own file (`cli.ts:30`), so the bundle's
  `install.js` next to `native-host.js` works from any folder.
- Zip: Windows' built-in `tar.exe` (`tar -a -cf <zip> -C <stage> .`), PowerShell `Compress-Archive` as
  fallback; both already on the machine.
- Version: `apps/extension/dist/agent/manifest.json` `version` → file name and `VERSION`.
- `install.ps1`: locate `host/` relative to `$PSScriptRoot`; check `node -v` ≥ 24; run
  `node host/install.js install`; write `config.json` only if absent; print + clipboard (`Set-Clipboard`)
  the JSON and the `claude mcp add` line; `-Register claude-code` optional.

## Phase 1

- [x] T201 `scripts/package.ts` (NEW): build agent extension (`npm run build:extension:agent` via
  `execFileSync`), bundle the three host entries with Vite into `release/stage/host/`, copy
  `dist/agent` → `release/stage/extension/`, write `README.md`, `install.ps1`, `uninstall.ps1`, `VERSION`,
  zip to `release/hallpass-<version>.zip`, remove the stage. `package.json` script
  `"package": "node --experimental-strip-types scripts/package.ts"`. `release/` in `.gitignore`.
  B: `scripts/package.ts` (Vite 8.2 `build()` per entry, `ssr` + `ssr.noExternal: true`, `rolldownOptions.external: [/^node:/]`, es output, no maps); zip via `%SystemRoot%\System32\tar.exe -a` (Compress-Archive fallback); `npm run package` → `release/hallpass-0.1.0.zip` (647 497 B; mcp-server.js 842 232 B, native-host.js 254 375 B, install.js 10 313 B). `cli.ts` now calls `resolveRelayEntryPath(import.meta.url, existsSync)` from `manifest.ts` (sibling first, then parent) — unit-tested in `install.test.ts`.
- [x] T202 `tests/contract/qa-package.contract.test.ts` (NEW): runs the bundler step into a temp dir (not
  the zip) and asserts each host file's `import`/`require` specifiers ⊆ `node:*`; asserts the zip
  produced by a full run (skipped when `release/` has none) contains exactly the US1.1 list.
  B: `tests/contract/qa-package.contract.test.ts` — bundles into a temp dir via `bundleHost`; statement-anchored import scan (bundled ajv carries `require("ajv/...")` as codegen *text*) ⊆ Node built-ins, no `createRequire`/`__require` shim; zip root entries == US1.1 when `release/*.zip` exists; plus the T204 script-string checks. 6/6 green with the zip present.
- [x] T203 `packages/agent-host/tests/bundle-smoke.test.ts` (NEW): spawns the bundled `mcp-server.js`
  through the existing fake worker/relay harness (`tests/harness/fake-agent-worker.ts`, `mcp-client.ts`)
  and does initialize + `tabs_context`; skipped when the bundle is absent, run by `npm run package`'s
  verification step.
  B: `packages/agent-host/tests/bundle-smoke.test.ts` — `describe.skipIf` unless `HALLPASS_HOST_BUNDLE` or `release/stage/host/mcp-server.js` exists; harness gained `HALLPASS_MCP_SERVER_ENTRY` env + `entry` option. `npm run package` runs it with `HALLPASS_HOST_BUNDLE` set and fails on red. The bundle runs with no `package.json` beside it (Node 24 ESM syntax detection).
- [x] T204 `scripts/package/install.ps1` + `uninstall.ps1` (NEW, copied into the zip): per FR-096/097;
  `-Register claude-code`; `-Purge` on uninstall. Restores a previously existing host manifest on
  uninstall (`.bak` written by install).
  B: `scripts/package/install.ps1` / `uninstall.ps1` (UTF-8 BOM, CRLF, StrictMode, Stop, exit codes, HKCU only). install: node ≥ 24 check, backs up manifest **and** `native-host.cmd` to `.bak` once, `node host\install.js install`, `config.json` only if absent, prints extension path + JSON (doubled backslashes) + `claude mcp add` line, `Set-Clipboard` in try/catch, `-Register claude-code`. uninstall: `install.js uninstall`, restores both `.bak` and re-adds both HKCU keys, `-Purge` (whole data dir, or only `config.json` when a backup was restored), prints manual steps. Both parse under PowerShell 5.1; not executed on this machine (T206).
- [x] T205 `scripts/package/README.md` (NEW, zh-TW): FR-098 with the four-client table (Claude Code CLI
  `claude mcp add`; Claude Desktop `%APPDATA%\Claude\claude_desktop_config.json`; Codex CLI
  `~/.codex/config.toml` `[mcp_servers.hallpass]`; Cursor `~/.cursor/mcp.json` or project
  `.cursor/mcp.json`) + "any stdio MCP client" line; first use; files; uninstall; reporting.
  B: `scripts/package/README.md` (zh-TW, 8 sections, four-client table + any-stdio line, first use, site modes paragraph, files table, uninstall, what to attach).
- [x] T206 Close: `npm run package` on this machine; extract to `%TEMP%`, `install.ps1`, load the
  extracted extension in the dedicated Chrome, one real call through the harness client (host from the
  extracted path), `uninstall.ps1`, repo install restored (`bridge.json`/host manifest path back to the
  repo); `docs/operations-guide.md` §1 gains "或用安裝包" and points at the README; memory.
  B (2026-09-14): `npm run package` → zip; extracted to `%TEMP%hallpass-qa-install`; `install.ps1` exit 0 (Node check, `.bak` of manifest + launcher, launcher repointed to the extracted `native-host.js`, JSON + `claude mcp add` line printed and on the clipboard); `extension/` byte-identical to `dist/agent` (`diff -rq`); worker reloaded → Chrome spawned the **extracted** relay (pid 89548); one real call through the extracted `mcp-server.js` (stdio JSON-RPC: initialize → `hallpass`, pairing card accepted in the real side panel, `tabs_context` ok, stderr `agent.dial.attached 89548 … agent.call.completed ok`); `uninstall.ps1` exit 0 restored the repo's manifest + launcher + both HKCU keys, kept `config.json`; worker reloaded → repo relay back (pid 10168). The attach-family gate could not be used for this (two of the owner's other Claude Code sessions hold `mcp-server.js` — a product behaviour, not a defect). `docs/operations-guide.md` §1 points at the package. Feature 007: 6/6 tasks.

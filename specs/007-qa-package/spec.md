# Feature Specification: The QA Installation Package

**Feature Branch**: `007-qa-package` (logical feature identifier; this workspace has no Git metadata)

**Feature Directory**: `specs/007-qa-package`

**Created**: 2026-09-14

**Status**: Complete 2026-09-14 — T201–T206 done; installed and exercised from a temp folder on the owner's machine (tasks.md T206)

**Input**: Owner, 2026-09-14: "後續要提供給 QA 人員進行測試,不可能整包程式都給他吧?應該會有安裝包?" and, on
the client question, "應該是讓 User 自己設定就好?因為 User 不一定是用 Claude Code" — build a
self-contained package a tester installs without the repository, that does not assume which MCP client
they use.

## Why this feature exists

Today the agent build runs only from this checkout: the extension must be built into `dist/agent`, and
the host (`mcp-server.js`, `native-host.js`) imports `@modelcontextprotocol/sdk`, `zod` and
`@hallpass/contracts` from `node_modules`. The installer writes a host manifest that points into the repo. A
tester therefore needs the whole repository, Node, npm and a build — which is not a test of the product.

The MCP server is a standard stdio MCP server; nothing in it is specific to Claude Code (the pairing
card even shows the client's own name from `initialize`). The package must therefore hand the tester
the one thing every client needs — the absolute path of the server — and leave the client's own config
to them, with a reference table for the common ones.

## Owner decisions

| ID | Decision |
| --- | --- |
| D-007-1 | **Shape**: one zip, `hallpass-<version>.zip`, containing the extension folder (loaded unpacked), a self-contained host folder (two bundled `.js` files + the bundled installer), `install.ps1` / `uninstall.ps1`, and a `README.md`. Produced by one command, `npm run package`. The Chrome Web Store (unlisted) is a later phase, not this feature. |
| D-007-2 | **Node 24 is a prerequisite** of this package (checked by `install.ps1`, stated in the README). A single executable (Node SEA) is a follow-up, decided after the tester list is known. |
| D-007-3 | **The installer configures no MCP client.** It ends by printing — and copying to the clipboard — the ready-to-paste server definition with the resolved absolute path (JSON `{command, args}` and the `claude mcp add` one-liner). An explicit `-Register claude-code` switch may run `claude mcp add` when `claude` is on PATH; otherwise it prints and does not fail. |
| D-007-4 | **README lists four clients** — Claude Code, Claude Desktop, Codex CLI, Cursor — with where each keeps its MCP config and the snippet to add, plus one line for any other stdio MCP client. |

## Acceptance standard

The package is proven by installing it **outside the repository**: the zip is extracted into a temporary
directory on this machine, `install.ps1` is run there, the extension folder is loaded from there, and a
real MCP client (the test harness's stdio client, standing in for any client) makes one call through the
host started from the extracted path. The repository's own install must be untouched afterwards
(`uninstall.ps1` restores the previous host manifest when one existed).

## User Scenarios

### US1 — Build the package (Priority: P1)
1. **Given** a built checkout, **When** `npm run package` runs, **Then** `release/hallpass-0.1.0.zip`
   exists and contains exactly: `extension/` (the agent build), `host/mcp-server.js`, `host/native-host.js`,
   `host/install.js`, `install.ps1`, `uninstall.ps1`, `README.md`, `VERSION`. No `node_modules`, no source
   maps, no `.d.ts`.
2. **Given** the zip, **Then** the two host files import nothing but `node:*` built-ins (self-contained).

### US2 — Install from the zip (Priority: P1)
1. **Given** the zip extracted to any folder, **When** `install.ps1` runs, **Then** it checks `node` ≥ 24,
   writes the host manifest and both HKCU registry keys pointing at the extracted `host/`, writes an empty
   `config.json` only if none exists, prints the extension folder to load and the server definition with
   the absolute path, and copies the definition to the clipboard.
2. **Given** `-Register claude-code` and `claude` on PATH, **Then** `claude mcp add hallpass --scope user
   -- node <path>` runs; without `claude`, the line is printed and the script exits 0.
3. **Given** the extension folder loaded unpacked, **Then** its ID is `adgpccmmbgnchnphfaoabfflfcepbopd`
   (the manifest key is in the package) and the side panel opens in the not-paired state.
4. **Given** a client configured with the printed path, **Then** the first call raises the pairing card and,
   accepted, succeeds — the host ran from the extracted folder.

### US3 — Uninstall (Priority: P2)
1. `uninstall.ps1` removes the registry keys and the host manifest it wrote, keeps `config.json` unless
   `-Purge`, and prints what the tester still removes by hand (the extension in `chrome://extensions`, the
   client's config entry).

## Requirements

- **FR-094**: `npm run package` builds the agent extension, bundles the host into self-contained files
  with the repo's existing bundler (no new dependency), and writes the zip under `release/`.
- **FR-095**: The bundled host files behave exactly as the unbundled ones: the existing host tests run
  against the bundle (at least `mcp-server` initialize + one tool round trip through the fake worker).
- **FR-096**: `install.ps1` is idempotent, needs no elevation (HKCU only), fails with a clear message on
  Node < 24 or missing `node`, and never edits any MCP client's config unless `-Register` is given.
- **FR-097**: The installer's printed server definition uses the extracted absolute path with correct
  escaping for JSON and for the `claude mcp add` line.
- **FR-098**: `README.md` (zh-TW, en-US section optional) covers: prerequisites, install, load the
  extension, the four-client table, first use (pairing card), where files live, uninstall, and where to
  report problems (`relay.log`, the panel's technical details).
- **FR-099**: The repository's checkout install is unaffected by packaging; `narrow-manifest-guard` stays
  byte-identical; `npm test` / `test:contract` unchanged or extended.

## Success Criteria

- **SC-051**: zip contents exactly as US1.1; both host files' imports ⊆ `node:*` (contract test).
- **SC-052**: Install from a temp folder on this machine → one real call through the extracted host
  succeeds; `uninstall.ps1` restores the repo's host manifest.
- **SC-053**: README's four snippets each name a real config location for that client as of 2026-09.

## Out of scope

Chrome Web Store listing; a Node-free executable; code signing; auto-update; macOS/Linux installers
(the host's Windows installer is what exists today).

## Change Log

| Date | Change | Origin |
| --- | --- | --- |
| 2026-09-14 | Initial specification; D-007-1–4 | Owner discussion 2026-09-14 |

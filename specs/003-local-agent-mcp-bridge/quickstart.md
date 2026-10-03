# Quickstart: Local Agent MCP Bridge

Runnable validation for feature 003. Prerequisites are 001's test PKI and page fixtures (see
`specs/001-ai-browser-assistant/quickstart.md`); this feature adds the native host and the `agent`
build profile. Windows/PowerShell.

## Build and install

```powershell
npx tsc -b
npm run build:extension:agent           # NEW: builds apps/extension/dist/agent with the agent profile
npm run agent-host:install              # NEW: writes the host manifest + HKCU registry key
```

`build:extension:agent` produces a manifest declaring `<all_urls>`, `nativeMessaging`, `tabs`,
`tabGroups`, `alarms` and `debugger` (US6). US7 needed no permission of its own: the *host* reads the
owner's files under the roots they configured, and the bytes travel in the frame. The `narrow` build is
unchanged and still produces the archived remote-service artifact.

### What the installer writes, and how it was verified (T011)

`agent-host:install` is idempotent — running it twice is the same as running it once — and writes,
all under `%LOCALAPPDATA%\hallpass\`:

| Thing | Value |
| --- | --- |
| `native-host.cmd` | `@echo off`, then the installing node by absolute path - `"<node.exe>" "<repo>\packages\agent-host\dist\native-host.js" %*` - with a fallback to `node "<…>\native-host.js" %*` from PATH when that file is gone (since 0.11.1: a browser can hand the host an environment whose PATH cannot find node) |
| `com.hallpass.host.json` | `{ name, description, path: <the .cmd>, type: "stdio", allowed_origins: ["chrome-extension://adgpccmmbgnchnphfaoabfflfcepbopd/"] }` |
| `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hallpass.host` | default value = the manifest path |
| `HKCU\Software\Chromium\NativeMessagingHosts\com.hallpass.host` | default value = the manifest path |

Both roots are written because branded Chrome reads the first and Chromium builds — including the
bundled Chromium every packaged gate runs against — read the second. `agent-host:uninstall` removes
all four; `node packages/agent-host/dist/install/cli.js status` prints which of them exist.

Verified on 2026-09-08 against bundled Chromium 151 with `dist/agent` loaded unpacked: with the host
installed and an MCP server running, the worker's `connectNative("com.hallpass.host")` caused Chrome
to spawn `native-host.cmd`, and a `tabs_context` call travelled agent stdio → MCP server → loopback →
relay → worker and back in 6 ms. The relay writes a per-connection trace of stable codes to
`%LOCALAPPDATA%\hallpass\relay.log` (truncated on each start, no page content), which is where
to look first if Chrome appears not to spawn the host at all.

## Configure the agent (Claude Code)

Add the MCP server to the agent's config, as a stdio server spawned by absolute path:

```json
{
  "mcpServers": {
    "hallpass": {
      "command": "node",
      "args": ["<repo>\\packages\\agent-host\\dist\\mcp-server.js"]
    }
  }
}
```

The agent spawns *that*; Chrome separately spawns the relay through the host manifest the installer
registered, and the two meet on the loopback link (R-102).
**Since 004/R-111 the relay is the side that listens**: it
publishes `%LOCALAPPDATA%\hallpass\bridge.json` and every MCP server dials that record, so any
number of agent sessions share one browser (see `specs/004-reference-parity-bridge/quickstart.md`).
On first connection the extension shows a
pairing prompt; accept it once. Uploads additionally need `uploadRoots` in
`%LOCALAPPDATA%\hallpass\config.json`, which the installer writes empty (no uploads at all).

## Validation scenarios

Each maps to a success criterion and an attach-mode packaged journey.

- **Scenario 1 — Pair (US1 / SC-020, SC-026)**: start a session, run `tabs_context`, see the pairing
  prompt once, get the tab list; unpair from the extension and confirm the next call is refused within
  ~1 s; a second session needs no prompt.
- **Scenario 2 — Read (US2 / SC-027)**: open the `ordinary` fixture in the agent tab; `get_page_text`,
  `read_page` (interactive filter), `find "the primary button"`, `screenshot` each return the fixture's
  known content; each restricted-page kind answers `not-readable`.
- **Scenario 3 — Act under a mode (US3 / SC-023)**: set the fixture site to `skip-checks`; click/type/
  key/scroll/hover/double/drag/form_input each change the page as the fixture defines. Set the site to
  `ask`; one action shows the prompt and nothing happens until answered; a `no` runs nothing.
- **Scenario 4 — Tabs (US4 / SC-024)**: create a tab (joins the marked group), navigate to two
  fixtures, go back, list tabs (only the group's), close the tab; a `tabId` outside the group is
  refused.
- **Scenario 5 — Batch + wait (US5 / SC-021)**: on the `form` login fixture in `skip-checks`, submit
  the five-step login as one `browser_batch`; assert the submission and the under-10-second budget; a
  batch whose third step names a missing element stops there with steps four and five not run; `wait`
  ends at the condition or at its bound.
- **Scenario 6 — Diagnostics (US6)**: grant diagnostics for the site; `read_console` returns a message
  the fixture logged; without the grant, `read_network` answers `diagnostics not granted`.
- **Scenario 7 — Upload (US7)**: on the upload fixture in `skip-checks`, `file_upload` a small allowed
  file; the page reports its name and size; a disallowed path is refused.
- **Privacy gate (SC-025)**: run scenarios 2–5 with the redacting test proxy in front of the (unused)
  remote service; assert it saw no page content — the agent path never touches it. Delivered as
  `tests/e2e/packaged/agent-privacy.spec.ts`, which asserts the stronger fact the proxy can actually
  witness: **no request at all** reached it while a full round of agent work ran, and neither
  `relay.log` nor the MCP server's stderr contains any of the fixture's own strings.

## Attach-mode gate

```powershell
$env:HALLPASS_CDP_ENDPOINT = "http://127.0.0.1:9222"   # branded Chrome 152 with the agent build loaded
$env:HALLPASS_LOCALE = "en-US"                          # then zh-TW
npm run test:e2e:agent                             # NEW project: tests/e2e/packaged/agent-*.spec.ts
```

The `agent-*` journeys have no launched-mode form and skip with a reason when `HALLPASS_CDP_ENDPOINT` is
unset: the bridge starts from a machine install (the manifest and the two registry keys above), so a
browser the gate launched itself would read exactly the same install and prove nothing extra, while
hiding which install was used.

One journey needs one more thing: `agent-privacy` reads the redacting proxy's own diagnostics log, so
start the proxy with `HALLPASS_TEST_PROXY_LOG=<file>` and give the gate the same value; without it that
journey skips with that reason.

Expected: every `agent-*` journey passes in both locales (eight per locale). SC-022 is met when every
tool appears in at least one passing journey — which journey proves which tool is
[coverage.md](./coverage.md). The gate runs against whichever browser the owner loaded `dist/agent`
into, through the same attach mode built for T091.

## Regression gate — the archived path still stands

```powershell
npm run typecheck        # includes the archived remote-service modules; must stay 0
npm test                 # the 001/002 unit + UI suites stay green
npm run test:contract    # 001/002 contracts stay green
npm run build:extension:test    # the narrow manifest is byte-identical to 002's
$env:HALLPASS_LOCALE = "en-US"; npm run test:e2e:extension-core   # then zh-TW
```

003 deletes nothing from the remote path; if any of these go red, the archive rotted and the change
must stop.

**Recorded 2026-09-08, at the close of the feature (T066):**

| Gate | Result |
| --- | --- |
| `npx tsc -b`, `tsc -p apps/extension --noEmit`, `tsc -p tsconfig.tests.json --noEmit` | 0 errors, all three stages |
| `npm test` (unit + extension-ui) | **83 files / 898 tests passed**, 0 failed |
| `npm run test:contract` | **18 files / 210 tests passed**, 0 failed |
| `npm run build:extension:test` | `dist/test/manifest.json` byte-identical to the pre-003 copy (`activeTab, scripting, sidePanel, storage, identity`; hosts `https://localhost/*`) |
| `npm run build:extension:agent` | `dist/agent` adds `nativeMessaging, tabs, tabGroups, alarms, debugger` and `<all_urls>`; `SHIPPING_PROFILE` still `narrow` |
| Launched packaged gate, en-US | **19 passed / 9 skipped** (`test-results/packaged-core-en-US-2026-09-08T06-56-33-588Z/report.json`; the skips: the zh-TW-only description journey and the eight `agent-*` journeys, which are attach-mode only) |
| Launched packaged gate, zh-TW | **20 passed / 8 skipped** (`test-results/packaged-core-zh-TW-2026-09-08T07-02-07-897Z/report.json`) |
| A7 artefact assertions | green, inside the contract run (`shipping-artifact`, `content-runtime-artifact`, `release-build`) |

Every 001/002 suite that existed before this feature is still present and green; 003 adds files
beside them and changes none of their expectations. The `agent-*` journeys' own numbers are in
[coverage.md](./coverage.md) and `tests/acceptance/browser-matrix.md`.

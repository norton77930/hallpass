# Coverage: macOS and Linux for the Outside-Agent Bridge

Measured 2026-10-28 on Linux (Node 24.22.1, Playwright's Chromium, running as root).

| Requirement | Evidence |
| --- | --- |
| FR-433 | `install.test.ts` host paths (Windows, macOS, Linux, XDG, LOCALAPPDATA override); `hallpass-identity` contract |
| FR-434 | `install-posix-028.test.ts` (folders on both systems; written only where the browser exists; unregister); the real CLI on Linux with a temporary HOME: install, status, uninstall |
| FR-435 | `install-posix-028.test.ts` - the generated script run with `sh`: arguments forwarded (with a quote), the `node` fallback |
| FR-436 | `install-sh-028.contract.test.ts` - install.sh / uninstall.sh run under `dash` with a stand-in installer: install, old node refused, missing file refused, uninstall, `--purge` |
| FR-437 | `brokerSupported` test; relay log `relay.broker.skipped platform` in the end-to-end run; contract, relay and settings-page tests for `platform-unsupported` (both locales) |
| FR-438 | every suite on Linux: 4121 tests, 0 failing in a full run (103 skipped as Windows-only, including those marked before 028); CI matrix pinned by `public-files.contract.test.ts` |
| SC-193 | End to end on Linux: installer → Chromium with the built extension started `native-host.sh` through native messaging → relay listening and browser record published → an MCP client started `mcp-server.js`, saw 37 tools, `list_browsers` returned the Chromium |

Not verified here: macOS (no Mac; its CI job is `continue-on-error` until it has passed once); pairing and
page actions on Linux (they need a person in the side panel); Windows itself in this session (the owner's
machine runs the Windows suites). Observed once under the full parallel run: `upload-config-store`
"gives every write its own temp file" (a timing test, 5/5 alone, unchanged by 028; the #22 kind).

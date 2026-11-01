# Coverage: A Hallpass Skill for Outside Coding Agents

Measured 2026-10-28 in a Linux cloud session (Node 24.22.1); Windows-only suites still owed (bottom).

| Requirement | Evidence |
| --- | --- |
| FR-413, FR-414, FR-415, FR-416, FR-424 | `tests/contract/agent-skill-text.contract.test.ts` (5 tests): copy = host text, last shipped hash, frontmatter, pairing / modes / declined / timed out, no bypass, English, no local path |
| FR-417, FR-419, FR-420, FR-421, R-411, R-414 | `packages/agent-host/tests/agent-skill-026.test.ts` (9 tests); mutation check: removing CRLF normalisation, the replaceChanged guard or the shipped-only removal each fails a test |
| FR-418 (states reach the page), R-414 profile scrubbing, R-415 | `packages/agent-host/tests/broker-agent-skill-026.test.ts` (5), `apps/extension/tests/settings-port.test.ts` "026" (forwarding + state; mutation-checked) |
| FR-418, FR-419, FR-420, FR-423 (settings page) | `apps/extension/tests/settings-agent-skill.test.tsx` (6), both locales |
| Contracts | `packages/contracts/src/conversation.test.ts` "026" (5), `settings.test.ts` (2), `tests/contract/agent-conversation-019.contract.test.ts` error codes |
| FR-421 (uninstall output) | `install/cli.ts` calls the tested `removeInstalledSkills`; the CLI itself runs `reg.exe` - owed on Windows (quickstart step 7) |
| FR-422 (folders read by the agents) | owed: quickstart step 5 on the owner's machine (Claude Code, Codex) |
| SC-184, SC-185 | owed: quickstart step 6 with a real agent (model calls) |

Runs: typecheck 0 errors; unit + extension-ui 3684 tests, 87 failing, the same 87 as before this feature
(Windows-only tests on Linux); contract 383, 2 failing (koffi win32 staging, `%LOCALAPPDATA%` host
registration - Windows-only, failing before); snapshot check 1018 files, 0 hits. The read-only-folder case
of FR-420 skips as root; the folder-that-is-a-file case covers it on every platform.

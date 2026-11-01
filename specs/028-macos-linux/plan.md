# Implementation Plan: macOS and Linux for the Outside-Agent Bridge

**Branch**: `feature-028-macos-linux` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

## Summary

Make the host's paths and installation platform-aware, keep the broker (side-panel conversations) on
Windows, say so in the extension, ship `install.sh` / `uninstall.sh`, and run CI on all three systems with
Windows-only tests marked. Nothing changes on Windows.

## Technical Context

TypeScript, Node >= 24; no new dependency. The host's data folder and launcher (`host-paths.ts`), the
registration (`install/posix.ts` beside `install/windows.ts`), the shell launcher (`install/manifest.ts`),
the relay's broker start (`native-host.ts`, `broker-launch.ts`), the extension's unavailable reason
(`conversation-relay.ts`, `agent-runtime.ts`, the settings page) and CI. Testing: vitest on Linux here,
`dash` for the shell scripts, and an end-to-end run with Playwright's Chromium (SC-193).

## Constitution Check

| Principle | Result |
| --- | --- |
| I, IV | PASS - issue #1, D-028-1..3; macOS marked unverified rather than assumed |
| V Least privilege | PASS - per-user files only, no sudo, no manifest permission (`getPlatformInfo` needs none) |
| VI Privacy | PASS - unchanged; nothing leaves the computer |
| VII Observable | PASS - SC-193 measured end to end; SC-194 a green Linux run |
| others | PASS - MV3 unchanged, no dependency, failure paths (no browser found, old node) defined |

## Source Code (touched)

`packages/agent-host/src/{host-paths.ts, broker-launch.ts, native-host.ts}`,
`packages/agent-host/src/install/{posix.ts, manifest.ts, cli.ts}`,
`packages/contracts/src/conversation.ts` (reason), `apps/extension/src/service-worker/{conversation-relay,agent-runtime}.ts`,
`apps/extension/src/settings/agents/AgentsSection.tsx`, locales, `scripts/package/{install,uninstall}.sh`,
`scripts/package.ts`, `.github/workflows/ci.yml`, the Windows-only test marks, docs.

# Implementation Plan: Multi-Browser Native Host Registration

**Branch**: `010-multi-browser-host` (git: `feature-010-multi-browser-host`) | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-multi-browser-host/spec.md`; research in
[research.md](./research.md) (R-154–R-159); the installer sources read on 2026-09-21
(`packages/agent-host/src/install/{windows,cli}.ts`, `tests/acceptance/upgrade-host-proof.ps1`,
`packages/agent-host/tests/install.test.ts`).

## Summary

Three slices. (1) **Registration set**: the two hard-coded registry roots become a table of four
(Google Chrome, Chromium, Microsoft Edge, Brave), the key list is derived from it, and the
install / uninstall / legacy-cleanup loops that already iterate the constants pick the new roots up
(R-154). The machine-touching loops move out of `cli.ts` into a module that takes the registry
runner as a parameter, so the per-root outcome — written, failed with reason, removed, absent — is a
returned value the CLI prints and a unit test can assert, including a simulated failure on one root
(R-155, R-157). This fixes a defect the reading exposed: today's installer prints `registry: <key>`
for every key *before* looking at whether the `reg add` succeeded, so a failed root is reported as
registered (FR-140). (2) **Proof**: the host upgrade proof snapshots, exercises and restores four
roots and seeds a legacy entry under the two new ones by hand, since the 0.2.0 installer only ever
wrote two (R-158). (3) **Documents and issue**: README, the zh-TW operations guide and the package
README say "four registered, Chrome verified, Edge and Brave not live-verified"; a public issue
tracks the live run and the README links it; the public-files contract test pins the statement
(R-159).

## Technical Context

**Language/Version**: TypeScript 5 on Node 24 (the host and its installer); PowerShell 5.1 (the
upgrade proof script, run on the owner's machine).

**Primary Dependencies**: none added. `reg.exe` through `node:child_process` as today.

**Storage**: the Windows per-user registry (four `NativeMessagingHosts` roots) and
`%LOCALAPPDATA%\hallpass\` (unchanged).

**Testing**: vitest (`packages/agent-host/tests/install.test.ts`, extended); the contract suite
(`tests/contract/public-files.contract.test.ts`, one case added); `tests/acceptance/upgrade-host-proof.ps1`
(extended, one run); `npm run snapshot:check`.

**Target Platform**: Windows 11, per-user install, no elevation (R-101 unchanged).

**Project Type**: CLI installer inside a monorepo package.

**Performance Goals**: not applicable — two more `reg add` calls per install.

**Constraints**: no new manifest permission, no extension code change, no MCP contract change; the
identity test forbids any legacy identifier in the installer, so the legacy rule stays a property
(`isLegacyRegistration`), not a name.

**Scale/Scope**: ~6 source files, ~5 test cases, 1 script, 3 documents, 1 public issue.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 (unchanged).*

| Principle | Status |
| --- | --- |
| I. PR as source of truth | PASS. PR-020 (pairing with a local agent) is the requirement the host serves; this feature widens where the browser finds the host, nothing else. |
| II. Clean-room | PASS. The four registry roots are the browsers' public, documented locations; the only reference-extension fact used is the externally observable one that their installers write four roots (owner's registry, 2026-09-21). No internal is named. |
| III. Traceability | PASS. FR-139..145 ↔ stories 1–3 ↔ SC-071..077; tasks will cite them. |
| IV. Explicit uncertainty | PASS. The feature's central claim is deliberately "registered, not verified" (D-010-3); the documents say so and the issue keeps the open question visible. |
| V. Least privilege | PASS. HKCU only, no elevation; no manifest permission touched. |
| VI. Privacy | PASS. No page data, no personal data; the registry values are the manifest path. |
| VII. Observable | PASS. Every SC is a count, an exit code or a string in a file. |
| VIII. MV3 | PASS. Extension untouched. |
| IX. Requirements before architecture | PASS. |
| X. Dependency discipline | PASS. No dependency added. |
| XI. Defined failure | PASS and strengthened: a root that fails to register is named with its reason and fails the exit code (FR-140), which today's installer gets wrong. |
| XII. Specification before implementation | PASS. |

## Project Structure

### Documentation (this feature)

```text
specs/010-multi-browser-host/
├── spec.md
├── plan.md              # this file
├── research.md          # R-154–R-159
├── data-model.md        # roots, entries, the per-root outcome
├── quickstart.md        # how to prove it
├── contracts/
│   └── installer-output.md   # the CLI's stdout / stderr / exit-code contract
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/agent-host/
├── src/install/
│   ├── windows.ts        # NATIVE_MESSAGING_ROOTS → table of four {browser, root}; keys derived
│   ├── registration.ts   # NEW: registerAll / unregisterAll / removeLegacyRegistrations(reg) → outcomes
│   ├── cli.ts            # thin: prints outcomes, sets exit code
│   └── manifest.ts       # unchanged
└── tests/
    └── install.test.ts   # + four-root constant, derived keys, outcomes incl. one simulated failure
tests/acceptance/upgrade-host-proof.ps1   # four roots in snapshot/restore; seeds legacy under Edge+Brave
tests/contract/public-files.contract.test.ts  # + the four-browser statement in README
README.md · docs/zh-TW/operations-guide.md · scripts/package/README.md   # wording
```

**Structure Decision**: one new module beside `windows.ts` so the CLI file stops being the only
place the loops live (it runs `main()` at import and cannot be unit-tested); everything else is an
edit in place.

## Slice ordering

| Slice | Content | Closes | Writer | Evidence |
| --- | --- | --- | --- | --- |
| **S1** | `windows.ts` table of four roots + derived keys; `registration.ts` with the three loops taking `reg`; `cli.ts` prints per-root outcomes and sets the exit code; unit cases (RED first on the constant and on the simulated failure) | FR-139, FR-140, FR-141, FR-142 | implementer | unit |
| **S2** | `upgrade-host-proof.ps1`: four roots in the snapshot / restore arrays, legacy seeded under Edge + Brave pointing at the old manifest, assertions on all four; one run | FR-143; SC-071..073 | implementer (script) + main session (the run) | proof run |
| **S3** | README platform note, ops guide §1.1, package README; contract case for the statement; `gh issue create` on `norton77930/hallpass`; link the number | FR-144, FR-145; SC-075, SC-077 | main session | contract |

S1 → S2 → S3. Reviewer: none pre-selected (bounded, reversible by uninstall, no boundary crossed;
§3 negative list). Final verification: `npm run test` + `npm run test:contract` + `npm run
snapshot:check` green after S3, plus the S2 proof output pasted into `coverage.md`.

## Complexity Tracking

No constitution violation; nothing to justify.

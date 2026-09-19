# Implementation Plan: Open-Source Release as Hallpass 0.3.0

**Branch**: `009-open-source-release` (git: `feature-009-open-source`) | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-open-source-release/spec.md`; research in
[research.md](./research.md) (R-144–R-153); the repository audit and the narrow-build dependency map
of 2026-09-19 (both read-only, summarised in research).

## Summary

Five slices. (1) **Rename** every product identifier from the `poc` family to the Hallpass family
in one mechanical pass driven by a literal table, with a contract test that fails on any `poc`
identifier left in a shipped artifact (R-144, R-145). (2) **Remove the archived remote path**: the
agent worker's entry stops composing the narrow runtime (today `bootstrap.ts` composes it
unconditionally, so the shipping worker stands up an auth controller and a task-channel client it
never uses — R-146); the narrow-only modules, their tests, `apps/server`, the narrow build target and
the contract tests that compared two builds go; the shared exports the agent path takes from
`control-port.ts` move to a small shared module first (R-147). (3) **Snapshot**: a tracked
`.gitattributes` with `export-ignore` decides what `git archive` leaves out; a check script scans the
archive for forbidden paths and patterns against an allow-list; the five files carrying the owner's
paths are scrubbed; the probe-report directory is ignored (R-148, R-149). (4) **Public documents**:
LICENSE, notices, README (English) with a comparison table and a demo GIF recorded by the product,
`README.zh-TW.md`, `docs/design-notes.md`, the two Chinese guides moved and scrubbed, CONTRIBUTING /
SECURITY / CODE_OF_CONDUCT / issue templates / CI workflow, and the spec trees' evidence citations
rewritten (R-150, R-151). (5) **Release**: version 0.3.0, the packaged gate on the renamed build, the
0.2.0 → 0.3.0 upgrade proof, the from-scratch snapshot build, the private GitHub repository with one
commit, CI, tag, release, issue #1, the QA guide republished, `coverage.md` (R-152, R-153).
Two slices are pre-selected for `code-reviewer`: S2 (the worker's composition root and the pruned
contracts are a cross-module compatibility change no single test sees whole) and S3 (the snapshot
check is the claim that nothing private leaves; an allow-list bug is invisible to a green run).

## Technical Context

**Language/Version**: TypeScript 5.9 on Node 24, strict, unchanged. **Primary Dependencies**: none
added. The CI workflow uses only `actions/checkout` and `actions/setup-node`. **Storage**: none
changed; `chrome.storage.local` keys are untouched, which is what keeps the pairing and site modes
across the rename (the extension ID is pinned by the manifest key, unchanged). **Testing**: vitest
unit + contract (the CI set), the packaged attach gate (`agent-*` specs) on Chromium headed with the
private-`LOCALAPPDATA` recipe of 008, the upgrade proof scripts of 008 re-run for 0.2.0 → 0.3.0, a new
from-scratch snapshot proof. **Target Platform**: Windows 11, Chrome (stated); CI on `windows-latest`.
**Constraints**: the worktree guard — this session cannot run git against the main checkout, so the
snapshot proof is run from this worktree's `main`-equivalent branch head and the final `main` merge
is the owner's (as for 008); GitHub repository creation, push, tag and release go through `gh` from
here. **Scale/Scope**: ~200 files touched by the rename; ~45 files deleted with the narrow path; ~14
new root/doc files; 73 spec files with citations rewritten (mechanical).

## Constitution Check

*GATE: evaluated before implementation. Result: PASS.*

| Article | Assessment |
| --- | --- |
| I. Product requirements | PASS. No product behaviour changes; FR-124–FR-138 trace to D-009-1–10 and PR-019/PR-020. |
| II. Clean-room | PASS and strengthened. The reference-analysis documents stay private (D-009-4); the public design notes name no internal of any compared product; the snapshot check (FR-129) fails on the reference extensions' store identifiers and build hash, so the boundary is now enforced on the published set, not only on `apps/`. |
| III. Traceability | PASS. The spec trees go public with their identifiers intact; citations of private evidence are rewritten to `docs/design-notes.md` sections or reduced to conclusions (FR-130), so the chain stays readable without the private files. |
| IV. Explicit uncertainty | PASS. One item is declared owed to the owner, not assumed: switching the repository to public (FR-137). One decision inconsistency is recorded (R-149: the speckit tooling is excluded from the snapshot while development is meant to continue in the public repository) and handled reversibly. |
| V. Least privilege | PASS. Manifest permissions unchanged; the narrow manifest and its byte-guard are removed *with* the build they guarded, not relaxed. |
| VI. Privacy | PASS. The feature's purpose: the owner's paths and username, the probe reports and the session configuration never enter the public snapshot (FR-128, FR-129). |
| VII. Observable | PASS. SC-063–SC-070 are counts, exit codes and checksum equality. |
| VIII. MV3 | PASS. Unchanged. |
| IX. Requirements before architecture | PASS. |
| X. Dependency discipline | PASS. No runtime dependency added; `THIRD_PARTY_NOTICES.md` discloses the five shipped ones (FR-131). |
| XI. Defined failure | PASS. Installer with a stale 0.2.0 registration; stale MCP registration; snapshot check hits; a `hallpass` repository already existing (stop and ask). |
| XII. Specification before implementation | PASS. |

## Project Structure

### Documentation (this feature)

```text
specs/009-open-source-release/
├── spec.md              # D-009-1..10, FR-124..138, SC-063..070
├── plan.md              # this file
├── research.md          # R-144..R-153
├── tasks.md             # T239..
├── coverage.md          # written at the end: per-claim evidence, runs, addresses
└── checklists/requirements.md
```

### Source Code (repository root, after this feature)

```text
apps/extension/            # @hallpass/extension — one build target (agent), one worker entry
packages/contracts/        # @hallpass/contracts — capabilities pruned of the remote-path types
packages/domain/           # @hallpass/domain
packages/agent-host/       # @hallpass/agent-host — MCP server `hallpass`, host com.hallpass.host
packages/test-kit/         # @hallpass/test-kit
scripts/                   # package.ts (hallpass-<version>.zip), snapshot-check.ts, package/{install,uninstall}.ps1
tests/{contract,e2e,acceptance,harness}/
docs/
├── design-notes.md        # public: compared products, matched behaviours, independence statement
├── media/demo.gif         # recorded by gif_recorder on the gate
├── zh-TW/{operations-guide.md,qa-guide.html}
└── reference-*.md         # PRIVATE — export-ignore
specs/                     # public at the root (R-149), citations rewritten
.github/{workflows/ci.yml,ISSUE_TEMPLATE/*.md}
LICENSE  THIRD_PARTY_NOTICES.md  README.md  README.zh-TW.md  CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
.gitattributes             # export-ignore: the private set
```

Removed: `apps/server/`, the `narrow` build target and its worker entry/runtime, the narrow side-panel
workspace, their tests and fixtures (`tests/acceptance/narrow-manifest.pre-004.json`, the `us*`
checkpoints), `tests/harness/test-server.ts` if nothing agent-side uses it (R-146 lists the set).

## Slice ordering

| Slice | Content | Closes | Writer | Review |
| --- | --- | --- | --- | --- |
| **S1** | Rename by table (R-144): package names, MCP server name, host name + directory, env prefix, vite defines, display name + locale keys, package zip name, version 0.3.0; docs and scripts that name them; contract test `hallpass-identity.contract.test.ts` (built artifacts carry no `poc` identifier; names pinned); `.mcp.json` regenerated for this checkout (it stays private). RED first: the identity test against the current names. | FR-124, FR-136 (version) | mech-executor (table) + implementer (test, installer text) | tests |
| **S2** | Remove the remote path (R-146, R-147): (a) `bootstrap.ts`/`index-agent.ts` compose the agent path only; `isTrustedControlSender` and `DEFAULT_WAIT_POLL_MS` move to `service-worker/shared-port.ts`; delete the narrow worker entry, `runtime.ts`, auth/task-channel/control-port/action-dispatcher/page-read/marker modules, the narrow panel components, `App.tsx` collapses to the agent shell; delete their tests; edit the mixed panel tests. (b) delete `apps/server`, the `narrow` profile from `build-config.ts`/`build-target.ts`/`build-identity.ts`/scripts, the `build`/`build:test` scripts (the agent build becomes `build`), `tsconfig.json`/`vitest.config.ts`/`package.json` workspace entries, `tests/harness/test-server.ts` and the test-kit modules only it used, the contract tests `poc-scope`, `product-api`, `privacy-boundary`, `task-channel`, and the narrow assertions in `manifest`, `release-build`, `shipping-artifact`, `extension-runtime`; prune `capabilities.ts`/`task-channel.ts` to what the agent path imports. Unit + contract green with the cases gone. | FR-127 | implementer (two briefs: a, b) | **code-reviewer** |
| **S3** | Snapshot (R-148, R-149): `.gitattributes` export-ignore set; `scripts/snapshot-check.ts` (archive `HEAD`, list, scan for forbidden paths and patterns, allow-list file `scripts/snapshot-allowlist.txt`), contract test running it; scrub the five path-carrying files; ignore `tests/acceptance/probe-004/reports/` and `git rm --cached` it; `.mcp.json` export-ignored. | FR-128, FR-129, FR-130 (scrub, ignore) | implementer | **code-reviewer** |
| **S4** | Public documents (R-150, R-151): LICENSE, THIRD_PARTY_NOTICES, README.md, README.zh-TW.md, docs/design-notes.md, docs/zh-TW/* moved + scrubbed + 0.3.0 names, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue templates, `.github/workflows/ci.yml`; spec citations rewritten (mech-executor, table of 91 citation sites); `docs/media/demo.gif` recorded on the gate; contract test for file presence and README section order. | FR-130 (citations), FR-131–FR-135 | main session (README, design notes), mech-executor (citations), implementer (CI, templates, test) | tests |
| **S5** | Release (R-152, R-153): package `hallpass-0.3.0.zip`; gate on the renamed build (Chromium, unattended recipe); upgrade proof 0.2.0 → 0.3.0 (both scripts); from-scratch snapshot proof script + report; `gh repo create norton-account/hallpass --private`, push snapshot, CI run, tag, release, issue #1; QA guide republished to its page; `coverage.md`; memory. | FR-136–FR-138; SC-063–SC-070 | main session | gate + proofs |

Dependencies: S1 → S2 → S3 → S4 → S5 (each slice's checks assume the previous names and file
set). S4's README needs S2's final tool table and S3's snapshot layout; S5 needs everything.

**Process rule (owner, 2026-09-18), binding for every slice**: a task that fails its second attempt is
not tried a third time; the main session measures or reads, writes the finding into `research.md`,
and re-briefs.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| `export-ignore` attributes + a check script | The archive must leave the private set out and prove it | Deleting the private files from the private repo loses the evidence the owner keeps using; a copy script outside git cannot be tested in the public repo |
| Rewriting the worker's composition root before deleting anything | The agent worker composes the narrow runtime today | Leaving `runtime.ts` in place keeps auth/task-channel code, a localhost origin and their tests in the public product for no reason |
| Two implementer briefs for S2 | (a) is a product-code change under review; (b) is deletion and config | One brief would mix the reviewable change with 40 deletions and hide it |

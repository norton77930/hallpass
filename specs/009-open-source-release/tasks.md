---

description: "Task list for Open-Source Release as Hallpass 0.3.0"
---

# Tasks: Open-Source Release as Hallpass 0.3.0

**Input**: `/specs/009-open-source-release/spec.md`, `plan.md` (slices S1–S5), `research.md`
(R-144–R-153).

**Tests**: TDD per slice where a test exists to write (identity, snapshot check, file presence);
deletions close on the suites staying green; publication claims close on the snapshot proof.
Slice review by `code-reviewer` for S2 and S3 only.

**Numbering** continues from 008 (T207–T238): this feature starts at **T239**.

## Standing rules (owner, 2026-09-18 — binding for every task)

1. **Two attempts, then stop.** A task that fails its second attempt is not tried a third time; the
   main session measures or reads, writes the finding into `research.md`, and re-briefs.
2. **Clean room.** The private reference documents are not read for this feature; the design notes
   are written from the specs' own conclusions.
3. **One writer at a time.** Each slice is one or two briefs; the main session owns the README, the
   design notes, the gate runs and the release.
4. **Nothing private leaves.** Every commit on this branch is scanned by the S3 check once it exists;
   before that, the S1/S2 briefs must not add any absolute path or username.

## Slice S1 — Rename by table (closes FR-124, FR-136 version) — R-144, R-145

- [X] T239 [S1] RED: `tests/contract/hallpass-identity.contract.test.ts` per R-145 — asserts the
  Hallpass names on the manifest writer's agent output, `install/manifest.ts`'s host manifest,
  `SERVER_NAME === "hallpass"`, `SERVER_VERSION === "0.3.0" === AGENT_EXTENSION_VERSION`,
  `PACKAGE_NAME === "hallpass"`, six workspace names, both locales' `extName.agent`; and scans the
  bundled host + `dist/agent/**` (if present) for `/\bpoc\b|@poc\/|poc-|com\.poc\.|POC_/`. Fails today.
  B: `tests/contract/hallpass-identity.contract.test.ts`, 6 cases, RED 6/6 then GREEN (7f7bf81).
- [X] T240 [S1] mech-executor: apply the R-144 table over every tracked text file except
  `package-lock.json`, `tests/acceptance/probe-004/reports/**`, `docs/reference-*.md`; word-bounded so
  `epoch` is untouched; then `npm install` to regenerate the lock; `npx tsc -b`, unit, contract.
  Verification commands in the brief; the executor stops on any hit it cannot classify.
  B: mech-executor, three passes (R-144 table + extended table + leftovers), 363 files; alarms left over from 0.2.0 cleared by name-set difference so no legacy literal ships (7f7bf81).
- [X] T241 [S1] Installer (`scripts/package/install.ps1`): legacy handling per FR-126 — detect
  `HKCU\Software\{Google\Chrome,Chromium}\NativeMessagingHosts\com.poc.agent_host`, remove it, print
  that it did and that `%LOCALAPPDATA%\poc-agent-host` may be deleted by hand; end with the two MCP
  commands (`claude mcp remove poc-browser --scope user`, `claude mcp add hallpass …`).
  `uninstall.ps1` touches only the Hallpass registration and directory. Package README §2.1 becomes
  "從 0.2.0 升級到 0.3.0". Unit test in `packages/agent-host/tests/install.test.ts` for the legacy
  detection if the logic lands in `install/cli.ts` (preferred: the PowerShell wrapper calls
  `node host\install.js install --remove-legacy`).
  B: legacy registration recognised by rule (`isLegacyRegistration`: exactly our origin, another name), removed by `install`; `--keep-legacy` for a dev checkout beside a QA install; reg.exe long hive names read (cef5084, ad92dff).
- [X] T242 [S1] `.mcp.json` of this checkout regenerated with the new server name (stays private;
  export-ignored in S3). Commit "Rename the product to Hallpass 0.3.0".
  B: `.mcp.json` renamed with the table; export-ignored in S3.
## Slice S2 — Remove the archived remote path (closes FR-127) — R-146, R-147 — **code-reviewer**

- [X] T243 [S2a] `service-worker/shared-port.ts`: move `isTrustedControlSender` and
  `DEFAULT_WAIT_POLL_MS` (+ their unit cases) out of `control-port.ts`; update the two agent importers.
  B: `shared-port.ts` + 3 unit cases (5ce50d9).
- [X] T244 [S2a] `bootstrap.ts` → agent-only per R-146; `index-agent.ts` → `index.ts`; vite entry
  branch removed; `App.tsx` → agent shell only; delete the narrow worker/panel modules and the 25
  narrow-only tests listed in R-146 (each deletion preceded by a grep proving no agent importer);
  edit `side-panel-app.test.tsx` (drop narrow cases + profile toggle), review
  `side-panel-reconnect`/`side-panel-lna-bootstrap` (keep if they exercise the agent shell via `App`).
  Unit + extension-ui green. Commit "Compose the agent path only".
  B: bootstrap binds action entry + agent port only, disconnects other ports; 13 worker modules, 11 panel components, 27 tests removed; RED test `service-worker-bootstrap.test.ts` (5ce50d9).
- [X] T245 [S2b] Delete `apps/server`; remove it from `package.json` workspaces, `tsconfig.json`
  references, `vitest.config.ts` includes; delete `tests/harness/test-server.ts` and any test-kit module
  only it used (`service-fixture`, `auth-adapter`, `ai-adapter` — verify by grep); delete
  `tests/contract/{poc-scope,product-api,privacy-boundary,task-channel}.contract.test.ts`;
  prune `packages/contracts/src/{capabilities,task-channel}.ts` and `packages/domain/src/runtime-foundation.ts`
  to what remaining importers use; `tests/acceptance/narrow-manifest.pre-004.json`, `us1/us2/us3-checkpoint.md`,
  `foundation-checkpoint.md` deleted.
  B: apps/server, harness server, remote-path contracts (task-channel, product-api), 4 contract tests, checkpoints, 4 dead packaged specs removed (a537e6e).
- [X] T246 [S2b] Build: `BUILD_PROFILES` → `["agent"]`, `SHIPPING_PROFILE` removed with its importers
  (`build-identity.ts`, `build-target.ts`, `validate-build.ts`), `NARROW_PROFILE_PERMISSIONS` removed;
  extension scripts `build`/`build:test` removed, `build:agent` becomes `build` (root
  `build:extension:agent` kept as an alias one release, README uses `npm run build`); contract tests
  `manifest`, `release-build`, `shipping-artifact`, `extension-runtime`, `agent-tools-008` rewritten to
  assert the agent artifact alone (narrow byte-guard cases removed, not skipped); `playwright.config.ts`
  / `playwright.release.config.ts` reviewed — delete if they only drove the narrow flow. Typecheck,
  unit, contract green. Commit "Remove the archived remote path".
  B: one build target; contract tests assert dist/agent only; 4 dist/production ENOENT cases gone with the target; manifest byte-identical (a537e6e); follow-ups: CSP connect-src tail, dead worker→panel schemas, test proxy removed (34679c1).
- [X] T247 [S2] **code-reviewer** on T243–T246: claim = the agent artifact composes only the agent path
  and nothing the remaining tests cover was silently lost; contracts pruning did not change any wire
  shape the host or content runtime uses. Fix findings; commit.
  B: code-reviewer passed (4 low findings; 3 fixed in 34679c1, the agent-content.js classic-script gap noted as pre-existing).
## Slice S3 — Snapshot (closes FR-128, FR-129, FR-130 scrub/ignore) — R-148 — **code-reviewer**

- [X] T248 [S3] RED: `tests/contract/snapshot.contract.test.ts` runs `scripts/snapshot-check.ts` and
  expects `{forbiddenPaths: 0, patternHits: 0}`; fails today (no attributes, paths present).
  B: `snapshot.contract.test.ts` RED 3/5 then GREEN (285f700).
- [X] T249 [S3] `.gitattributes` (R-148 set) + `scripts/snapshot-check.ts` + `scripts/snapshot-allowlist.txt`
  (entries for the upgrade sections that name legacy identifiers on purpose) + `npm run snapshot:check`.
  B: `.gitattributes` (13 lines + `.agents/**`), `scripts/snapshot-check.ts` (staged tree by default), allow-list 60 `path::substring` entries (285f700, 1cd6712).
- [X] T250 [S3] Scrub: `specs/005-*/coverage.md`, `specs/008-*/coverage.md`,
  `tests/acceptance/probe-004/scenarios.test.ts`, `tests/acceptance/upgrade-host-proof.ps1`,
  `tests/e2e/packaged/core-journey.spec.ts` — replace the owner's paths with relative/temp paths;
  `.gitignore` += `tests/acceptance/probe-004/reports/` and `git rm -r --cached` it (keep `.gitkeep`
  tracked via a negation); commit "Decide what the snapshot carries".
  B: 9 files scrubbed; probe reports untracked (111) and ignored; probe reads the reference id from `HALLPASS_REFERENCE_EXTENSION_ID` (285f700).
- [X] T251 [S3] **code-reviewer** on T248–T250: claim = the archive of HEAD contains none of the private
  set and no forbidden pattern, and the allow-list cannot mask a new occurrence. Fix; commit.
  B: code-reviewer: 1 H (8.3 account form) + 6 lower, all fixed (1cd6712).
## Slice S4 — Public documents (closes FR-130 citations, FR-131–FR-135) — R-150, R-151, R-152

- [X] T252 [S4] `LICENSE` (Apache-2.0 verbatim), `THIRD_PARTY_NOTICES.md` (react, react-dom, zod,
  @modelcontextprotocol/sdk, gifenc — name, version, licence, upstream URL), package README §9 points
  at it.
  B: LICENSE Apache-2.0 + appendix; THIRD_PARTY_NOTICES (5 deps) (d716740).
- [X] T253 [S4] `docs/design-notes.md` per R-150 (§1–§7), written by the main session from the specs'
  decision tables; contains no store ID, version, hash, file or internal name of a compared product.
  B: `docs/design-notes.md` §1–§7 + Permissions (d716740).
- [X] T254 [S4] mech-executor: rewrite the 91 citation sites in `specs/**` per the mapping table
  (008 §1→dropped (permissions traced in design-notes), §2→§2, §3→§3, §4→§5, §5→§2/§3, §7/§8→
  measurement kept, reference dropped; 004 §3f→§1, others by topic; 005→§6; 006→§4; 002/003 →
  conclusion only); then the private-citation grep over `specs` (the pattern lives in `tests/contract/public-files.contract.test.ts`) = 0.
  B: mech-executor ≈87 sites + 9 by hand + 16 source/test comments; 0 hits over the archived set (d716740, 12e2986).
- [X] T255 [S4] `docs/zh-TW/operations-guide.md` and `docs/zh-TW/qa-guide.html` (moved with `git mv`),
  paths scrubbed, 0.3.0 names, upgrade section, "development continues at <repo>" closing note;
  `CLAUDE-CODE-HANDOFF.md` closing note (private).
  B: `docs/zh-TW/{operations-guide.md,qa-guide.html}` moved and updated; hand-off note (d716740).
- [X] T256 [S4] `README.md` (FR-132 order, comparison table per R-151), `README.zh-TW.md`.
  B: README (9 sections, comparison table, 31 tools) + README.zh-TW (d716740).
- [X] T257 [S4] implementer: `.github/workflows/ci.yml` (R-152), `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`; make the contract
  suite green on a clone with no `dist/` (conditional skips with reason); contract test
  `public-files.contract.test.ts` (presence of every FR-131/FR-134 file; README section order).
  B: ci.yml (+ build and snapshot steps), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, 2 templates; `public-files.contract.test.ts` 12 cases (d716740, 12e2986).
- [X] T258 [S4] Demo GIF on the gate (R-151) → `docs/media/demo.gif`; referenced from README. Commit
  "Add the public documents".
  B: `docs/media/demo.gif` 5 frames 782x764 491 KB from the gate (279ffa0).
## Slice S5 — Release (closes FR-136–FR-138; SC-063–SC-070) — R-153

- [X] T259 [S5] `npm run package` → `release/hallpass-0.3.0.zip`; upgrade proofs
  (`upgrade-proof.mjs --old release/poc-browser-agent-0.2.0.zip --new release/hallpass-0.3.0.zip`;
  `upgrade-host-proof.ps1` likewise) — outputs to coverage.
  B: `hallpass-0.3.0.zip` 614 603 B; extension proof pairing+modes kept; host proof legacy removed, directory untouched (ad92dff).
- [X] T260 [S5] Gate: all `agent-*` specs on the renamed build, Chromium headed, private LOCALAPPDATA,
  `HALLPASS_FOREIGN_AGENT_SERVERS=allow` — counts to coverage.
  B: 29/31 then 31/31 after the ask-row helper fix (pre-existing since 2026-09-16) (d6020c6).
- [X] T261 [S5] Snapshot proof: `git archive HEAD` → empty temp dir → `npm ci`, typecheck, unit,
  contract, package → exit codes + zip SHA-256 to coverage.
  B: run 1 exposed the probe harness reading `.mcp.json` (fixed 25740ad); run 2 exposed the archive needing git and `.gitattributes` (fixed a64f5d2); final run on a64f5d2 all green, zip SHA-256 ea3f7ab7… (coverage.md).
- [X] T262 [S5] `gh repo create hallpass --private` (stop if it exists), push the snapshot as one commit
  on `main`, wait for CI, `gh release create v0.3.0 release/hallpass-0.3.0.zip`, issue #1; URLs to
  coverage.
  B: repo https://github.com/norton77930/hallpass (private) created; snapshot of 53d6bca pushed as the single commit 333a13a; CI run 35453517002 success; tag v0.3.0 + release with the zip (hash re-checked after download); issue #1 opened.
- [X] T263 [S5] QA guide republished to its existing page; `coverage.md` written; memory updated;
  final commit on the branch. Owner owes: merge to `main` (worktree guard), switch the repository to
  public, and the R-149 decision.
  B: QA guide republished (artifact 9m9cgsUus4x4z8vNm47ts3 v5); coverage.md written; memory `feature-009-progress` updated. Owner owes: merge, switch to public, R-149, own 0.2.0 → 0.3.0 upgrade.

# Coverage: Open-Source Release as Hallpass 0.3.0

**Feature**: `specs/009-open-source-release` · **Branch**: `feature-009-open-source` (worktree
`feature-008-spec`) · **Written**: 2026-09-19, by the main session at the end of the unattended run.

Every requirement below names the artifact that proves it and the run that produced the number. The
two acceptance standards of the spec apply: product claims close on the packaged gate and the upgrade
proofs; publication claims close on the snapshot check, the from-scratch build and the public
repository's first CI run.

## Requirements

| Requirement | Evidence | Where |
| --- | --- | --- |
| FR-124 identity everywhere | `tests/contract/hallpass-identity.contract.test.ts` 6/6: locales, `SERVER_NAME`/`SERVER_VERSION`, host name and directory, package and workspace names; bundled host and `dist/agent/**` scanned for legacy identifiers | contract run below |
| FR-125 identity key unchanged | extension upgrade proof: pairing and 2/2 site modes present after 0.2.0 → 0.3.0, manifest 0.3.0 | `upgrade-proof.mjs` run below |
| FR-126 installer removes the earlier registration by rule | host upgrade proof: both `com.poc.agent_host` keys removed by the 0.3.0 installer, earlier directory untouched, new registration under both roots, registry restored; unit cases for `parseRegistrySubkeys` (long hive names) and `isLegacyRegistration` | `upgrade-host-proof.ps1` run below; `packages/agent-host/tests/install.test.ts` 11/11 |
| FR-127 remote path removed | `apps/server`, narrow build, remote-path contracts and 27+ narrow tests gone; five workspaces; unit 1124/1 skipped, contract 180/180 with the removed cases gone (not skipped); code-reviewer passed S2 (four low follow-ups, three fixed in 34679c1) | commits 5ce50d9, a537e6e, 34679c1 |
| FR-128 export-ignore set | `.gitattributes` (13 lines) + `FORBIDDEN_PATHS` pinned equal by a contract case | `tests/contract/snapshot.contract.test.ts` |
| FR-129 forbidden patterns | `npm run snapshot:check`: 480 files, 0 forbidden paths, 0 pattern hits, 60 allow-listed lines (each `path::substring`, per-pattern); patterns include the 8.3 account form after review | snapshot run below; code-reviewer passed S3 after 7 fixes (1cd6712) |
| FR-130 specs public, citations rewritten | ~103 citation sites rewritten across specs, the requirements draft, source comments and gate specs; `public-files.contract.test.ts` case 6 scans every archived text file: 0 hits; probe reports untracked and ignored (111 files) | contract run below |
| FR-131 LICENSE + notices | `LICENSE` (Apache-2.0 verbatim + appendix), `THIRD_PARTY_NOTICES.md` checked against the five shipped dependencies' `package.json` licences | `public-files.contract.test.ts` cases 2–3 |
| FR-132 README | `README.md` sections in order, first screen (Windows 11, Apache-2.0, demo GIF), 31 tools named; `README.zh-TW.md` | cases 4a–4c |
| FR-133 design notes, Chinese guides | `docs/design-notes.md` (§1–§7, three compared products, no id/hash/file name/"teardown"); `docs/zh-TW/{operations-guide.md,qa-guide.html}` scrubbed and at 0.3.0 | cases 7a–7b; snapshot check |
| FR-134 CI + community files | `.github/workflows/ci.yml` (windows-latest: ci, typecheck, test, build, contract, snapshot check; no browser, no secret), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, two issue templates | cases 1, 5a–5b; first CI run below |
| FR-135 platform statement | README first screen; issue #1 | README; issue link below |
| FR-136 version 0.3.0 | `AGENT_EXTENSION_VERSION === SERVER_VERSION === "0.3.0"`; `release/hallpass-0.3.0.zip` | identity test; package run below |
| FR-137 repository, tag, release | see "Publication" below | — |
| FR-138 QA guide republished, continuation notes | `docs/zh-TW/qa-guide.html` republished to the existing page; `CLAUDE-CODE-HANDOFF.md` and the operations guide end with the continuation note | artifact URL below |

## Runs

| When (local) | What | Result |
| --- | --- | --- |
| 2026-09-19 | `npm run typecheck` | clean |
| 2026-09-19 | unit + extension-ui (`--maxWorkers=4`) | 1124 passed / 1 skipped (1543 before the removal; every removed case belonged to the remote path) |
| 2026-09-19 | contract | 180 passed / 0 failed / 0 skipped, 23 files (the four `dist/production` ENOENT cases of 008 are gone with the target) |
| 2026-09-19 14:51–15:01 | packaged gate, attach mode, Playwright Chromium 151, private LOCALAPPDATA, all `agent-*` specs | 29 passed / 2 failed; the two (`agent-input`, `agent-privacy`) failed on a spec helper that polled for a site row the store rightly forgets since 2026-09-16 (pre-existing since that date, never run since); helper corrected, re-run **3/3 passed** → 31/31 across the two runs |
| 2026-09-19 | extension upgrade proof `poc-browser-agent-0.2.0.zip` → `hallpass-0.3.0.zip` (headless Chromium, scratch profile) | `[T234] … → 0.3.0: pairing kept, modes kept, manifest 0.3.0` |
| 2026-09-19 | host upgrade proof (same zips, scratch LOCALAPPDATA, registry snapshot/restore) | `[T259] … earlier directory untouched: True, earlier registration removed, registry restored: True`; first run found the installer's registry listing did not read `HKEY_CURRENT_USER` spellings (fixed, ad92dff) |
| 2026-09-19 | `npm run snapshot:check` on the staged tree | 482 files, 0 forbidden paths, 0 pattern hits (60 allowed) |
| 2026-09-19 | `npm run package` | `release/hallpass-0.3.0.zip`, 614 603 bytes |
| 2026-09-19 | demo GIF (`gif_recorder` on the gate, Wikipedia search flow) | `hallpass-demo.gif`, 5 frames, 782×764, 491 214 bytes → `docs/media/demo.gif` (watermark `Hallpass 0.3.0`, banner, counter visible) |
| 2026-09-19 | from-scratch snapshot build (`git archive` → empty dir → `npm ci`, typecheck, unit, build, contract, package) | run 1 found the probe harness reading the unpublished `.mcp.json` (fixed, 25740ad); run 2: `npm ci` 19 s, typecheck 16 s, build 8 s, package 29 s → zip 614 603 bytes, SHA-256 `f734946aafa5994cedc7a7ffad65327165a20eb603e285863cb9e72256ed1bdb`; unit 1124 passed / 1 skipped on one worker (two `spawn EPERM` flakes at 2–4 workers on this loaded machine, different files each time); contract found the archive must be a git repository for two tests and that `.gitattributes` must travel (fixed); final run on a64f5d2 as a git repository (as the public clone is): npm ci 24 s, typecheck 19 s, build 9 s, contract 177 passed / 3 skipped, snapshot check 483 files 0/0, package 34 s, unit 1124 passed / 1 skipped on one worker — **all steps green**; its zip is the release asset | |

## Publication

| Item | Value |
| --- | --- |
| Repository | https://github.com/norton77930/hallpass (private until the owner switches it) |
| First commit | recorded in the private archive's copy of this file after the push |
| CI run | recorded in the private archive's copy of this file after the push |
| Tag / release | `v0.3.0` — https://github.com/norton77930/hallpass/releases/tag/v0.3.0 |
| Release asset SHA-256 | `ea3f7ab7968958299b0fa3245bc8e4f17c6f122e46a45a774b4430b8dfcff005` (`hallpass-0.3.0.zip`, 614 603 bytes, built by the final from-scratch run on a64f5d2; zip timestamps make each build's hash differ while the bundles do not) |
| Issue #1 (macOS / Linux) | https://github.com/norton77930/hallpass/issues/1 |
| QA guide page | https://claude.ai/artifact/9m9cgsUus4x4z8vNm47ts3 |

## Owed to the owner

1. Merge `feature-009-open-source` into `main` in the private checkout (the worktree guard keeps this
   session off `main`): `git merge --ff-only feature-009-open-source`.
2. Switch the public repository to public after reading the README on the web.
3. Decide R-149: publish `.specify/` and `.claude/skills`+`agents` (one line each in `.gitattributes`)
   so the speckit workflow runs in the public repository, or keep developing specs privately.
4. Your everyday Chrome still runs 0.2.0 from the main checkout: after the merge, rebuild, run
   `npm run agent-host:install` (it removes the 0.2.0 registration), reload the extension and
   re-register the MCP server as `hallpass`. This session's own `com.hallpass.host` registration
   (pointing at the worktree) was removed at the end of the run.

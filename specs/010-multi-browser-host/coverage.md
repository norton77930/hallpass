# Coverage: Multi-Browser Native Host Registration

**Feature**: `specs/010-multi-browser-host` · **Branch**: `feature-010-multi-browser-host` (worktree
`feature-008-spec`, from main 4315c1b) · **Written**: 2026-09-21 by the main session.

## Requirements

| Requirement | Evidence | Where |
| --- | --- | --- |
| FR-139 four roots, each named in the output | `NATIVE_MESSAGING_ROOTS` table of four; `registerAll` outcomes in table order; CLI prints `registry: <Browser> <key>` per `written` | `install.test.ts` "registers under the four native-messaging roots in table order", "registerAll…"; proof run below (four `registry:` lines) |
| FR-140 no success reported for a root not written | R-155 defect removed: the unconditional second loop is gone; `failed` goes to stderr with `reg.exe`'s message; exit 1 | `install.test.ts` Edge-failing runner → `[written, written, failed(reason), written]` |
| FR-141 uninstall removes four, absent is not a failure | `unregisterAll` → `removed` / `absent`; exit 0 | `install.test.ts` "[removed, absent, removed, absent]"; proof run (four `removed:` lines) |
| FR-142 legacy cleanup over four roots, `--keep-legacy` honoured | `removeLegacyRegistrations(reg, readManifest)` iterates the table; rule unchanged (`isLegacyRegistration`) | `install.test.ts` legacy runner visits four roots; proof run: four "removed earlier version's registration" lines |
| FR-143 proof covers four roots and restores | `$roots` × {new, legacy} = 8 keys snapshotted / restored; legacy seeded under Edge + Brave | proof run below, `registry restored: True` |
| FR-144 documents | README platform note; ops guide §1.1; package README | `public-files.contract.test.ts` "says which browsers are registered and which are verified" |
| FR-145 public issue | https://github.com/norton77930/hallpass/issues/2 | README link |

## Runs (2026-09-21)

| What | Result |
| --- | --- |
| `npx vitest run --project unit packages/agent-host/tests/install.test.ts` | 14 passed (11 before) |
| `npm run typecheck` | clean |
| `npm run build` | ok |
| `npm run package` | `release/hallpass-0.3.0.zip` 615 769 bytes (four-root installer inside) |
| host upgrade proof (`tests/acceptance/upgrade-host-proof.ps1`, scratch LOCALAPPDATA, registry snapshot of 8 keys) | first run: the restore's `reg delete` of an already-absent key raised PowerShell 5.1's NativeCommandError inside the `finally` (the run had already completed every assertion; the owner's two real keys were re-added before the throw, the other six were already absent — verified by reading the registry). `Restore-Registry` now skips absent keys and runs under `Continue`. **Second run: exit 0** — `[T259/T275] … earlier directory untouched: True, earlier registration removed under 4 roots, 4 roots registered and unregistered, registry restored: True` |
| `npm run test -- --maxWorkers=4` | 1127 passed / 1 skipped (1124 before: +3 install cases) |
| `npm run test:contract` | 180 passed / 1 failed on the first pass — the snapshot check caught the 0.2.0 host name written literally in this feature's spec, research and quickstart; rewritten as "the 0.2.0 host name"; re-run below |
| `npm run test:contract` (after the rewrite) | 181 passed / 0 failed, 23 files |
| `npm run snapshot:check` (staged tree, all of this feature) | 534 files, 0 forbidden paths, 0 pattern hits (62 allowed) |

## Owed to the owner

- **T280** version bump: the four-root installer ships in whatever the next release is; bump to
  0.3.1 only if you want a release for it now (default: no bump).
- Merge `feature-010-multi-browser-host` into `main` (fast-forward) and re-run
  `npm run agent-host:install` on your machine if you want your own registry to carry the Edge and
  Brave roots (harmless either way).
- The live run on Edge and Brave: issue #2.

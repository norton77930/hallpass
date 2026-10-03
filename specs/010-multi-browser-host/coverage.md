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

## Live run on Microsoft Edge (issue #2), 2026-10-03

Edge 154.0.4258.37 (Stable, Windows 11), private profile and private `LOCALAPPDATA`, Edge's HKCU host
key pointed for the run at a manifest whose host is this branch's `native-host.js` (restored to the
installed host afterwards), the packaged gate in attach mode with a fresh browser per spec file. A
fresh Edge profile on a domain-joined machine signs in implicitly and starts syncing, which hides the
fixture behind a welcome page: launch with `--disable-sync --disable-features=msImplicitSignin,msEdgeOnRampFRE`.

| Result | Specs |
| --- | --- |
| all passed | pairing, actions, batch-upload, batch-wait, claim, computer, diagnostics, dialogs, false-stale, first-run, form-values, frames, input, interrupt, pairing-withdraw, panel-016, panel-multi, panel-states, privacy, reads, refs, sessions, site-plan, tabs, upload, upload-directory, upload-image, viewport, window-restore |
| passed until a download | downloads 1/2, recording 3/6, press-outcomes 1/2 |
| failed | transitions 0/1 (reproduced on a second run) |

- **After a download** Edge keeps an `edge://downloads-hub/` page target that `/json/close` does not
  close, and every later `connectOverCDP` times out. The product's part passed in each case (the
  download was reported by its saved path; the GIF was written); the later tests never reached the
  extension. Harness/Edge interaction, not a Hallpass defect - open: a way to keep the downloads
  flyout from opening in the test profile, then re-run the three specs.
- **transitions**: after the remembered A → B move is revoked, `navigate` to A's `/go-b` (redirected
  to B, which now needs the owner's answer) answers `navigation-timeout` although B has loaded (the
  failure screenshot shows Transition B). The same move while remembered passes. The settle watcher
  (`agent-tools/tabs.ts` `settleAfter` / `watchTabSettle`) does not see this load on Edge. Open
  Edge-specific defect; diagnose with a worker log of the tab's `onUpdated` events.
- Brave was not run (not installed on this machine).

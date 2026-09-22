---

description: "Task list for Multi-Browser Native Host Registration"
---

# Tasks: Multi-Browser Native Host Registration

**Input**: `/specs/010-multi-browser-host/spec.md`, `plan.md` (slices S1–S3), `research.md`
(R-154–R-159), `contracts/installer-output.md`, `quickstart.md`.

**Tests**: TDD in S1 (a RED case on the four-root constant and on the simulated failure before the
code moves); S2 closes on one proof run; S3 closes on a contract case. No reviewer pre-selected
(bounded, reversible by `uninstall`, no boundary crossed).

**Numbering** continues from 009 (T239–T263): this feature starts at **T264**.

## Standing rules (owner, 2026-09-18 — binding for every task)

1. **Two attempts, then stop.** A task that fails its second attempt is not tried a third time; the
   main session measures or reads, writes the finding into `research.md`, and re-briefs.
2. **No legacy identifier in the installer.** The identity test forbids it; the legacy rule stays
   `isLegacyRegistration` (a property). The proof script may name the old host, the installer never.
3. **One writer at a time.** S1 is one implementer brief; S2 is one brief for the script plus the
   main session's run; S3 is the main session.
4. **Nothing private leaves.** No absolute path or username in any edited file; `npm run
   snapshot:check` before the final commit.

## Phase 1 — Setup

- [X] T264 Read `packages/agent-host/src/install/{windows,cli,manifest}.ts`,
  `packages/agent-host/tests/install.test.ts` and `contracts/installer-output.md`; confirm the
  defect of R-155 (stdout lists every key before checking `reg add`) is present at HEAD and note the
  line in `research.md` R-155 (one sentence, no code change).

## Phase 2 — Foundational (blocks US1–US3)

- [X] T265 RED: in `packages/agent-host/tests/install.test.ts` replace the two-root case with
  "registers under the four native-messaging roots in table order" asserting
  `NATIVE_MESSAGING_ROOTS` is the R-154 table (`{ browser, root }` × 4) and
  `NATIVE_MESSAGING_REGISTRY_KEYS` is derived from it; run it, see it fail.
- [X] T266 GREEN: in `packages/agent-host/src/install/windows.ts` make `NATIVE_MESSAGING_ROOTS`
  the four-row table and derive `NATIVE_MESSAGING_REGISTRY_KEYS` by mapping; keep every existing
  export's signature (`registryListArguments`, `parseRegistrySubkeys`, `isLegacyRegistration`,
  `registryAddArguments`, `registryDeleteArguments`, `registryQueryArguments`, `runReg`); update
  the header comment (four roots, why).

## Phase 3 — US1: install once, every Chromium-family browser finds the host (P1) — FR-139, FR-140

- [X] T267 [US1] RED: in `packages/agent-host/tests/install.test.ts` add "registerAll writes every
  root, keeps going after a failure, and returns one outcome per root": a fake `reg` runner that
  fails the Edge key → expect outcomes `[written, written, failed(reason), written]` in table order.
- [X] T268 [US1] GREEN: create `packages/agent-host/src/install/registration.ts` exporting
  `registerAll(reg, manifestPath) → RegistrationOutcome[]` (data-model "Registration outcome");
  the loop calls `registryAddArguments` per key and records `written` or `failed` with
  `reg.output` as the reason; never throws.
- [X] T269 [US1] In `packages/agent-host/src/install/cli.ts` make `install` call `registerAll(runReg,
  manifestPath)`, print `registry: <Browser> <key>` **only** for `written`, print the
  `contracts/installer-output.md` stderr block for each `failed`, and return 1 if any failed;
  remove the second unconditional `registry:` loop (R-155).
- [X] T270 [US1] `status` prints `registry: present|missing <Browser> <key>` for the four keys
  (same file); run `npx vitest run --project unit packages/agent-host/tests/install.test.ts` green.

## Phase 4 — US2: uninstall and upgrade leave nothing behind in any browser (P2) — FR-141, FR-142, FR-143

- [X] T271 [US2] RED: in `packages/agent-host/tests/install.test.ts` add "unregisterAll reports
  removed or absent per root and never fails": fake runner where two keys exist and two do not →
  outcomes `[removed, absent, removed, absent]`; and "removeLegacyRegistrations visits every root in
  the table": fake runner records the roots it was asked to list → all four.
- [X] T272 [US2] GREEN: in `packages/agent-host/src/install/registration.ts` add
  `unregisterAll(reg) → RegistrationOutcome[]` (`reg delete` non-zero with "unable to find" →
  `absent`, otherwise `removed`) and move `removeLegacyRegistrations` from `cli.ts` here as
  `removeLegacyRegistrations(reg, readManifest) → { removedKeys, directories }`, iterating
  `NATIVE_MESSAGING_ROOTS`; `isLegacyRegistration` unchanged.
- [X] T273 [US2] In `packages/agent-host/src/install/cli.ts` make `uninstall` print `removed: <Browser>
  <key>` / `absent: <Browser> <key>` per outcome and exit 0; make `install` print `removed earlier
  version's registration: <key>` from the returned `removedKeys`; `--keep-legacy` unchanged.
- [X] T274 [US2] In `tests/acceptance/upgrade-host-proof.ps1`: extend `$newKeys` and `$legacyKeys`
  to the four roots (R-158); after the 0.2.0 install and before the new install, seed
  `$legacyKeys[2..3]` with `reg add … /ve /d <old manifest path> /f`; assert four new keys present
  and four legacy keys absent after the new install; the snapshot / restore functions cover all
  eight keys; the summary line says "earlier registration removed under 4 roots".
- [X] T275 [US2] Build (`npm run build`), then run the proof from a PowerShell outside Claude Code
  (`powershell -ExecutionPolicy Bypass -File tests/acceptance/upgrade-host-proof.ps1`); paste the
  summary line and the "restored registry" block into `specs/010-multi-browser-host/coverage.md`
  (create it). Main session; if the run needs the owner (GUI prompt), stop and ask.

## Phase 5 — US3: the documentation says what is verified and what is not (P3) — FR-144, FR-145

- [X] T276 [P] [US3] Open the tracking issue on the public repository:
  `gh issue create -R norton77930/hallpass --title "Live verification on Microsoft Edge and Brave"`
  with a body that names what is registered (four roots since 0.3.1), what is unverified (side
  panel, debugger attachment, tab groups on each), and how to verify (the packaged gate attached to
  that browser); record the number in `coverage.md`.
- [X] T277 [US3] `README.md` platform note (lines 11–12): "The installer registers the host for
  Google Chrome, Chromium, Microsoft Edge and Brave. Google Chrome is the browser the acceptance
  suite runs on; Edge and Brave are registered but not live-verified — see issue #N." Keep the
  macOS / Linux sentence and issue #1.
- [X] T278 [P] [US3] `docs/zh-TW/operations-guide.md` §1.1 Chrome bullet: list the four registry
  locations with 「Chrome 驗收過;Edge、Brave 只註冊、未實機驗證(issue #N)」;
  `scripts/package/README.md` line 111: four registry keys.
- [X] T279 [US3] RED→GREEN: in `tests/contract/public-files.contract.test.ts` add a case after
  "opens with the platform, the licence and the demo": the README names all four browsers and
  contains "not live-verified" and a link to issue #N; run
  `npm run test:contract -- tests/contract/public-files.contract.test.ts`.

## Phase 6 — Polish and final verification

- [ ] T280 Bump the host and extension version to 0.3.1 only if the owner asks; otherwise leave
  0.3.0 and note in `coverage.md` that the change ships with the next release. (Decision owed to the
  owner; default: no bump.)
- [X] T281 Final verification (the one planned): `npm run test`, `npm run test:contract`,
  `npm run snapshot:check` — all green; record numbers in `coverage.md`; commit on
  `feature-010-multi-browser-host`; memory `feature-010-progress`.

## Dependencies

- T264 → T265/T266 (foundation) → US1 (T267–T270) → US2 (T271–T275) → US3 (T276–T279) → T280/T281.
- US1 and US2 share `registration.ts`; US2 depends on US1's module existing. US3 depends only on
  the issue number (T276) and can start once T276 is done, in parallel with T275's proof run.

## Parallel opportunities

- T276 (issue) and T278 (zh-TW guide, package README) touch files nobody else edits and can run
  beside T274/T275.

## Implementation strategy

MVP = Phase 2 + US1: after T270 the installer writes four roots and reports honestly. US2 makes
uninstall and upgrade symmetric and proves it on the machine; US3 makes the claim public and
bounded. One implementer brief covers T265–T273 (one seam, one module); the proof edit T274 is a
second brief; the run and the documents stay with the main session.

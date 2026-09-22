# Quickstart: proving feature 010

Prerequisites: Windows 11, Node 24, a built checkout (`npm ci && npm run build`), and for the proof
run the two release zips (the 0.2.0 package zip the proof script names by default, and `release/hallpass-0.3.0.zip` or
the current package).

## 1. Unit cases (SC-071, SC-073, SC-074)

```
npx vitest run --project unit packages/agent-host/tests/install.test.ts
```

Expected: the four-root constant, the derived keys, the per-root outcomes, the simulated failure
(one root fails → three `written`, one `failed` with reason, exit code 1) and the legacy loop over
four roots all pass.

## 2. The host upgrade proof (SC-071, SC-072, SC-073)

Run from a PowerShell **outside** any Claude Code session (the worktree guard refuses it inside):

```
powershell -ExecutionPolicy Bypass -File tests/acceptance/upgrade-host-proof.ps1
```

Expected last line:

```
[T259] host upgrade 0.2.0 -> 0.3.x: relay -> ..., earlier directory untouched: True,
earlier registration removed under 4 roots, registry restored: True
```

The script snapshots eight keys (four current, four legacy), seeds legacy entries under Edge and
Brave, runs the old then the new installer under a scratch `LOCALAPPDATA`, asserts, restores, and
re-reads the registry to verify the restore. Exit code 0.

## 3. Documents and the issue (SC-075, SC-077)

```
npm run test:contract -- tests/contract/public-files.contract.test.ts
```

Expected: the new case finds all four browser names and the phrase "not live-verified" in the
README, and the issue link resolves to the number recorded in `coverage.md`.

## 4. Final verification (SC-076)

```
npm run test
npm run test:contract
npm run snapshot:check
```

All green; the snapshot check reports 0 forbidden paths, 0 pattern hits.

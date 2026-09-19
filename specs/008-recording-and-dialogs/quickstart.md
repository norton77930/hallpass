# Quickstart — proving feature 008

Everything here runs on the owner's branded Chrome 152 in attach mode (`HALLPASS_CDP_ENDPOINT`), the way
004–007 were proven. Prerequisites and the attach recipe are in
`specs/004-reference-parity-bridge/quickstart.md` §5; nothing new is needed except the two packages
`npm install` brings in (`gifenc`, `omggif`).

## 1. Build and load

```powershell
npx tsc -b
npm run build:extension:agent          # apps\extension\dist\agent — now with offscreen/index.html
npm run agent-host:install
```

Reload the unpacked extension; Chrome shows the new `offscreen` permission once. The panel title still
reads "Hallpass"; the manifest version is 0.2.0.

## 2. Unit and contract

```powershell
npx vitest run apps/extension/tests                       # recorder, frame-capture, overlay, encode (decodes back), dialogs, window-restore, input-attachment
npx vitest run tests/contract                             # agent-tools-008: schemas, permission set, narrow manifest unchanged, version = zip = watermark
```

Expected: all green; `input-attachment.test.ts` now asserts `Page.enable` is issued and that only the
two dialog events pass the runtime's event filter.

## 3. Attach gate (behaviour)

```powershell
$env:HALLPASS_CDP_ENDPOINT = "http://127.0.0.1:9222"
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-recording.spec.ts
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-dialogs.spec.ts
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-window-restore.spec.ts
npx playwright test --config playwright.extension.config.ts tests/e2e/packaged/agent-upgrade.spec.ts
```

What each proves:

| Spec | Scenario | Expected (decoded / observed) |
| --- | --- | --- |
| recording | 12 actions incl. a 3-step batch + 1 screenshot on the form page, export `TC-1234` | `TC-1234.gif` in the download folder; decoder: 14 frames, 800 ms each, last 2800 ms; label text on frames 5 and 12; ring within 3 px of the scaled click; watermark string = manifest name + version |
| recording | kill the worker after frame 6 of 10 | export has 11 frames (initial + 10) — if this fails, see R-134's fallback and record the measurement |
| recording | 205 actions | exactly 200 frames; answers 201–205 carry `recording.full === true`; frame 0 is the initial page |
| dialogs | fixture buttons: alert, confirm-dismiss, chained-accept (300 ms), unchained-accept (3 s timer), prompt-with-text, beforeunload-stay, beforeunload-force | each per US3; a `click` during an open dialog answers `blocked-by-dialog` in < 500 ms; in `ask` mode the chained case shows a notice, the unchained a card |
| window restore | maximize → `resize_window 1024×768` → release | window `maximized` again; four edge cases are unit tests |
| upgrade | 0.1.0 zip installed into a scratch profile, paired, two site modes; 0.2.0 `install.ps1` over it | pairing kept, modes kept, `gif_recorder` listed on the first call |

## 4. Probe (the coding agent as caller)

```powershell
npm run probe:004 -- --scenario s9-recording   # then s10-dialogs, s11-window-restore
```

Reports land in `tests/acceptance/probe-004/reports/` as `004-<ISO>Z.json/.md`; the recording report
names the file exactly as `downloads_context` reported it. Expected 1/1 each; SC-054 needs 3/3 on the
recording scenario.

## 5. Package and hand to QA

```powershell
npm run package                                  # release/hallpass-0.2.0.zip
```

The QA guide (`docs/qa-guide.html`) has the two new sections with panel screenshots; the operations
guide lists 31 tools and the `offscreen` permission.

## 6. When something does not pass

Second failed attempt on any task → stop. Re-read the behaviour analysis (private archive; public summary `docs/design-notes.md`
names the bundle sections) or take one measurement on the gate, write the finding as a new § in the
evidence file, and re-brief. Do not try a third variant of the same guess.

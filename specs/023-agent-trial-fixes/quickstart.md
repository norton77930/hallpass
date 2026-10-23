# Quickstart: validating 023

## Automated

```powershell
npm run typecheck
npm test
npm run build
npm run test:contract
npm run snapshot:check
```

Expected: all green; new tests cover the `browser` group in both modes, the tab file, the browser-tools
check (greeting in time / late / DeepSeek), the key-name check (present only in user settings / present in
the environment / not named), the output ring (50 lines, 500 chars, scrubbed values), and the panel's
waiting timer and 30 s hint.

## Live (owner's machine, dev host installed by the owner with `!`)

1. **Saved logins (SC-163)**: run the scratch measurement in `.scratch/023` against the owner's Hermes for
   strict and automatic: `browser_vault` absent; Hermes' own browser tools absent; `hallpass` tools present
   once step 3 is done.
2. **Browser-tools notice (SC-166)**: before adding the component, start a Hermes conversation: the notice
   names the missing component and how to add it.
3. **Add the component (D-023-4)**: dry run first and show the owner what changes; then add `mcp==2.0.0` to
   the owner's Hermes environment; a new Hermes conversation shows no notice and can take a screenshot.
4. **Tab (SC-165)**: attach the current tab in a Hermes and a DeepSeek conversation; ask for a summary.
5. **Waiting (SC-164)**: with the model server unreachable, send a message: waiting seconds within 2 s, hint at 30 s.
6. **Key name (SC-167)**: fake-agent test only (setting a variable after the browser starts is not repeated
   on the owner's machine).
7. **No key value (SC-168)**: search the broker log, diagnostics lines and screenshots for the key's prefix.

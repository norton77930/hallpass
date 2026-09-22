# Research: Multi-Browser Native Host Registration

Numbering continues from 009 (R-153).

## R-154 — Which roots, and how the list is shaped

**Decision**: a table of four `{ browser, root }` entries replaces the two-element tuple:

| browser | root |
| --- | --- |
| Google Chrome | `HKCU\Software\Google\Chrome\NativeMessagingHosts` |
| Chromium | `HKCU\Software\Chromium\NativeMessagingHosts` |
| Microsoft Edge | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts` |
| Brave | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts` |

`NATIVE_MESSAGING_REGISTRY_KEYS` is derived by mapping the table (`${root}\${AGENT_HOST_NAME}`),
not written out by index as today, so adding a browser is one row. The browser name travels with
the root so the installer's output can say which browser a line is about.

**Rationale**: the Edge and Brave roots were read from the owner's registry on 2026-09-21, where the
reference extensions' hosts sit under exactly these keys; both are the locations the browsers
document for per-user hosts. `HKCU` only (R-101).

**Alternatives**: probing which browsers are installed and writing only those — rejected: a browser
installed later would then never find the host, and writing an unused root is harmless (the reference
installers do the same).

## R-155 — Reporting per root, and the defect this exposes

**Finding**: `cli.ts` prints `registry: <key>` for every key in a second loop that never looks at the
result of the first; a failed `reg add` goes to stderr and the exit code, but stdout still lists the
root as registered. FR-140 forbids exactly that.

**Decision**: each root produces one outcome — `written`, `failed` (with `reg.exe`'s message),
`removed`, `absent` — and the CLI prints one line per outcome (contract in
`contracts/installer-output.md`). `install` exits 1 if any root failed; `uninstall` treats `absent`
as success. The loops keep going after a failure so the other roots are still written.

## R-156 — Legacy cleanup across four roots

**Decision**: no rule change. `removeLegacyRegistrations` already iterates `NATIVE_MESSAGING_ROOTS`
and decides per manifest with `isLegacyRegistration` (a property, not a name — the identity test
forbids a legacy identifier in the installer). With the table of four it covers four roots. A unit
case pins that the loop visits every root in the table.

## R-157 — Making the loops testable

**Finding**: `cli.ts` executes `await main()` at module load, so importing it in a test runs the
installer; the loops cannot be unit-tested where they are, and SC-074 (one root fails, the others
are still written, the exit code is non-zero) has no seam.

**Decision**: a new `registration.ts` exports `registerAll(reg, manifestPath)`,
`unregisterAll(reg)` and `removeLegacyRegistrations(reg, readManifest)` — each takes the registry
runner (today's `runReg`) as a parameter and returns outcomes; `cli.ts` passes the real runner and
prints. The test passes a fake runner that fails one root.

**Alternatives**: mocking `child_process` — rejected: heavier and it still would not stop `main()`
from running at import.

## R-158 — The upgrade proof with four roots

**Decision**: the proof script's two arrays (`$newKeys`, `$legacyKeys`) grow to four roots each,
snapshot and restore cover all eight keys, and before the new install the script seeds a legacy
entry under the 0.2.0 host name under the Edge and Brave roots pointing at the old manifest the 0.2.0
installer wrote — the 0.2.0 installer itself only writes two roots, so without seeding the proof
could not show FR-142 on the new roots. Assertions: four new keys present, four legacy keys gone,
registry restored (already verified by re-reading).

## R-159 — Wording and the tracking issue

**Decision**: one sentence pattern in three documents: "The installer registers the host for Google
Chrome, Chromium, Microsoft Edge and Brave. Google Chrome is the browser the acceptance suite runs
on; Edge and Brave are registered but not live-verified — see issue #N." The README's existing
platform note carries it; the ops guide §1.1 lists the four registry locations with the same marking;
the package README's registry line lists four. The issue is created with `gh issue create` on
`norton77930/hallpass` before the README edit so the number is real; the public-files contract test
adds one case that the README names all four browsers and the phrase "not live-verified".

**Alternatives**: claiming Chromium-family support outright — rejected (D-010-3, IV).

# Feature Specification: Multi-Browser Native Host Registration

**Feature Branch**: `010-multi-browser-host` (logical feature identifier; the spec is written on the
git branch `feature-010-multi-browser-host` in the `feature-008-spec` worktree, branched from `main`
at 4315c1b)

**Feature Directory**: `specs/010-multi-browser-host`

**Created**: 2026-09-21

**Status**: Draft — owner decisions D-010-1 to D-010-3 taken 2026-09-21 (below); ready for
`/speckit-plan`

**Input**: Owner question of 2026-09-21 while reviewing the technical-principles page: "so this
extension only runs in Chrome? Edge cannot? But Codex and Claude can be installed on Edge — why?" The
answer, verified against the owner's own registry: native messaging is a Chromium-family mechanism,
not a Chrome one; every browser reads its own registry root; the two reference extensions' installers
write the same host into the Chrome, Edge, Brave and Chromium roots, while Hallpass's installer
writes only the Chrome and Chromium roots. The gap is an installer decision (D-003, "branded Chrome
only"), not an architectural limit. The owner asked for the roots to be added "順手", through the
spec process.

**Owner decisions (2026-09-21)**:

- **D-010-1** — A separate small feature numbered 010; the viewport / zoom / upload_image work moves
  to 011.
- **D-010-2** — Edge **and** Brave, not Edge alone: the cost is one constant and one test case each,
  and the reference installer writes both.
- **D-010-3** — Live verification on Edge or Brave is **not** in this feature. The only claim this
  feature makes is that the registration exists; a public issue tracks the live run.

**Authoritative Source Order**: Constitution (V least privilege, VII observable, XI defined failure)
→ `docs/product-requirements-draft.md` PR-020 (pairing with a local agent, which the host serves) →
the owner's three decisions → the registry survey of 2026-09-21 (facts, cited inline). Reference
evidence applies only as an externally observable fact: the reference extensions register their host
under four browser roots (observed in the owner's registry on 2026-09-21); no internal of either
extension is used or named.

## Why this feature exists

Hallpass's native host is what lets a coding agent reach the extension: the browser spawns it from a
registry entry, and each Chromium-family browser reads its own entry. The 0.3.0 installer writes two
of those entries (Google Chrome and Chromium), so a user who loads the extension into Microsoft Edge
or Brave gets an extension that installs and pairs visually but whose bridge never connects, with no
message that says why. The extension itself is standard Manifest V3 and its identity (the extension ID
derived from the manifest key) is the same in every Chromium-family browser, so the host manifest's
allowed origin already matches. What is missing is two registry entries and an honest statement in
the documentation.

The feature is deliberately narrow. Writing a registry entry proves that the browser *can* find the
host; it does not prove that the side panel, the debugger attachment or the tab groups behave the
same in Edge or Brave. That proof needs a live run on each browser with the packaged gate, which is
its own piece of work (D-010-3). Until it is done, the documentation must say "registered, not
verified", exactly as it says today for Chromium-family browsers in general.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install once, every Chromium-family browser can find the host (Priority: P1)

A user who runs Hallpass's installer once, then loads the unpacked extension into Google Chrome,
Microsoft Edge, Brave or a Chromium build, sees the same result in each: the extension's side panel
reports the bridge as connected as soon as an agent starts, because the browser found the native host
in its own registry location.

**Why this priority**: it is the whole feature. Without it the other stories have nothing to remove
or describe.

**Independent Test**: run the installer under a scratch per-user directory with the registry
snapshotted; afterwards, all four roots hold a `com.hallpass.host` entry whose value is the host
manifest path; the installer's output names all four.

**Acceptance Scenarios**:

1. **Given** a machine with none of the four roots holding a Hallpass entry, **When** the installer
   runs, **Then** each of the four roots (Google Chrome, Chromium, Microsoft Edge, Brave) holds
   exactly one `com.hallpass.host` entry pointing at the host manifest, and the installer's output
   lists each root it wrote.
2. **Given** a root that already holds a `com.hallpass.host` entry pointing at an older manifest
   path, **When** the installer runs, **Then** the entry is overwritten with the current path (the
   behaviour the Chrome root already has).
3. **Given** the Edge and Brave roots do not exist at all (the browser was never installed),
   **When** the installer runs, **Then** the entries are created anyway (a registry key can be created
   under an absent parent), and a later install of that browser finds them.
4. **Given** one root cannot be written (a permission error on that key), **When** the installer
   runs, **Then** it still writes the other roots, names the failing root and the reason in its
   output, and exits non-zero — it never reports success for a root it did not write.

---

### User Story 2 - Uninstall and upgrade leave nothing behind in any browser (Priority: P2)

A user who uninstalls Hallpass, or who upgrades from 0.2.0 (which registered the host under its earlier name) or
from 0.3.0 (which registered two roots), ends with no stale entry in any of the four roots.

**Why this priority**: an entry left in a root the earlier version never wrote is impossible today,
but an entry left in a root this version writes and a later uninstall forgets would be a regression
of FR-126's guarantee. It is the other half of story 1.

**Independent Test**: install, then uninstall, under a registry snapshot; the four roots are as they
were before install. Separately, seed the earlier version's host entry under each of the four
roots, run the installer, and see all four removed.

**Acceptance Scenarios**:

1. **Given** all four roots hold a Hallpass entry, **When** the uninstaller runs, **Then** all four
   entries are gone and the uninstaller's output names each root it removed.
2. **Given** an earlier version's registration (the 0.2.0 host name, allowing exactly Hallpass's
   extension) exists under any of the four roots, **When** the installer runs without
   `--keep-legacy`, **Then** every such entry is removed and each removal is named in the output,
   while entries of other vendors and shared hosts under those roots are untouched (FR-126's rule,
   now applied to four roots).
3. **Given** the installer runs with `--keep-legacy`, **When** it finishes, **Then** no legacy entry
   under any root was touched.
4. **Given** a root holds no Hallpass entry, **When** the uninstaller runs, **Then** that root is
   reported as already absent and the exit code is still zero (an entry that was never there is not a
   failure).

---

### User Story 3 - The documentation says what is verified and what is not (Priority: P3)

A user reading the README or the zh-TW operations guide learns which browsers the installer
registers for and which of them the project has actually run its acceptance suite on, so nobody
mistakes "registered" for "supported".

**Why this priority**: it costs two paragraphs and prevents the wrong expectation; it is the
constitution's explicit-uncertainty principle applied to a platform claim.

**Independent Test**: read the two documents; the platform statement names the four registered
browsers, marks Google Chrome as the verified one, marks Edge and Brave as registered but not
live-verified, and links the public issue that tracks the live run.

**Acceptance Scenarios**:

1. **Given** the README's platform note, **When** a reader looks for Edge or Brave, **Then** they find
   both named as "registered, not verified" with a link to the tracking issue.
2. **Given** the zh-TW operations guide's browser section, **When** a reader looks at the registry
   locations, **Then** all four are listed with the same verified / unverified marking.

---

### Edge Cases

- A root exists but is owned by a policy that forbids per-user writes (managed machine): the
  installer reports that root as failed with the registry tool's message and exits non-zero; the other
  roots are still written (story 1, scenario 4).
- The same browser reads two roots (Chromium builds read the `Chromium` root; some builds also read
  the Chrome root): writing both is harmless because the entry is identical; nothing in this feature
  relies on which root a given browser reads.
- Firefox: a different mechanism (a JSON manifest in a fixed directory, not the Windows registry);
  explicitly out of scope, no entry is written, and the documentation does not mention it as
  supported.
- The upgrade proof script's registry snapshot and restore must cover the two new roots, otherwise a
  proof run would leave test entries behind on the owner's machine.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-139**: The installer MUST register the native host under the per-user native-messaging roots
  of Google Chrome, Chromium, Microsoft Edge and Brave in one run, and MUST name every root it wrote
  in its output.
- **FR-140**: The installer MUST NOT report success for a root it did not write: a root that fails
  to register is named with the reason, the remaining roots are still attempted, and the exit code is
  non-zero if any root failed.
- **FR-141**: The uninstaller MUST remove the host's entry from all four roots and name each root in
  its output; a root that held no entry is reported as absent and is not a failure.
- **FR-142**: The earlier-version cleanup of FR-126 (remove a registration under another host name
  that allows exactly Hallpass's extension; leave other vendors' and shared hosts alone; honour
  `--keep-legacy`) MUST apply to all four roots.
- **FR-143**: The host upgrade proof MUST snapshot, exercise and restore all four roots, so that a
  proof run leaves the machine's registry as it found it.
- **FR-144**: The README and the zh-TW operations guide MUST state that the installer registers for
  the four browsers, that Google Chrome is the browser the acceptance suite runs on, that Edge and
  Brave are registered but not live-verified, and MUST link the public issue that tracks the live
  run.
- **FR-145**: The public repository MUST carry one issue that tracks live verification on Edge and
  Brave (the packaged gate, the side panel and the debugger attachment on each), opened as part of
  this feature.

### Key Entities

- **Native-messaging root**: a per-user registry location a Chromium-family browser reads to find
  native hosts. Four are in scope: Google Chrome, Chromium, Microsoft Edge, Brave. Each holds at most
  one Hallpass entry.
- **Host entry**: the `com.hallpass.host` key under a root whose value is the absolute path of the
  host manifest. Identical under every root.
- **Legacy entry**: an entry under a name Hallpass no longer registers (today the 0.2.0 host name)
  whose manifest allows exactly Hallpass's extension; removed on install unless `--keep-legacy`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-071**: After one installer run on a machine with no Hallpass entries, all four roots hold the
  entry and the installer output lists four roots (unit cases for the constant and the output; one
  proof run).
- **SC-072**: After install then uninstall under a registry snapshot, the four roots are byte-for-byte
  as before install (one proof run, restore verified).
- **SC-073**: With a legacy entry seeded under each of the four roots, one installer run removes all
  four and names each; with `--keep-legacy`, none is touched (unit cases + one proof run).
- **SC-074**: A simulated failure on one root leaves the other three written, names the failing root,
  and exits non-zero (unit case with a faked registry tool).
- **SC-075**: The README and the zh-TW operations guide each contain the four-browser statement with
  the verified / unverified marking and the issue link (contract case in the public-files test).
- **SC-076**: The existing suites stay green: unit, contract, snapshot check.
- **SC-077**: One public issue exists for the live verification, linked from the README.

## Assumptions

- The registry roots are the ones the browsers document for per-user native hosts:
  `HKCU\Software\Microsoft\Edge\NativeMessagingHosts` and
  `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts` (both observed on the owner's
  machine on 2026-09-21, holding the reference extensions' hosts).
- The extension ID is unchanged across browsers because it is derived from the manifest's key, so
  the host manifest's allowed origin needs no change.
- Writing a root for a browser that is not installed is harmless and is the reference installers'
  behaviour too.
- No manifest permission, no extension code and no MCP contract changes; the feature touches the
  installer, its tests, the upgrade proof script, two documents and one public issue.
- Live verification on Edge and Brave (D-010-3) is a later feature; until then the documentation
  wording is "registered, not verified".

## Out of Scope

- Running the acceptance suite on Edge or Brave; any claim that they work.
- Store listings for any browser.
- Firefox (different mechanism), macOS and Linux (issue #1).
- Changing which browser the packaged gate attaches to.

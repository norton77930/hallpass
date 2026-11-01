# Tasks: macOS and Linux for the Outside-Agent Bridge

IDs continue from 027 (T853).

- [x] T854 Test first `install.test.ts` host paths per platform; then `host-paths.ts`. FR-433.
- [x] T855 Test first `install-posix-028.test.ts` folders, register, unregister; then `install/posix.ts`. FR-434.
- [x] T856 Test first (same file) the shell launcher, run for real with `sh`; then `createPosixLauncherScript`. FR-435.
- [x] T857 `install/cli.ts` install / uninstall / status by platform; run on Linux with a temporary HOME.
- [x] T858 Test first `brokerSupported`; the relay skips the broker outside Windows. FR-437.
- [x] T859 Test first: contract reason, relay reason, settings page text (both locales); then the code. FR-437.
- [x] T860 `install.sh` / `uninstall.sh`, in the package; `install-sh-028.contract.test.ts` runs them. FR-436.
- [x] T861 Mark the Windows-only tests; CI matrix (contract test first). FR-438.
- [x] T862 README (both), CONTRIBUTING, package README, CLAUDE.md, CHANGELOG (both).
- [x] T863 End to end on Linux (SC-193); full run; `coverage.md`.

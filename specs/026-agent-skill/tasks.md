# Tasks: A Hallpass Skill for Outside Coding Agents

Every behaviour task starts with its failing test (project rule). IDs continue from 025 (T828).

## S1 — the text and the host module

- [x] T829 [US1, US2] Write the skill text (R-412) in `packages/agent-host/src/agent-skill.ts` and the
      readable copy `skills/hallpass/SKILL.md` (R-413). FR-413..416, FR-424.
- [x] T830 [P] Contract test `tests/contract/agent-skill-text.contract.test.ts`: the copy equals the
      host's text; its fingerprint is the last of `SHIPPED_SKILL_HASHES`; frontmatter `name: hallpass` and
      a `description`; it names declining, timing out and not repeating; no `%`-variable path, no drive
      path. FR-413, FR-414, FR-424.
- [x] T831 Test first, `packages/agent-host/tests/agent-skill-026.test.ts`: the five states (CRLF copy is
      up to date; older shipped is update-available; other text is changed; unreadable), locations with and
      without `CLAUDE_CONFIG_DIR`. Then `skillLocations`, `readSkillStates`. FR-418, R-411, R-414.
- [x] T832 Test first (same file): install creates the folder and writes atomically; up-to-date writes
      nothing; changed is refused without `replaceChanged`; a write failure leaves the old copy and no temp
      file; `removeInstalledSkills` removes shipped copies only. Then `installSkill`, `removeInstalledSkills`.
      FR-417, FR-419, FR-420, FR-421.

## S2 — contracts and broker

- [x] T833 Test first in `packages/contracts/src/conversation.test.ts` and `settings.test.ts`: the state
      schema, overview `skills`, settings state `skills`, the command in both unions. Then the schemas.
- [x] T834 Test first `packages/agent-host/tests/broker-agent-skill-026.test.ts`: the overview carries
      both locations with `%USERPROFILE%` folders; `install-skill` writes and the next overview reads
      Up to date; `skill-changed` without `replaceChanged`. Then the broker case and the overview field.
- [x] T835 Wire the real skill port into the broker's handler (`broker.ts`).

## S3 — the settings page

- [x] T836 Worker: forward `ui.conversation.install-skill` (settings-port) and copy `skills` from the
      overview into the settings state (conversation-relay).
- [x] T837 Test first `apps/extension/tests/settings-agent-skill.test.tsx`: the section lists both
      folders with their state in both locales; Install sends the command; Changed by you asks before
      sending `replaceChanged`; no section when `skills` is absent. Then the section and locales.
- [x] T838 Keys in `settings-keys.ts`; both locales complete (the existing key test).

## S4 — uninstall and docs

- [x] T839 `install/cli.ts` uninstall calls `removeInstalledSkills` (its behaviour tested in T832) and
      prints what it removed and kept. FR-421. The CLI run itself (it calls `reg.exe`) is owed on
      Windows: quickstart step 7.
- [x] T840 README: the skill, where it goes, the settings section. CHANGELOG entries.
- [x] T841 Run typecheck, unit, extension-ui, build + contract, snapshot check; write `coverage.md`.

# Research: A Hallpass Skill for Outside Coding Agents

Decisions R-411..R-416 for spec 026 (D-026-1, D-026-2).

## R-411 — The two folders (D-026-1, FR-422)

**Decision**: Claude Code: `<config>\skills\hallpass\SKILL.md`, where `<config>` is `CLAUDE_CONFIG_DIR`
when the host's environment sets it, else `%USERPROFILE%\.claude`. Shared agents' folder:
`%USERPROFILE%\.agents\skills\hallpass\SKILL.md`, the user-level skills folder of the open skills layout
that Codex and other agents read. The folder name `hallpass` is the skill's name.

**Rationale**: both are per-user, so every project of the owner sees the skill and no repository gets a
copy (D-026-1). Each holds one folder per skill with a `SKILL.md`.

**Uncertainty**: which agents beyond Claude Code read `~/.agents/skills`, and from which version, is checked
on the owner's machine (quickstart step 5), not assumed; the state shown is about the file either way.

**Alternatives rejected**: project-level folders (D-026-1); a symlink to one copy (Windows checks links out
as text files, and a link would follow Hallpass's install folder when it moves).

## R-412 — The text (FR-413..416, FR-424)

**Decision**: one English page in the project's own words, from README "The consent model" and "Tools":
what the tool groups are for; pairing, the three site modes, reads never ask, site plans, an undecided site
asked at the next call; declined / timed-out / ended / taken back mean stop and tell the owner, never repeat;
never suggest changing a site mode. Frontmatter `name: hallpass` and a `description` that says when to use
it (any task in the owner's browser through the Hallpass tools). It points to the tool descriptions for
detail.

**Rationale**: short, so it costs the agent little context; the tool descriptions remain the reference.

## R-413 — One source, a readable copy

**Decision**: the text lives in `packages/agent-host/src/agent-skill.ts` (it is bundled into the host, so
the release package needs no extra file). `skills/hallpass/SKILL.md` at the repository root is the same
text for people reading the public repository or copying it by hand for another agent; a contract test
fails when the two differ.

## R-414 — State by fingerprint; paths said with `%USERPROFILE%` (FR-418, VI)

**Decision**: SHA-256 of the file's text with CRLF read as LF (a copy that went through an editor or Git on
Windows is still the same text). `SHIPPED_SKILL_HASHES` lists every text a release shipped, the current one
last. Missing → `not-installed`; equal to the current → `up-to-date`; equal to an older shipped one →
`update-available`; anything else (including another skill of the same name) → `changed`; a read error
other than "not there" → `unreadable` with the reason. The folder reaches the page with the profile said as
`%USERPROFILE%` (024 R-387's helper).

## R-415 — Install and update (FR-417, FR-419, FR-420)

**Decision**: one command `ui.conversation.install-skill { location, replaceChanged? }`. The host re-reads the
state first: `up-to-date` → ok, nothing written; `changed` or `unreadable` without `replaceChanged: true` →
refused `skill-changed`, nothing written; otherwise create the folder, write `SKILL.md.tmp-<pid>` and rename
it over `SKILL.md`. Any failure removes the temp file and answers `skill-write-failed` with the reason, the
previous copy untouched. Then an overview goes. The page asks the owner to confirm before it sends
`replaceChanged`.

## R-416 — Uninstall (FR-421)

**Decision**: `install.js uninstall` (which `uninstall.ps1` runs) removes each location's `SKILL.md` whose
state is `up-to-date` or `update-available`, then the `hallpass` folder if it is empty; a `changed` copy
stays and the output names its folder. The installer never installs the skill (D-026-2).

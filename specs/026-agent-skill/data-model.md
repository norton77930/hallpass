# Data Model: A Hallpass Skill for Outside Coding Agents

## Skill location (contract `AGENT_SKILL_LOCATIONS`)

| Value | Folder (R-411) |
| --- | --- |
| `claude-code` | `<CLAUDE_CONFIG_DIR or %USERPROFILE%\.claude>\skills\hallpass` |
| `agents` | `%USERPROFILE%\.agents\skills\hallpass` |

## Skill location state (`agentSkillStateSchema`, one per location, in this order)

| Field | Type | Rule |
| --- | --- | --- |
| `location` | `claude-code` \| `agents` | |
| `state` | `not-installed` \| `up-to-date` \| `update-available` \| `changed` \| `unreadable` | R-414 |
| `folder` | string, 1..400 | the folder, the profile said as `%USERPROFILE%` |
| `detail` | string, 1..600, optional | the reason, for `unreadable` only |

State transitions (owner actions only):

```text
not-installed --Install--> up-to-date
update-available --Update--> up-to-date
changed / unreadable --Update with replaceChanged--> up-to-date
any --uninstall--> not-installed (changed: stays changed)
```

## Shipped skill texts

`SHIPPED_SKILL_HASHES`: SHA-256 hex of each text a release shipped, current last; never shortened.

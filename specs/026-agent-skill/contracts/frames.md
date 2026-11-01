# Frames: A Hallpass Skill for Outside Coding Agents

All additions are optional fields or a new union member; host and extension upgrade together (as 024).

## `conversation-overview` (broker → worker)

Adds `skills?: AgentSkillState[]` (max 2, one per location, `claude-code` first). Absent from a host
before this feature.

## Settings state (worker → settings page)

Adds `skills?: AgentSkillState[]`, copied from the latest overview.

## `ui.conversation.install-skill` (settings page → worker → broker)

```json
{ "type": "ui.conversation.install-skill", "payload": { "location": "claude-code", "replaceChanged": true } }
```

`replaceChanged` optional, only `true` replaces a `changed` or `unreadable` copy. Results:

| Outcome | When |
| --- | --- |
| `ok` | written, or already up to date (nothing written) |
| error `skill-changed` | the copy is changed or unreadable and `replaceChanged` was not sent |
| error `skill-write-failed` | the folder or file could not be written; detail = reason, profile scrubbed |

An overview follows every `ok`.

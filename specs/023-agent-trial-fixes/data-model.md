# Data Model: 023

## Agent description (extended, broker)

| Field | Meaning |
|---|---|
| `takesBrowserTools` | the agent can be given MCP servers (Claude, Codex, Hermes: yes; DeepSeek: no) |
| `checksBrowserTools` | the broker checks the greeting after session creation (Hermes only in 023) |
| `expectedFirstStart` | text key for the starting line (30–60 s; DeepSeek: a few minutes) |
| `keyNameSource` | where the key variable name is read (Hermes: `model.key_env` / `model.api_key_env` in its home's `config.yaml`); absent for others |

## Run report (broker, per agent run, memory only)

| Field | Rule |
|---|---|
| `browserAttached` | `unknown` → `yes` on the worker frame; → `no` after 10 s past session creation/load without it; DeepSeek `no` at once |
| `browserNoticeSent` | at most one `browser-tools-missing` per conversation |
| `outputLines` | ring of ≤ 50 lines, each ≤ 500 chars, scrubbed (`withoutEnvironmentValues` then `redact()`) before storing |
| `keyNameOnlyInUserSettings` | computed only after an auth/model-setup failure; holds a variable **name** or nothing |

Lifecycle: created with the agent process; dropped when the conversation is removed, the run exits and is
not restarted, or the broker exits. A restart (mode change, resume) starts a new report; the browser notice
flag stays with the conversation.

## Tab file

Name: sanitised tab title + `.txt`, numbered on collision, inside `hallpass-attachments`. Content: title,
address, blank line, the tab text 022 already collects (same size limit). Expiry and cleanup as attached files.

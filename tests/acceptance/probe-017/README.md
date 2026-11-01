# Probe 017 - how each side-panel agent asks the user a question (issue #17)

Issue #17 wants an agent's question shown as a card in the side panel. ACP has a standard way for an agent
to ask: a form *elicitation* (`elicitation/create`), which a client receives only if it says at
`initialize` that it shows forms. Hallpass does not say so today. Which agents would use it, and how the
others ask (a permission request, plain text), is what this probe measures before anything is built.

## Run (Windows, the owner's machine)

```powershell
npm run build
npm run probe:017                                   # all four agents
npm run probe:017 -- --agent claude-code --agent codex
npm run probe:017 -- --bound 300                    # seconds per agent (default 180)
```

Each agent is started as a strict side-panel conversation would be (the host's own launcher), in an empty
temporary folder, with no MCP server and so no browser access, and is sent one prompt (one model call)
asking it to put a red-or-blue question to the user. Nothing is allowed: an elicitation is declined, a
permission request cancelled, file and terminal requests are never offered. The folder and the agent's
process tree are removed afterwards.

The report is written to `reports/probe-017-<time>.md` (git-ignored, never published): a summary table and
every agent's events in order - elicitations with their fields and choices, permission requests, tool calls,
text.

## What decides the next step

| Result for an agent | What #17 does for it |
| --- | --- |
| `asked by elicitation (form)` | Hallpass says it shows forms and turns the form into a side-panel card. |
| `asked through a permission request` | The question already reaches the panel as a consent card; see whether its options carry the choices. |
| `asked in plain text` | Only an agreed tagged block in the reply could become a card (less reliable); decide per agent. |
| `did not ask` / `did not start` | Look at the events; run again with a longer `--bound` if it timed out. |

The probe module is tested against the fake agent: `npx vitest run --project unit tests/acceptance/probe-017`.

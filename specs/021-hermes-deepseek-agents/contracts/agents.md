# Contracts: Hermes and DeepSeek

Additive changes to `packages/contracts/src/conversation.ts` (panel ⇄ worker ⇄ host). Host and extension
are version-paired, so no older peer sees them. Every object stays `strictObject`.

## Agent identifier

`CONVERSATION_AGENTS = ["claude-code", "codex", "hermes", "deepseek"]` — order is the panel's list order and
the default-agent fallback order (first ready).

## Availability

```text
agentAvailability = {
  agent, state: "missing" | "version-problem" | "needs-install" | "ready",
  version?, accepts?, installing?,            // unchanged
  notes?: ("git-missing" | "pre-release")[]  // NEW
}
```

## Permission card

```text
permission = { ..., rejectOnly?: true }  // NEW: only Reject may be offered and answered
```

`replay?: "none"` on the conversation projection marks a conversation the agent cannot replay (DeepSeek).

`ui.conversation.answer` with an allow answer on a `rejectOnly` card is refused (`invalid-command`).

## Stop while starting

`ui.conversation.stop` on a conversation in `starting` ends the start: result `ok`; the conversation event
`state: "stopped"` carries `code: "start-cancelled"`.

## Error codes (added)

- `start-cancelled` — the owner stopped a start.
- `agent-model-unreachable` — the agent could not reach its model (setup guidance, no key prompt).

## Agent launch (host-internal, not a wire contract)

| Agent | Command | Environment set by Hallpass |
|---|---|---|
| hermes | `hermes acp` | `HERMES_MANAGED_DIR=<managed>\<mode>` |
| deepseek | `node <dsh>\lib\bin.js --profile acp` | `DSH_PERMISSION_MODE`, `DSH_TELEMETRY_MODE=DISABLED` |

No key, endpoint or model is set by Hallpass; each agent reads its own configuration.

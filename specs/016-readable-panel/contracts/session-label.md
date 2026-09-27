# Contract: Session label frame (FR-226, R-203, R-204)

## Frame (host → relay → worker; link protocol stays 2)

```text
session-label { type: "session-label", sessionId: string (1..128), label: string (1..64) }
```

- A new member of the link frame union (`agentLinkFrameSchema`), strict like every other.
- Sent by the host once after each `hello-ack`, only when it has a label.
- The relay forwards it like any greeted frame (sessionId must match the greeting).
- The worker stores `label` on the session record and re-projects.

## Label derivation (host)

1. Client advertises `roots` → first `file://` root; else `process.cwd()`.
2. Last path segment (split on `/` and `\`), trimmed, truncated to 64.
3. No label when: empty, a drive / filesystem root, the user's home directory.
4. Never logged, never sent anywhere else.

## Compatibility

| Host | Worker | Result |
| --- | --- | --- |
| 0.9.0 | 0.9.0 | label shown |
| 0.9.0 | 0.8.0 | frame dropped as unknown (`agent.bridge.frame-rejected`), card as 0.8.0 |
| 0.8.0 | 0.9.0 | no frame; card shows agent name + start time |

## Tests

Contract: schema accepts the frame, rejects extra keys / empty / 65-char labels. Host: label from
cwd; home and root give none; roots preferred when advertised; sent after `hello-ack` and after a
re-greeting; not in stderr. Worker: label stored and projected; unknown session ignored.

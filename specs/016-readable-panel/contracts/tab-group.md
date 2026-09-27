# Contract: Tab-group marking (FR-238 – FR-241, R-207)

| Session state | Group title | Colour |
| --- | --- | --- |
| waiting for the owner | `🔔 Hallpass` | session colour |
| working (in-flight > 0, or < 1 s since the last call ended) | `⌛ Hallpass` | session colour |
| idle | `Hallpass` | session colour |
| released / ended | `""` (withdrawn, as 0.8.0) | grey (as 0.8.0) |

- Colour rotation: cyan, green, purple, pink, orange, grey, blue; assigned once per session.
- Title written only when it changes; a group created while the session waits starts with the bell.
- A session that no longer holds any of its own tabs in its group (it released the last one, or the
  owner dragged them all out or closed them all) withdraws the marking as an ended session does
  (`""`, grey; a refusal because the group is gone is ignored) and stops presenting that group; its
  next adopted or claimed tab opens and presents a new group.
- Stale groups after restart/reload: any group whose title is one of `Agent`, `Hallpass`,
  `⌛ Hallpass`, `🔔 Hallpass` and that no live session owns is withdrawn (as 0.8.0 does for `Agent`).
- Not localised.

## Tests

Unit: presenter transitions (idle → working → idle after 1 s; working → waiting → working; no write
when unchanged; new call within 1 s keeps ⌛); colour assignment persists across a worker restart;
stale query recognises the four titles. Gate: two sessions → two colours; a waiting one shows 🔔.

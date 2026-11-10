# Contract: Terminal consent, transition and site-plan questions (032)

Extends 031 `contracts/terminal-consent.md`. Everything not named here is unchanged.

## `prompt-raised` (worker → host)

| Field | Change |
|---|---|
| `kind` | `"effect" \| "diagnostics" \| "transition" \| "site-plan"` |
| `from` | new, optional; required for `transition`, refused for every other kind; a canonical site, ≤ 2048 |
| `sites` | new, optional; required for `site-plan`, refused for every other kind; 1..the site-plan proposal bound, each ≤ 2048 |
| `site` | transition: the destination; site plan: the first proposed site |
| `choices` | `effect`, `diagnostics`: contains `once` and `deny` (as 031). `transition`, `site-plan`: exactly `["session", "deny"]` |

A frame breaking any rule is refused at the host boundary and nothing is asked; the card still stands.

## Client form (host)

| kind | message | `session` title | `deny` title |
|---|---|---|---|
| effect, diagnostics | unchanged (031) | unchanged | Deny |
| transition | `Hallpass: <agent>'s tab moved from <from> to <site>. Continue on <site>?` | Continue for this session | Deny |
| site-plan | `Hallpass: allow <agent> to act on these sites for this session: <sites, comma-separated>?` | Allow these sites for this session | Deny |

The final wording may be tightened during implementation; it must name both sites (transition) or every
proposed site (site plan), and it must not offer *always*.

## `prompt-answer` (host → worker)

Unchanged. For `transition`, `session` means the card's *Continue*. For `site-plan`, `session` means approving
every proposed site for this session. Any other choice is ignored and the card keeps waiting.

## `prompt-waiting` (worker → host)

Shape unchanged. The worker sends one tick with `waitedMs: 0` when a question is armed. The host's cap for the
call is `max(fixed points) + 130 000 ms`, where each tick contributes `now - waitedMs` and each `prompt-raised`
contributes `now`.

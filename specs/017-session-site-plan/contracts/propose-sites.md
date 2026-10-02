# Contract: `propose_sites` tool and site-plan panel messages (017)

## MCP tool `propose_sites`

Description (agent-facing, own words): "Before working across several sites, propose them here with a
short purpose. The owner approves or declines in the browser's side panel; approved sites then need no
consent card for page actions in this session. Page JavaScript and file uploads still ask. Sites not
approved behave as before."

Input (strict):

```json
{
  "origins": ["https://example.com", "https://docs.example.org"],
  "purpose": "Compare the release notes with the changelog",
  "steps": ["read the release notes", "open the changelog", "fill the comparison form"]
}
```

- `origins`: 1–10 strings, each `new URL(x).origin === x`, scheme http/https, unique.
- `purpose`: 1–200 chars. `steps`: optional, ≤ 10 items, each 1–120 chars.
- Not allowed inside `browser_batch`.

Answers: see data-model.md "Tool answer". `approved` ⊆ `origins`; `leftOut` = `origins` − `approved`.

## Worker feature advertisement

pair-result `features` gains `"site-plan"`. Host behaviour:

| Host | Worker | Result |
| --- | --- | --- |
| 0.10.0 | advertises `site-plan` | forwarded, card raised |
| 0.10.0 | does not (0.9.0) | `unavailable` / `extension-too-old`, no card |
| 0.9.0 | any | tool not listed |

## Panel state / commands

See data-model.md. Both additions are optional fields / new union members in the existing strict
schemas; a projection without them is unchanged byte-for-byte.

## Covered tools constant

`AGENT_SITE_PLAN_COVERED_TOOLS` (contracts) — exact list in research R-250; contract test asserts it
equals `requiresGate` tools minus {`evaluate`, `file_upload`, `upload_image`, `navigate`, `tabs_close`}
(forced leaves keep asking; amended 2026-10-02, research R-250).

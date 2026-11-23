# Contract change: `prompt-raised` and the session card grants (043)

Amends 031 `contracts/terminal-consent.md` and 032 `contracts/terminal-consent-032.md`.

## `prompt-raised` (worker -> host)

- New optional field `alwaysInBrowser: true` (literal true; absent otherwise).
- Allowed only when `kind` is `"effect"`. Any other kind with the field is refused by the schema.
- Meaning: the side-panel card for this question offers *Always allow on <site>* for the frame's `site`.
- The host adds the R-581 hint to the elicitation message when the field is present and `choices` does not
  include `"session"`. The offered `choices`, `enum` and `enumNames` are unchanged by the hint.
- An effect question for `evaluate` on a loopback site (R-582) may now carry
  `choices: ["once", "session", "deny"]`. The schema already allows it; the worker now sends it.

## Session card `grants[].kind`

- `z.enum(["page-actions", "diagnostics", "scripts"])`. `scripts` is a session grant for page JavaScript on
  one loopback origin (R-583).

Host and extension ship as one pinned version (`tool-offering.ts`), so no older peer reads either change.

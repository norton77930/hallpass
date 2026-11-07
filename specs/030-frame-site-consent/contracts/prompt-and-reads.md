# Contract changes: prompt, reads, tool text

All schemas stay strict (`strictObject`). Host and extension ship together, as today.

## Effect prompt (`packages/contracts/src/agent-tools.ts`, `agentEffectPromptSchema`)

```text
frame?: { site: SiteOrigin }      // the action's target is in a frame of this site
      | { unknown: true }          // the frame's site could not be established
```

- `site` (existing) is still the page's site.
- `frame` is absent when the deciding site equals the page's site, so existing prompts are unchanged.
- The answer: when `frame.unknown` is set, a reply carrying `rememberMode` is refused.

## read_page frames (`agentReadPageFrameSchema`)

```text
site: SiteOrigin | "unknown"       // from the browser (R-440), on every frame
```

The doc comment on `url` changes to: "the address this frame reports for itself".

## read_page nodes and find matches

```text
site?: SiteOrigin | "unknown"      // only when different from the page's site
```

## Answers to the agent (text)

A refused or cancelled frame action names the frame's site and one reason (R-447):

| Reason | When |
| --- | --- |
| refused | the owner pressed Refuse on a frame card |
| undecided | the card timed out or was dismissed |
| frame moved | the re-check before the gesture found another site or document |
| unknown site | the frame's site could not be established, and the owner refused or did not answer |

## Tool descriptions

`click`, `double_click`, `triple_click`, `right_click`, `hover`, `drag`, `type`, `key`, `computer`,
`browser_batch`: "an action inside another site's embedded frame is decided by that site". `read_page` and
`find`: they mark frames and references from other sites. `propose_sites`: an embedded frame's site may be
proposed like any site.

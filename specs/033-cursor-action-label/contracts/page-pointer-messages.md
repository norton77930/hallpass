# Contract: page pointer messages (internal, extension only)

Worker → top frame (`chrome.tabs.sendMessage(tabId, message, { frameId: 0 })`). The content runtime
accepts a message only from its own extension id and only in exactly one of these shapes; anything else
is ignored without a reply. The agent-facing MCP tool protocol (`packages/contracts`) is unchanged.

```text
{ type: "pointer-step", words: string (≤ 60), mode: "travel" | "stay" | "rest" }   no reply awaited
{ type: "cursor", x: number, y: number, press?: true }                             reply { arrived: true }
{ type: "cursor", hide: true }                                                     reply none
{ type: "marks", hidden: boolean }                                                 reply { painted: true }
```

- Validators are exact-key checks in the content runtime (`isPointerStep`, `isCursorMessage`,
  `isMarksMessage`): an extra key, a wrong type or `words` over 60 characters rejects the message.
- `words` is rendered only through an attribute read by generated content (R-494).
- The worker never waits on `pointer-step`; it waits on `cursor` up to 420 ms (60 ms for the drag's
  held move) and on each `marks` message (hide, then show) up to 250 ms.
- Only the agent content script answers `cursor` and `marks`; the content runtime answers only its own
  `content.*` messages and stays silent on the rest, so it cannot pre-empt those replies.

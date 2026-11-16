# Contract: Pill Messages (internal)

Internal to the extension. The worker refuses a press message with any field not listed here. The page
ignores an `indicator` message whose listed fields have the wrong type, and stays permissive about
fields it does not know (as before 034), so an older or newer worker's extra field does not hide the pill.

## Worker → page: `indicator` (extended, R-518)

Sent with `chrome.tabs.sendMessage(tabId, message, { frameId: 0 })` as today, by `raise` and by the
announcement answer.

```ts
type IndicatorMessage = {
  type: "indicator";
  show: boolean;
  label?: string;              // unchanged
  action?: string;             // unchanged: "back to the agent's tab"
  mode?: "working" | "held" | "conversation";   // new; absent = "working" (an older worker)
  stop?: string;               // new; with mode working | conversation
  resume?: string;             // new; with mode held
  heldLabel?: string;          // new; with mode held
  stopUndelivered?: string;    // new; with mode working | conversation
  resumeUndelivered?: string;  // new; with mode held
};
```

- Every string is drawn with `textContent`; none is parsed as markup.
- `show: false` takes the pill (and glow) down as today, whatever the mode.
- The content guard (`isIndicatorMessage`) stays permissive for the existing fields and accepts the new
  ones only with the types above; a `mode` outside the three values is treated as absent.
- Both copies of the type (`content-runtime/indicator.ts`, `service-worker/agent-tools/indicator.ts`)
  change together.

## Page → worker: a press (new, R-517)

```ts
type PillPress = { type: "ui.agent.pill-stop" } | { type: "ui.agent.pill-resume" };
type PillPressReply = { accepted: boolean };
```

- Sent with `runtime.sendMessage` only from a click whose `isTrusted` is true.
- The worker: checks `sender.id === chrome.runtime.id`; takes the tab only from `sender.tab.id`; finds
  the holding session from the tab's lease; refuses (`accepted: false`) when there is no tab, no holding
  session, or the message has any other field. For `pill-resume` on a session that is not held it
  answers `accepted: true` and changes nothing.
- The worker answers through `sendResponse` and returns `true` from the listener for these two types
  only; every other content message keeps today's handling.
- The page: resends the same press once when no reply arrived 1 s after the press; shows
  `stopUndelivered` / `resumeUndelivered` when no reply arrived 2 s after the press; a rejected
  `sendMessage` counts as no reply. An `accepted: true` reply leaves the pill as it is until the
  worker's next `indicator` message redraws it (which follows the reply). `accepted: false` shows
  nothing extra.

## Worker → page: pointer step (unchanged, 033)

On Stop the worker sends each held tab one existing 033 pointer step with the `agent.pointer.stopped`
words in `rest` mode (R-519). No shape change.

## Panel → worker: `ui.agent.session-resume` (new, R-521)

```ts
{ type: "ui.agent.session-resume", payload: { sessionId: string } }
```

Added to `agentPanelCommandSchema` beside `ui.agent.session-interrupt`; routed like it. Unknown session
or a session that is not held: no change, no error to the panel.

## Worker → panel: session view (extended, R-521)

`agentSessionViewSchema` gains `heldAt?: string` (ISO date-time). Activity entries gain kinds `hold`
(outcome `held`) and `resume` (outcome `resumed`).

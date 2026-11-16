# Contract: Pill Messages, 035 additions (internal)

Internal to the extension. Extends `specs/034-pill-stop/contracts/pill-messages.md` and
`specs/033-cursor-action-label/contracts/page-pointer-messages.md`; everything not listed here is
unchanged. No agent-facing tool, field or stop reason changes.

## Worker → page: `indicator` (extended, R-530)

```ts
type IndicatorMessage = {
  // ... every 034 field unchanged ...
  edge?: "top" | "bottom";      // new; the owner's edge; absent or another value = "top"
  moveToTop?: string;           // new; move control words while the pill is drawn at the bottom
  moveToBottom?: string;        // new; move control words while the pill is drawn at the top
  openPanel?: string;           // new; the open control's words
  panelUnopened?: string;       // new; shown when the open did not succeed
};
```

- Sent with `chrome.tabs.sendMessage(tabId, message, { frameId: 0 })` as today, by `raise`, the
  announcement answer and every 034 redraw; additionally to every tab of every session after an accepted
  move press (R-529).
- The content guard stays permissive about unknown fields and checks the new ones' types; a wrong type
  is treated as absent.
- The move control is drawn when both move strings are present; the open control when `openPanel` is
  present. Both copies of the type (`content-runtime/indicator.ts`, `service-worker/agent-tools/indicator.ts`)
  change together.

## Page → worker: move press (new, R-529)

```ts
type PillMovePress = { type: "ui.agent.pill-move"; to: "top" | "bottom" };
type PillMoveReply = { accepted: boolean };
```

- Sent only from a click whose `isTrusted` is true; `to` is the edge the control names.
- The worker checks `sender.id === chrome.runtime.id` and that `sender.tab.id` is a number; refuses
  (`accepted: false`) a message with any other field or a `to` outside the two values. It does not
  require a lease (the setting is the owner's, not a session's).
- Accepted: store `to` as the owner's edge, answer, then redraw every held tab.
- The page uses 034's press timing (resend at 1 s, give up at 2 s) and shows nothing extra when it gives
  up.

## Page → worker: open press (new, R-527)

```ts
type PillOpenPress = { type: "ui.agent.pill-open-panel" };
type PillOpenReply = { opened: boolean };
```

- Sent only from a click whose `isTrusted` is true; never resent.
- The worker's handler: synchronous `sender.id` and `sender.tab.id` checks, then
  `activateWorkspace(sender.tab.id)` before any `await`; answers `{ opened: true }` when the open
  resolves, `{ opened: false }` when it rejects or the checks fail. Any other field: `{ opened: false }`
  and no open.
- The listener returns `true` for this type (and for `ui.agent.pill-move`, with 034's two presses).
- The page shows `panelUnopened` on `{ opened: false }`, a rejected send, or no reply 2 s after the press.

## Worker → page: `cursor` (extended, R-526)

```ts
type CursorMessage =
  | { type: "cursor"; x: number; y: number; press?: true; box?: Box }   // box new
  | { type: "cursor"; hide: true };
type Box = { x: number; y: number; width: number; height: number };    // top-document viewport px
```

- `box` is sent by element tools with a located target (ref click, hover, focusing click, drag start);
  never by `computer`.
- The page's exact-key validator accepts `box` only with exactly these four keys, all finite numbers,
  `width` and `height` ≥ 0; otherwise the message is refused as a whole, as any malformed `cursor` is.
- On receipt the page decides the pill's place (R-524, R-525) before it starts the glide; the reply is
  unchanged.

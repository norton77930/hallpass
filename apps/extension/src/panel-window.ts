/**
 * The side panel telling the worker which browser window it is in (fix 2026-09-23, panel in
 * another window).
 *
 * Why the worker has to be told: Chrome shows one side panel per window, so "a Hallpass panel is
 * connected" was never "the owner can see a card". Observed live on 2026-09-23 - a panel open in
 * another window turned the badge off and gave the pairing card the 45 s open-panel bound, and the
 * owner, in the window they were using, saw neither the card nor the badge. What the worker needs
 * is which window each panel is in, to compare with the window the owner last focused.
 *
 * Why the panel says it rather than the worker reading it: the port's `sender` carries no window
 * for an extension page (`sender.tab` is absent for a side panel - the trusted-sender check relies
 * on exactly that), and `chrome.runtime.getContexts` would answer with a `windowId` whose value for
 * a side panel this repository has not seen Chrome give. `chrome.windows.getCurrent()` inside the
 * panel document is the window hosting that document, which is the documented meaning of "current"
 * for an extension view.
 *
 * Why it lives here, beside `diagnostics.ts`, and not in `@hallpass/contracts`: it is a message
 * between two documents of this extension and nothing else - the host never sees it - and the
 * contracts' closed panel-command union is left exactly as it was. The parse is written out rather
 * than in zod for the same reason: the extension does not depend on zod directly, and three fields
 * do not need a schema library to be closed.
 */

export const PANEL_WINDOW_MESSAGE_TYPE = "ui.agent.panel-window";

export type PanelWindowMessage = {
  type: typeof PANEL_WINDOW_MESSAGE_TYPE;
  payload: { windowId: number };
};

export function panelWindowMessage(windowId: number): PanelWindowMessage {
  return { type: PANEL_WINDOW_MESSAGE_TYPE, payload: { windowId } };
}

/** Whether a message is *meant* as a window report, parsed or not - so a bad one is refused, not misread. */
export function isPanelWindowType(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === PANEL_WINDOW_MESSAGE_TYPE;
}

/**
 * The window id a well-formed report names, or `undefined`.
 *
 * Closed the way the zod `strictObject`s of the panel commands are: no extra keys at either level.
 * A window id is a non-negative integer; Chrome's two sentinels (`WINDOW_ID_NONE` -1,
 * `WINDOW_ID_CURRENT` -2) are not windows a panel can be in, so they are refused rather than stored.
 */
export function parsePanelWindowMessage(raw: unknown): number | undefined {
  if (!isPanelWindowType(raw)) return undefined;
  const message = raw as Record<string, unknown>;
  if (Object.keys(message).some((key) => key !== "type" && key !== "payload")) return undefined;
  const payload = message.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const fields = payload as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "windowId")) return undefined;
  const windowId = fields.windowId;
  if (typeof windowId !== "number" || !Number.isSafeInteger(windowId) || windowId < 0) return undefined;
  return windowId;
}

/**
 * The toolbar icon, while somebody is being asked something they cannot see (011 FR-152, R-160).
 *
 * Chrome refuses `sidePanel.open()` outside a user gesture, measured on the bundled Chromium and
 * true of the branded build as well, so the worker cannot put the question in front of the person.
 * What it can do is mark the one thing that is already on their screen - the extension's icon in
 * the toolbar - and say, in the tooltip, what clicking it is for. The words are the contract's
 * (contracts/prompt-waiting.md): the gate asserts them, so they live here once.
 *
 * The adapter decides nothing. `on` is handed to it by the runtime's derivation - something is
 * pending and no panel is connected - which is what lets that derivation be a pure function tested
 * without a browser, and keeps every `chrome.*` call in this directory.
 */

/** The mark itself: one character, because a badge is four at the outside and this is a shout. */
export const ATTENTION_BADGE_TEXT = "!";

/** Attention, not danger: a muted red, readable on the light and dark toolbars alike. */
export const ATTENTION_BADGE_COLOUR = "#b23a3a";

export const ATTENTION_TITLE = "Hallpass: a question is waiting — click to open the side panel";

/**
 * The title the manifest gives the action, with the message it names resolved.
 *
 * Read rather than repeated: the manifest's `__MSG_extActionTitle__` is localised, and a copy of
 * the English string here would put the person's own language back only until somebody edited one
 * of the two. An empty string is Chrome's own "use the extension's name", which is the right
 * fallback for a worker whose manifest cannot be read at all.
 */
function defaultTitle(): string {
  const declared = chrome.runtime?.getManifest?.()?.action?.default_title;
  if (typeof declared !== "string" || declared.length === 0) return "";
  const named = /^__MSG_(.+)__$/.exec(declared);
  if (!named?.[1]) return declared;
  return chrome.i18n?.getMessage?.(named[1]) || "";
}

/**
 * Marks or clears the icon. Fire and forget: these are notifications to the browser, and a worker
 * that is being torn down mid-call has nothing to do about the rejection but drop it.
 */
export function setAttention(on: boolean): void {
  const action = typeof chrome === "undefined" ? undefined : chrome.action;
  if (!action) return;
  const settle = (result: unknown): void => {
    void (result as Promise<unknown> | undefined)?.catch?.(() => undefined);
  };
  if (on) {
    settle(action.setBadgeText({ text: ATTENTION_BADGE_TEXT }));
    settle(action.setBadgeBackgroundColor({ color: ATTENTION_BADGE_COLOUR }));
    settle(action.setTitle({ title: ATTENTION_TITLE }));
    return;
  }
  settle(action.setBadgeText({ text: "" }));
  settle(action.setTitle({ title: defaultTitle() }));
}

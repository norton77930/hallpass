/**
 * A document's ordinary visible text: the body's text without form controls, scripts, styles,
 * templates, hidden or `aria-hidden` parts, and without Hallpass's own indicator layer.
 *
 * The one definition both readers use: the content runtime's collection (`get_page_text`, through
 * `collector.ts`) and the owner's "Attach this tab" (022 R-342), which runs it in the page through
 * `chrome.scripting` without binding the content runtime - a probe from a new conversation would
 * throw away the refs an agent session holds on the same tab.
 *
 * Self-contained on purpose: `chrome.scripting.executeScript` sends a function's source and nothing
 * it closes over, so everything it needs is a parameter (the marker attribute) or a page global
 * (`document`, when no body is handed in).
 */
export function visibleTextOf(
  markerAttribute: string,
  body?: {
    innerText?: string;
    textContent?: string | null;
    cloneNode?: (deep?: boolean) => unknown;
  } | null,
): string {
  const target = body === undefined ? (typeof document === "undefined" ? null : document.body) : body;
  if (!target) return "";
  if (typeof target.cloneNode === "function") {
    const clone = target.cloneNode(true) as {
      textContent?: string | null;
      querySelectorAll?: (selector: string) => ArrayLike<{ remove?: () => void }>;
    };
    const excluded = clone.querySelectorAll?.(
      "input, textarea, select, option, script, style, template, [hidden], " +
        '[aria-hidden="true"], [' +
        markerAttribute +
        "]",
    );
    if (excluded) {
      for (let index = 0; index < excluded.length; index += 1) excluded[index]?.remove?.();
    }
    return (clone.textContent ?? "").trim();
  }
  return (target.innerText || target.textContent || "").trim();
}

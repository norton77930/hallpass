/**
 * Text the panel shows that a page or an agent authored (security review 2026-11-05 S27): a target's
 * label, a dialog's message, an agent's display name, a typed value in a summary.
 *
 * React renders it inert, so there is no markup to fear; what is left are the characters that change
 * how the *surrounding* sentence reads without being visible themselves - the bidi overrides and
 * isolates (U+202A..U+202E, U+2066..U+2069), zero-width joiners and spaces, soft hyphens, the whole of
 * Unicode's format category - and the C0/C1 controls. A label that said "Cancel" and then flipped the
 * rest of the card's sentence right-to-left is the kind of thing this removes. A newline and a tab are
 * kept: a dialog's message may have lines, and the panel decides how to show them.
 */
const UNSHOWN = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function shownText(text: string): string {
  return text.replace(UNSHOWN, "");
}

/** `shownText` for an optional field: absent stays absent. */
export function shownOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : shownText(text);
}

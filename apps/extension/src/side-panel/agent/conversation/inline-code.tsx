import type { ReactElement } from "react";

/** T607 (W1): a path-looking word - one with a separator in it - and how long it may be before it is shortened. */
const PATH_WORD = /[^\s`"']*[\\/][^\s`"']*/g;
const PATH_SHOWN_AT_MOST = 30;

/**
 * T607 (W1): a long path in a step's title or input shown by its tail - "…\webhooks\signature.ts" -
 * so the row stays one line. Only the last two segments are kept, with the separator the path uses;
 * a short path, or one with fewer than three segments, is left as it is. Display only: the element
 * carries the whole text as its title.
 */
export function shortenPaths(text: string): string {
  return text.replace(PATH_WORD, (word) => {
    if (word.length <= PATH_SHOWN_AT_MOST) return word;
    const segments = word.split(/[\\/]+/).filter((segment) => segment !== "");
    if (segments.length < 3) return word;
    const separator = word.includes("\\") ? "\\" : "/";
    return `…${separator}${segments.slice(-2).join(separator)}`;
  });
}

/**
 * T606 (C4): an agent's step title with its backtick spans shown as inline code ("Run `npm test`").
 *
 * A plain split, no Markdown renderer: every piece is a text node, so nothing in the title is read
 * as markup. A title whose backticks do not pair up is shown exactly as written. T607: long paths in
 * it are shortened to their tail (`shortenPaths`).
 */
export function InlineCode(props: { text: string }): ReactElement {
  const parts = props.text.split("`");
  if (parts.length < 3 || parts.length % 2 === 0) return <>{shortenPaths(props.text)}</>;
  return <>{parts.map((part, index) => (index % 2 === 1 ? <code key={index}>{shortenPaths(part)}</code> : shortenPaths(part)))}</>;
}

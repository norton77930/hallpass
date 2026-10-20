import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "./icons.js";
import "./reply.css";

/**
 * 020 FR-316, FR-317, R-332, R-333 - one agent reply, rendered from its Markdown.
 *
 * The text is untrusted: an agent can repeat whatever a page said. The renderer builds React
 * elements from a syntax tree and never assigns HTML, so the safety rests on what the tree may
 * contain:
 * - raw HTML is not parsed; react-markdown turns it into a text node, so it is shown as written
 *   (FR-316: shown as text, never interpreted);
 * - every URL goes through react-markdown's default transform, which empties any scheme other than
 *   http(s), mailto, irc(s) and xmpp (`javascript:`, `vbscript:`, `data:` ...); a link left without
 *   an address is shown as its words;
 * - an image becomes a link to its address before rendering, so nothing is ever fetched;
 * - links open in a new tab without the panel as their opener.
 *
 * While the reply streams the text grows and is parsed again on each update; Markdown already reads
 * an unclosed code fence as a code block to the end of the text (R-333).
 */

type TreeNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
  value?: string;
};

/** A rehype step: every image becomes a link to its address labelled with its alt text. */
function imagesAsLinks() {
  return (tree: { type: string }): void => {
    rewriteImages(tree as TreeNode, false);
  };
}

function rewriteImages(parent: TreeNode, insideLink: boolean): void {
  const children = parent.children;
  if (children === undefined) return;
  children.forEach((child, index) => {
    if (child.type !== "element") return;
    if (child.tagName === "img") {
      const src = typeof child.properties?.["src"] === "string" ? child.properties["src"] : "";
      const alt = typeof child.properties?.["alt"] === "string" ? child.properties["alt"] : "";
      const label: TreeNode = { type: "text", value: alt === "" ? src : alt };
      // An image already inside a link keeps only its words: a link cannot hold another link.
      children[index] = insideLink
        ? label
        : { type: "element", tagName: "a", properties: { href: src, className: ["agent-reply-image"] }, children: [label] };
      return;
    }
    rewriteImages(child, insideLink || child.tagName === "a");
  });
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [imagesAsLinks];

const COMPONENTS: Components = {
  a({ node: _node, href, children, ...rest }) {
    // The URL transform emptied an unsafe address: the words stay, the link does not.
    if (href === undefined || href === "") return <span className={rest.className}>{children}</span>;
    // A footnote's jump within the reply stays in the panel.
    if (href.startsWith("#")) {
      return (
        <a {...rest} href={href}>
          {children}
        </a>
      );
    }
    // T593: only web and mail addresses leave the panel. Anything without a scheme would resolve
    // against the extension's own origin and open one of its pages in a tab.
    if (!/^(https?:|mailto:)/iu.test(href)) return <span className={rest.className}>{children}</span>;
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  pre({ node: _node, children }) {
    return (
      <pre className="agent-reply-code" tabIndex={0}>
        {children}
      </pre>
    );
  },
  table({ node: _node, children }) {
    return (
      <div className="agent-reply-table" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
};

/** Parsed again only when the text changed, not on every render of the list around it. */
const ReplyBody = memo(function ReplyBody(props: { text: string }): ReactElement {
  return (
    <div className="agent-reply">
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
        {props.text}
      </Markdown>
    </div>
  );
});

const COPIED_FOR_MS = 2_000;

/** FR-317: the reply's Markdown source onto the clipboard, and a short confirmation. */
function CopyButton(props: { text: string; t: (key: string) => string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(props.text))
      .then(
        () => {
          clearTimeout(timer.current);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
        },
        // Refused or unavailable: the button keeps saying Copy rather than claim it worked.
        () => setCopied(false),
      );
  };
  // T606 (C7): an icon button named in words; "Copied" is said to a screen reader by a status line
  // and shown by the button's mark, so the button keeps its name.
  const label = props.t("conversation.reply.copyLabel");
  return (
    <div className="agent-reply-tools">
      <button
        type="button"
        className="agent-icon-button agent-reply-copy"
        aria-label={label}
        title={props.t(copied ? "conversation.reply.copied" : "conversation.reply.copy")}
        data-copied={copied ? "" : undefined}
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span className="agent-reply-copied agent-sr-only" role="status">
        {copied ? props.t("conversation.reply.copied") : ""}
      </span>
    </div>
  );
}

export function Reply(props: { text: string; finished: boolean; t: (key: string) => string }): ReactElement {
  return (
    <>
      <ReplyBody text={props.text} />
      {props.finished ? <CopyButton text={props.text} t={props.t} /> : null}
    </>
  );
}

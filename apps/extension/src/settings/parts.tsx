import type { ReactElement, ReactNode } from "react";
import type { ConversationAgent } from "@hallpass/contracts";

/**
 * 024: the small pieces more than one section uses - the switch (the 006/019 `role="switch"` button
 * pattern, label and state in the accessible name), an agent's avatar (initials on a group colour, no
 * product marks) and the check marks.
 */
export function Switch(props: {
  checked: boolean;
  /** The accessible name; the visible text, when there is one, is `children`. */
  label: string;
  onChange: (next: boolean) => void;
  describedBy?: string;
  disabled?: boolean;
  children?: ReactNode;
  "data-fid"?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      disabled={props.disabled}
      data-fid={props["data-fid"]}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="track" />
      {props.children === undefined ? null : <span>{props.children}</span>}
    </button>
  );
}

export function Avatar(props: { agent: ConversationAgent; name: string; size?: "sm" }): ReactElement {
  return (
    <span className={`avatar av-${props.agent}${props.size === undefined ? "" : ` ${props.size}`}`} aria-hidden="true">
      {Array.from(props.name)[0] ?? "?"}
    </span>
  );
}

export type MarkKind = "ok" | "warn" | "bad" | "muted";
const MARK_GLYPH: Record<MarkKind, string> = { ok: "✓", warn: "!", bad: "✕", muted: "–" };

export function Mark(props: { kind: MarkKind }): ReactElement {
  return (
    <span className={`mark ${props.kind}`} aria-hidden="true">
      {MARK_GLYPH[props.kind]}
    </span>
  );
}

/**
 * What kind of control a consent card says an action is on (006 FR-085, change log 2026-11-21).
 *
 * The page decides an element's role - an ARIA attribute can say anything - so the page's spelling
 * never reaches the panel. The worker maps the role it read to one member of this closed list and
 * sends only that; the panel looks the member up in its own catalog and treats anything outside the
 * list as `other`. Only the control's *name* is the page's wording, and the card quotes it.
 *
 * It lives here, beside `panel-window.ts`, because the worker and the panel both read it and the
 * contracts package stays as it is: `targetRole` is already a free string there.
 */

export const TARGET_ROLES = [
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "tab",
  "menuitem",
  "switch",
  "slider",
  "option",
  "other",
] as const;

export type TargetRole = (typeof TARGET_ROLES)[number];

/** The worker-only value for a control the read could not describe: the card says so. */
export const TARGET_UNREADABLE = "unreadable" as const;

/** A page role that is spelled differently from the list member it means. */
const SAME_KIND: Readonly<Record<string, TargetRole>> = {
  searchbox: "textbox",
  listbox: "combobox",
  menuitemcheckbox: "menuitem",
  menuitemradio: "menuitem",
};

/**
 * Input types a person does not type text into (006 change log 2026-11-21, consent statement 11).
 * The collector reports each by a kind word of its own (`slider`, `date`, `time`, `month`, `week`,
 * `datetime`, `color`; 040 change log 2026-11-21), and those outside this closed list reach the card
 * as `other` already. This map is for a page that wrote `role="textbox"` on one: a card calling a
 * date picker or a colour well a text field misleads the owner, so the card says what it is or, with
 * no word for it in the list, `other`.
 */
const NOT_TYPED_INPUT: Readonly<Record<string, TargetRole>> = {
  range: "slider",
  date: "other",
  time: "other",
  month: "other",
  week: "other",
  "datetime-local": "other",
  color: "other",
};

export function isTargetRole(value: unknown): value is TargetRole {
  return typeof value === "string" && (TARGET_ROLES as readonly string[]).includes(value);
}

/**
 * The list member for a role the page reported; a role the page made up, or none, is `other`.
 * `controlType` is the input's own type when the collector gave one: a `textbox` that is an input
 * nobody types into is not called one.
 */
export function targetRoleOf(pageRole: string | undefined, controlType?: string): TargetRole {
  if (pageRole === undefined) return "other";
  const role = pageRole.trim().toLowerCase();
  const same = Object.hasOwn(SAME_KIND, role) ? SAME_KIND[role] : undefined;
  const member = same ?? (isTargetRole(role) ? role : "other");
  const type = controlType?.trim().toLowerCase();
  if (member === "textbox" && type !== undefined && Object.hasOwn(NOT_TYPED_INPUT, type)) {
    return NOT_TYPED_INPUT[type] ?? member;
  }
  return member;
}

import type { ReactElement } from "react";

/**
 * 036 R-540: the session card's small line icons, drawn here (no icon library, no dependency).
 *
 * Every icon is decoration: `aria-hidden`, drawn in `currentColor` so the token the text carries
 * colours it, and always beside its words or inside a button that has an accessible name.
 */
function Icon(props: { children: ReactElement | ReactElement[]; size?: number }): ReactElement {
  return (
    <svg
      className="agent-icon"
      viewBox="0 0 16 16"
      width={props.size ?? 13}
      height={props.size ?? 13}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.children}
    </svg>
  );
}

/** A tab the session holds. */
export function TabIcon(): ReactElement {
  return (
    <Icon>
      <path d="M2.5 5.5v7h11v-7h-5l-1-2h-5v2" />
    </Icon>
  );
}

/** A site in the session's site plan. */
export function PlanIcon(): ReactElement {
  return (
    <Icon>
      <path d="M3 3.5h10M3 8h10M3 12.5h6" />
    </Icon>
  );
}

/** A grant: allowed. */
export function CheckIcon(): ReactElement {
  return (
    <Icon>
      <path d="M3.5 8.5l3 3 6-7" strokeWidth="1.5" />
    </Icon>
  );
}

/** Given in the terminal. */
export function TerminalIcon(): ReactElement {
  return (
    <Icon>
      <path d="M4 5.5l2.5 2.5L4 10.5M8 11h4" />
    </Icon>
  );
}

/** Given in Chrome. */
export function BrowserIcon(): ReactElement {
  return (
    <Icon>
      <rect x="2.5" y="3" width="11" height="10" rx="2" />
      <path d="M2.5 6h11" />
    </Icon>
  );
}

/** The open/fold mark of a card header; turned a quarter when the card is open. */
export function ChevronIcon(): ReactElement {
  return (
    <Icon size={16}>
      <path d="M6 4l4 4-4 4" strokeWidth="1.4" />
    </Icon>
  );
}

/** Manage a site's permissions: opens the settings page. */
export function ExternalIcon(): ReactElement {
  return (
    <Icon size={14}>
      <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" />
    </Icon>
  );
}

/** Where something was given: Chrome or the terminal. */
export function PlaceIcon(props: { place: "client" | "browser" }): ReactElement {
  return props.place === "client" ? <TerminalIcon /> : <BrowserIcon />;
}

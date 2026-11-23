import type { AgentPanelState } from "@hallpass/contracts";
import {
  ACTIVITY_OUTCOME_KEYS,
  CONSENT_ANSWER_KEYS,
  CONSENT_QUESTION_KEYS,
} from "../agent-panel-keys.js";
import { activityText, type ActivityItem } from "./activity-text.js";
import { displayOrigin } from "./display-origin.js";

/**
 * 036 - the session card's parts, made in the panel from the picture it already receives (FR-557).
 *
 * Nothing here touches the DOM, a frame or a stored value: which sites a card lists and with which
 * marks (R-534), which activity rows it shows (R-535), which sessions need the owner and in which
 * group (R-536), and whether a card is open (R-537). The card draws what these return.
 */
export type SessionView = AgentPanelState["sessions"][number];

/** The id the question slot's card carries, so Answer in a card header can bring it into view (R-538). */
export const CONSENT_CARD_ID = "agent-consent-card";

// ---------------------------------------------------------------------------------------------
// Sites and permissions (R-534, FR-545, FR-546)
// ---------------------------------------------------------------------------------------------

export type SiteGrant = { kind: "page-actions" | "diagnostics" | "scripts"; source: "client" | "browser" };

export type SiteRow = {
  /** The canonical origin; absent for a held host whose tab url did not parse. */
  origin?: string;
  /** The display form: no scheme, the port when it is not the default, an internationalised host in both forms. */
  host: string;
  tabHere: boolean;
  inPlan: boolean;
  grants: SiteGrant[];
};

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** An origin as the card writes a site: `displayOrigin` without its scheme (FR-545). */
export function siteLabel(origin: string): string {
  return displayOrigin(origin).replace(SCHEME, "");
}

function originOfUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const { origin } = new URL(url);
    // `URL.origin` is the string "null" for an opaque origin (about:, data:): no site to list.
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function hostOfUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One row per site the session holds a tab on, acts on, holds a grant for, or has in its site plan: held
 * first, then the acting site, the granted and the rest of the plan, each once (FR-545). Rows are keyed by origin, matched by
 * exact string. A held tab whose url does not parse is listed by its host from `sites`, with no
 * origin; a later origin with that same host takes that row over rather than adding a second one.
 */
export function sitesOf(session: SessionView): SiteRow[] {
  const rows: SiteRow[] = [];
  const find = (origin: string): SiteRow | undefined => {
    const exact = rows.find((row) => row.origin === origin);
    if (exact !== undefined) return exact;
    const label = siteLabel(origin);
    const hostOnly = rows.find((row) => row.origin === undefined && row.host === label);
    if (hostOnly !== undefined) hostOnly.origin = origin;
    return hostOnly;
  };
  const row = (origin: string): SiteRow => {
    const found = find(origin);
    if (found !== undefined) return found;
    const added: SiteRow = { origin, host: siteLabel(origin), tabHere: false, inPlan: false, grants: [] };
    rows.push(added);
    return added;
  };

  const heldHosts = new Set<string>();
  for (const tab of session.tabs) {
    const origin = originOfUrl(tab.url);
    if (origin === undefined) continue;
    row(origin).tabHere = true;
    const host = hostOfUrl(tab.url);
    if (host !== undefined) heldHosts.add(host);
  }
  // The hosts the worker named that no parsed tab url accounts for.
  for (const host of session.sites ?? []) {
    if (heldHosts.has(host) || rows.some((existing) => existing.host === host)) continue;
    rows.push({ host, tabHere: true, inPlan: false, grants: [] });
  }
  // 024 FR-393: the site the worker says this session acts on, so its permissions stay one press away.
  if (session.site !== undefined) row(session.site);
  for (const grant of session.grants ?? []) {
    const target = row(grant.site);
    if (!target.grants.some((known) => known.kind === grant.kind && known.source === grant.source)) {
      target.grants.push({ kind: grant.kind, source: grant.source });
    }
  }
  for (const origin of session.sitePlan?.origins ?? []) row(origin).inPlan = true;
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Recent activity (R-535, FR-549, FR-550, FR-555)
// ---------------------------------------------------------------------------------------------

export type RowTone = "ok" | "warn" | "danger" | "muted";

export type ActivityRow = {
  /** The newest item's time in the row. */
  at: number;
  kind: "hold-resume" | ActivityItem["kind"];
  /** Pairs folded into the row (hold-resume only), at least 1. */
  count: number;
  text: string;
  result?: string;
  tone: RowTone;
  /** Where a consent was answered. */
  place?: "client" | "browser";
};

/** Two items of one plan event: the site-plan line and its consent answer land within this many ms. */
const SAME_MOMENT_MS = 2_000;

/** FR-549: only an allowed answer reads as success; a dialog OK, a delivery or a restore is a plain result (muted). */
const OK_OUTCOMES = new Set(["approved"]);
const DANGER_OUTCOMES = new Set(["refused"]);
const WARN_OUTCOMES = new Set(["held", "interrupted"]);

function toneOfOutcome(outcome: string): RowTone {
  if (OK_OUTCOMES.has(outcome)) return "ok";
  if (DANGER_OUTCOMES.has(outcome)) return "danger";
  if (WARN_OUTCOMES.has(outcome)) return "warn";
  return "muted";
}

/** The local `HH:mm` of an activity time (FR-549). */
export function clockOfMs(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function placeOf(item: ActivityItem): ActivityRow["place"] {
  return item.channel === "client" || item.channel === "browser" ? item.channel : undefined;
}

/**
 * The card's activity rows from the worker's list, which is newest first and stays that way: a
 * display-only merge, never a reorder (FR-550). A Resume directly followed (older) by its Stop is one
 * row, k such pairs one row with the count; a site-plan line followed by the consent answer for that
 * plan at the same moment is one row carrying the answer's place.
 */
export function rowsOf(activity: readonly ActivityItem[], t: (key: string) => string): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const sentence = (item: ActivityItem): string => activityText(item, t, siteLabel);
  for (let index = 0; index < activity.length; index += 1) {
    const item = activity[index] as ActivityItem;
    const next = activity[index + 1];

    if (item.kind === "resume" && next?.kind === "hold") {
      let pairs = 1;
      let cursor = index + 2;
      while (activity[cursor]?.kind === "resume" && activity[cursor + 1]?.kind === "hold") {
        pairs += 1;
        cursor += 2;
      }
      rows.push({
        at: item.at,
        kind: "hold-resume",
        count: pairs,
        text:
          pairs === 1
            ? t("agent.activity.holdResume")
            : t("agent.activity.holdResumeMany").replace("{k}", String(pairs)),
        tone: "muted",
      });
      index = cursor - 1;
      continue;
    }

    if (item.kind === "hold" || item.kind === "resume" || item.kind === "interrupt") {
      // The sentence says what happened; a second outcome word would say it twice (FR-555).
      rows.push({ at: item.at, kind: item.kind, count: 1, text: sentence(item), tone: "muted" });
      continue;
    }

    if (item.kind === "consent") {
      const given = item.answer;
      const answered = given !== undefined && given !== "timed-out" && item.channel !== undefined && item.channel !== "none";
      const place = placeOf(item);
      rows.push({
        at: item.at,
        kind: "consent",
        count: 1,
        text: t("agent.activity.consentRow")
          .replace("{question}", () => (item.question === undefined ? "" : t(CONSENT_QUESTION_KEYS[item.question])))
          .replace("{site}", () => siteLabel(item.site ?? "")),
        result: answered ? t(CONSENT_ANSWER_KEYS[given]) : t("agent.activity.consentTimedOut"),
        tone: !answered ? "warn" : given === "deny" ? "danger" : "ok",
        ...(answered && place !== undefined ? { place } : {}),
      });
      continue;
    }

    const folded =
      item.kind === "site-plan" &&
      next?.kind === "consent" &&
      next.question === "site-plan" &&
      Math.abs(item.at - next.at) <= SAME_MOMENT_MS
        ? next
        : undefined;
    const place = folded === undefined ? undefined : placeOf(folded);
    rows.push({
      at: item.at,
      kind: item.kind,
      count: 1,
      text: sentence(item),
      ...(item.outcome === undefined
        ? {}
        : { result: t(ACTIVITY_OUTCOME_KEYS[item.outcome]) }),
      tone: item.outcome === undefined ? "muted" : toneOfOutcome(item.outcome),
      ...(place === undefined ? {} : { place }),
    });
    if (folded !== undefined) index += 1;
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Who needs the owner, and open or folded (R-536, R-537, FR-538 - FR-542)
// ---------------------------------------------------------------------------------------------

/** A session that is waiting, working, or stopped from the page. No state reads as working, as it always did. */
export function needsOwner(session: SessionView): boolean {
  const state = session.state ?? "working";
  return state === "waiting" || state === "working" || session.heldAt !== undefined;
}

export type PrimaryAction = "answer" | "resume" | "interrupt";

/** The one action the header carries (FR-542): answer while waiting, resume while stopped, interrupt while working. */
export function primaryAction(session: SessionView): PrimaryAction | undefined {
  const state = session.state ?? "working";
  if (state === "waiting") return "answer";
  if (session.heldAt !== undefined) return "resume";
  if (state === "working") return "interrupt";
  return undefined;
}

/** Newest activity first, a session with no time last - the order the shell has always used (R-536). */
export function groupSessions(sessions: readonly SessionView[]): { attention: SessionView[]; idle: SessionView[] } {
  const sorted = [...sessions].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  return { attention: sorted.filter(needsOwner), idle: sorted.filter((session) => !needsOwner(session)) };
}

/** Whether a card is open: the owner's choice, else open when it needs them or is the only session (FR-539, FR-540). */
export function isOpen(session: SessionView, choice: boolean | undefined, onlyOne: boolean): boolean {
  return choice ?? (needsOwner(session) || onlyOne);
}

/**
 * The panel document's memory of the owner's open/fold choices (R-537): the choice per session and
 * what `needsOwner` was when the session was last seen. Held in memory only, never stored.
 */
export type FoldState = {
  choices: ReadonlyMap<string, boolean>;
  seen: ReadonlyMap<string, boolean>;
};

export const noFolds: FoldState = { choices: new Map(), seen: new Map() };

/**
 * The fold state after a new picture: a session that now needs the owner and did not loses its choice
 * (it opens); one that no longer needs them while shown open keeps its card open; sessions that are
 * gone are forgotten. The same state comes back when nothing changed, so a render can compare. The
 * first sight of a session is not a change.
 */
export function advanceFolds(folds: FoldState, sessions: readonly SessionView[]): FoldState {
  const choices = new Map<string, boolean>();
  const seen = new Map<string, boolean>();
  for (const session of sessions) {
    const needs = needsOwner(session);
    const before = folds.seen.get(session.sessionId);
    let choice = folds.choices.get(session.sessionId);
    if (before !== undefined && before !== needs) {
      if (needs) choice = undefined;
      else if (choice === undefined) choice = true;
    }
    if (choice !== undefined) choices.set(session.sessionId, choice);
    seen.set(session.sessionId, needs);
  }
  const same =
    choices.size === folds.choices.size &&
    seen.size === folds.seen.size &&
    [...choices].every(([id, value]) => folds.choices.get(id) === value) &&
    [...seen].every(([id, value]) => folds.seen.get(id) === value);
  return same ? folds : { choices, seen };
}

/** The owner pressed a card's header: it becomes the opposite of what is shown. */
export function toggleFold(folds: FoldState, session: SessionView, onlyOne: boolean): FoldState {
  const choices = new Map(folds.choices);
  choices.set(session.sessionId, !isOpen(session, folds.choices.get(session.sessionId), onlyOne));
  return { choices, seen: folds.seen };
}

import type { AgentPanelState } from "@hallpass/contracts";
import {
  CONSENT_ANSWER_KEYS,
  CONSENT_PLACE_KEYS,
  CONSENT_QUESTION_KEYS,
  WINDOW_STATE_KEYS,
} from "../agent-panel-keys.js";
import { displayOrigin } from "./display-origin.js";

export type ActivityItem = NonNullable<AgentPanelState["sessions"][number]["activity"]>[number];

/**
 * The line an activity item reads as (008 FR-113, FR-119).
 *
 * One template per kind, because the kinds are different sentences about different things: a
 * dialog is something a *page* said, a restore is something this extension did to the owner's own
 * window. Both are written here from pieces - a state word, a host, the page's own message - so no
 * worker English ever reaches the card.
 */
export function activityText(
  item: ActivityItem,
  t: (key: string) => string,
  /** How a site is written in the sentence: with its scheme as the worker gave it, or as the card's rows write it (036 FR-549). */
  site: (origin: string) => string = displayOrigin,
): string {
  if (item.kind === "interrupt") {
    // 014 FR-182: one line for the owner's own action, with no site and no message - they ended a
    // step, and which step it was is not something the card should claim to know afterwards.
    return t("agent.activity.interrupt");
  }
  if (item.kind === "hold") {
    // 034 R-521: the owner pressed Stop on the page - one line, no site and no message, as an interrupt.
    return t("agent.activity.hold");
  }
  if (item.kind === "resume") {
    return t("agent.activity.resume");
  }
  if (item.kind === "restore") {
    const state = item.message === "fullscreen" ? WINDOW_STATE_KEYS.fullscreen : WINDOW_STATE_KEYS.maximized;
    return t("agent.activity.restore").replace("{state}", () => t(state));
  }
  if (item.kind === "viewport") {
    // 012 FR-159: a third sentence, because this is a third kind of thing. The size is the
    // worker's own `"WxH"` - two numbers it chose, never a word from the page - and a cleared
    // viewport carries none, so the two outcomes are two templates rather than one with a hole.
    return item.outcome === "set"
      ? t("agent.activity.viewportSet").replace("{size}", () => item.message ?? "")
      : t("agent.activity.viewportCleared");
  }
  if (item.kind === "upload") {
    // 013 FR-174: a fourth sentence - a picture the session took, now in the owner's page. The
    // worker sends the delivery the *page* reported, `input` or `drop`, and the two read as two
    // different things: a file handed to a form, and a file dropped on the page. A site the worker
    // could not name leaves no hole in either, the way a restore's missing state does not.
    const sentence =
      item.message === "input" ? t("agent.activity.uploadInput") : t("agent.activity.uploadDrop");
    return sentence.replace("{site}", () => (item.site === undefined ? t("agent.activity.unknownSite") : site(item.site)));
  }
  if (item.kind === "site-plan") {
    // 017 FR-263: one sentence per plan event, from the site count the worker sends; the outcome word
    // (approved, replaced, withdrawn, ended) is the card's, as for every other kind.
    return item.message === "1"
      ? t("agent.activity.sitePlanOne")
      : t("agent.activity.sitePlan").replace("{n}", () => item.message ?? "");
  }
  if (item.kind === "consent") {
    // 032 FR-494, R-488: one sentence for a settled question, put together from the panel's own
    // words: what was asked, the site, and where and how it was answered (or that nobody did).
    const siteText = site(item.site ?? "");
    const question = item.question === undefined ? "" : t(CONSENT_QUESTION_KEYS[item.question]);
    const { answer: given, channel } = item;
    const answer =
      given === undefined || given === "timed-out" || channel === undefined || channel === "none"
        ? t("agent.activity.consentTimedOut")
        : t("agent.activity.consentAnswered")
            .replace("{answer}", () => t(CONSENT_ANSWER_KEYS[given]))
            .replace("{place}", () => t(CONSENT_PLACE_KEYS[channel]));
    return t("agent.activity.consent")
      .replace("{question}", () => question)
      .replace("{site}", () => siteText)
      .replace("{answer}", () => answer);
  }
  if (item.kind === "dialog") {
    return t("agent.activity.dialog")
      .replace("{site}", () => site(item.site ?? ""))
      .replace("{message}", () => item.message ?? "");
  }
  // A kind a newer worker sends and this panel has no sentence for: said plainly, never as a dialog.
  return t("agent.activity.other");
}

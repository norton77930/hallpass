import type { ReactElement } from "react";
import type { AgentBridgeDiagnostics } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";

/**
 * The one page shown while nothing can be done (006 FR-082, D-006-3): what happened, what to do,
 * a retry, and the technical facts folded away.
 *
 * Two copy variants on one layout. `not-paired` is a browser no agent has ever paired with, whatever
 * the link is doing - the owner's next step is to start an agent, not to retry a bridge. `bridge-lost`
 * is a paired browser whose link is down, which is the case the retry and the details are for.
 * `standby` is a host that stood aside because another browser on this computer is serving the
 * agents (two browsers, 2026-10-02): nothing is broken, and the owner's step is to close the other
 * browser - this one takes over on its own.
 */
export type NotConnectedVariant = "not-paired" | "bridge-lost" | "standby";

export function NotConnected(props: {
  variant: NotConnectedVariant;
  diagnostics: AgentBridgeDiagnostics;
  locale: string;
  onRetry: () => void;
}): ReactElement {
  const t = (key: string): string => lookup(key, props.locale);
  // Literal keys per variant, never a built one: the locale contract test scans the panel's
  // sources for `t("agent.…")` literals, and a key it cannot see is a key it cannot check.
  const copy =
    props.variant === "standby"
      ? { title: t("agent.standby.title"), body: t("agent.standby.body") }
      : props.variant === "not-paired"
        ? { title: t("agent.notPaired.title"), body: t("agent.notPaired.body") }
        : { title: t("agent.bridgeLost.title"), body: t("agent.bridgeLost.body") };
  const { relayPid, recordPath, lastDisconnect } = props.diagnostics;
  const known = relayPid !== undefined || recordPath !== undefined || lastDisconnect !== undefined;

  return (
    <section className="agent-page" data-variant={props.variant} aria-labelledby="agent-page-title">
      <h2 id="agent-page-title">{copy.title}</h2>
      <p>{copy.body}</p>
      <button type="button" onClick={props.onRetry}>
        {t("agent.retry")}
      </button>
      {/*
        Collapsed by default: these are the facts the 004 rings keep for a gate, shown so the owner
        can read them out when asking for help, not so they have to read them every time.
      */}
      <details className="agent-details">
        <summary>{t("agent.details.title")}</summary>
        {known ? (
          <ul>
            {relayPid !== undefined ? <li>{t("agent.details.relayPid").replace("{pid}", String(relayPid))}</li> : null}
            {recordPath !== undefined ? <li>{t("agent.details.recordPath").replace("{path}", () => recordPath)}</li> : null}
            {lastDisconnect ? <li>{t("agent.details.lastDisconnect").replace("{at}", lastDisconnect.at)}</li> : null}
            {lastDisconnect?.reason !== undefined ? (
              // Chrome's own sentence about the port; a function replacer, so a dollar sign in it is inert.
              <li>{t("agent.details.lastDisconnectReason").replace("{reason}", () => lastDisconnect.reason ?? "")}</li>
            ) : null}
          </ul>
        ) : (
          <p>{t("agent.details.none")}</p>
        )}
      </details>
    </section>
  );
}

import { useId, type ReactElement } from "react";
import { useSettings } from "../context.js";
import { formatWhen } from "../format.js";

/** `stdio:terminal` and `stdio:editor` are what the pairing records; anything else is "another app". */
function whereFrom(origin: string): "terminal" | "editor" | "other" {
  if (/(^|[:/])terminal$/iu.test(origin)) return "terminal";
  if (/(^|[:/])editor$/iu.test(origin)) return "editor";
  return "other";
}

/** 024 FR-385: the agents that connected from a terminal or editor and were paired, and Unpair. */
export function OutsideAgents(): ReactElement {
  const { state, t, run, notify, locale, now } = useSettings();
  const headingId = useId();
  return (
    <section className="blk" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("settings.outside.title")}</h3>
      <p className="meta">{t("settings.outside.desc")}</p>
      {state.paired.length === 0 ? (
        <p className="empty">{t("settings.outside.none")}</p>
      ) : (
        <ul className="site-list">
          {state.paired.map((agent) => (
            <li key={agent.agentId} className="row-item" data-paired={agent.agentId}>
              <span className="avatar sm" aria-hidden="true">
                {Array.from(agent.displayName)[0] ?? "?"}
              </span>
              <span className="grow">
                <strong>{agent.displayName}</strong>
                <br />
                <span className="meta">
                  {t("settings.outside.last", {
                    where: t(`settings.outside.from.${whereFrom(agent.origin)}`),
                    time: formatWhen(agent.acceptedAt, locale, now()),
                  })}
                </span>
              </span>
              <button
                type="button"
                className="btn quiet"
                aria-label={t("settings.outside.unpairLabel", { name: agent.displayName })}
                onClick={() => {
                  void run({ type: "ui.agent.unpair", payload: { agentId: agent.agentId } }, () =>
                    notify(t("settings.outside.unpaired", { name: agent.displayName })),
                  );
                }}
              >
                {t("settings.outside.unpair")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { Fragment, useId, useState, type ReactElement } from "react";
import type { ConversationAgent } from "@hallpass/contracts";
import { useSettings } from "../context.js";
import { formatClock } from "../format.js";
import { Avatar } from "../parts.js";
import { writeClipboard } from "./clipboard.js";

/** The scrubber's own markers, shown apart so the owner sees where something was taken out. */
const MARKER = /(<(?:redacted|user|hallpass-data)>)/gu;

function Line(props: { text: string }): ReactElement {
  return (
    <>
      {props.text.split(MARKER).map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="red">
            {part}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * 024 FR-387, D-024-17: each agent's last lines, read only when the owner presses Show - one
 * `ui.conversation.diagnostics` for that agent, never on opening the page or the block. The lines come
 * back scrubbed (keys, tokens and user paths removed by the helper) with the time they were read.
 */
export function AgentOutputs(props: { agents: readonly ConversationAgent[] }): ReactElement {
  return (
    <>
      {props.agents.map((agent) => (
        <AgentOutputBlock key={agent} agent={agent} />
      ))}
    </>
  );
}

function AgentOutputBlock(props: { agent: ConversationAgent }): ReactElement {
  const { t, run, notify, output, nameOf, locale } = useSettings();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const bodyId = useId();
  const name = nameOf(props.agent);
  const read = output[props.agent];

  return (
    <section className="diag" aria-labelledby={headingId} data-diag={props.agent}>
      <div className="diag-head">
        <Avatar agent={props.agent} name={name} />
        <div className="grow">
          <h4 id={headingId}>{name}</h4>
          {open && read !== undefined ? <span className="meta">{t("settings.diag.readAt", { time: formatClock(read.readAt, locale) })}</span> : null}
        </div>
        {open && read !== undefined ? (
          <button
            type="button"
            className="btn quiet"
            aria-label={t("settings.diag.copyLabel", { agent: name })}
            onClick={() => {
              void writeClipboard(read.lines.join("\n")).then(
                () => notify(t("settings.toast.copied")),
                () => notify(t("settings.error.generic")),
              );
            }}
          >
            {t("settings.diag.copy")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          aria-describedby={headingId}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            setOpen(true);
            void run({ type: "ui.conversation.diagnostics", payload: { agent: props.agent } }).then((ok) => {
              if (!ok) setOpen(false);
            });
          }}
        >
          {open ? t("settings.diag.hide") : t("settings.diag.show")}
        </button>
      </div>
      {open ? (
        read === undefined ? (
          <p id={bodyId} className="meta diag-wait" role="status">
            {t("settings.diag.reading")}
          </p>
        ) : read.lines.length === 0 ? (
          <p id={bodyId} className="meta diag-wait">
            {t("settings.diag.none")}
          </p>
        ) : (
          <pre id={bodyId} tabIndex={0} role="region" aria-label={name}>
            {read.lines.map((line, index) => (
              <Fragment key={index}>
                {index === 0 ? "" : "\n"}
                <Line text={line} />
              </Fragment>
            ))}
          </pre>
        )
      ) : null}
    </section>
  );
}

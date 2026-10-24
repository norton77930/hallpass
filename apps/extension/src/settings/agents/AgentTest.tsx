import { useEffect, useId, useState, type ReactElement } from "react";
import type { ConversationAgent, ConversationAgentAvailability } from "@hallpass/contracts";
import { describeTest } from "../agent-model.js";
import { useSettings } from "../context.js";
import { formatClock } from "../format.js";
import { Mark } from "../parts.js";

/** How long a press stays "Testing…" without the worker saying so (the test itself is bound to 90 s, R-379). */
const ASKED_FOR_MS = 120_000;

/**
 * 024 FR-381, D-024-10 / T768: Test says beside its button that it makes one model call; while it runs
 * the button says so; the result is the entry's `lastTest`, so it is there whenever the card is opened
 * again and still marked with its own time if the agent's state changed since.
 */
export function AgentTest(props: {
  agent: ConversationAgent;
  entry: ConversationAgentAvailability;
  /** Ready and enabled: the only state a test can start from. */
  available: boolean;
}): ReactElement {
  const { t, locale, run, nameOf } = useSettings();
  const costId = useId();
  const hintId = useId();
  // The press waits for the worker's `testing`; this is the moment between the two.
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const result = props.entry.lastTest;
  const stillAsked = asked !== undefined && (result?.ranAt ?? "none") === asked;
  const running = props.entry.testing === true || stillAsked;

  useEffect(() => {
    if (asked === undefined) return undefined;
    const timer = setTimeout(() => setAsked(undefined), ASKED_FOR_MS);
    return () => clearTimeout(timer);
  }, [asked]);

  const name = nameOf(props.agent);
  const disabled = !props.available || running;
  const reason = !props.available ? t("settings.test.unavailable") : running && props.entry.testing === true && !stillAsked ? t("settings.test.busy") : undefined;
  const line = result === undefined ? undefined : describeTest(result, t);

  return (
    <>
      <div className="test-ask">
        <span id={costId} className="meta">
          {t("settings.test.cost")}
        </span>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          title={reason}
          aria-label={t("settings.test.label", { agent: name })}
          aria-describedby={reason === undefined ? costId : `${costId} ${hintId}`}
          data-fid={`test-${props.agent}`}
          onClick={() => {
            setAsked(result?.ranAt ?? "none");
            void run({ type: "ui.conversation.test", payload: { agent: props.agent } }).then((ok) => {
              if (!ok) setAsked(undefined);
            });
          }}
        >
          {running ? (
            <>
              <span className="spin" aria-hidden="true" />
              {t("settings.test.running")}
            </>
          ) : result === undefined ? (
            t("settings.test.button")
          ) : (
            t("settings.test.again")
          )}
        </button>
        {reason === undefined ? null : (
          <span id={hintId} className="sr-only">
            {reason}
          </span>
        )}
      </div>
      {running ? (
        <p className="test-line" role="status">
          <span className="spin" aria-hidden="true" />
          {t("settings.test.running")}
        </p>
      ) : result === undefined || line === undefined ? null : (
        <p className="test-line" role="status" data-test-outcome={result.outcome}>
          <Mark kind={result.outcome === "passed" ? "ok" : result.outcome === "partial" ? "warn" : "bad"} />
          <span>
            {t(line.key, line.vars)}
            {line.kind === "partial" ? ` ${t("settings.test.partialHint")}` : ""}{" "}
            <span className="meta">{t("settings.test.lastTest", { time: formatClock(result.ranAt, locale) })}</span>
          </span>
        </p>
      )}
    </>
  );
}

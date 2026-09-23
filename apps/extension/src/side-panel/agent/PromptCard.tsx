import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../../locales/catalog.js";
import { TOOL_SUMMARY_KEYS, UPLOAD_DELIVERY_SUMMARY_KEYS } from "../agent-panel-keys.js";
import type { SendCommand } from "./AgentShell.js";

/**
 * The one pending question, on top of whatever else is on screen (006 FR-084, FR-085, D-006-6).
 *
 * Three cards share this place and at most one is shown: the pairing request, the `ask` consent,
 * and the plan a batch states under `follow-a-plan`. They are shown in arrival order (FR-085): the
 * worker dates each question, and the earliest is on top until it is answered. A projection with
 * no dates - a 004 worker - falls back to pairing first, then the consent, then the plan. The
 * card is a non-modal dialog: the page under it stays readable, because the owner may need the
 * site list to decide.
 */

/** Which of the three questions is on top: the earliest dated one, undated ones in fixed order. */
export function questionOnTop(state: Pick<AgentPanelState, "pending" | "prompt" | "plan">): "pairing" | "consent" | "plan" | undefined {
  const candidates: Array<{ kind: "pairing" | "consent" | "plan"; at: string | undefined }> = [];
  if (state.pending) candidates.push({ kind: "pairing", at: state.pending.requestedAt });
  if (state.prompt) candidates.push({ kind: "consent", at: state.prompt.raisedAt });
  if (state.plan) candidates.push({ kind: "plan", at: state.plan.raisedAt });
  const stamp = (at: string | undefined): number => {
    const parsed = at === undefined ? Number.NaN : Date.parse(at);
    // An undated question sorts first, which is the fixed precedence for a projection with none.
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  // A stable sort: two questions with the same stamp keep the fixed order above.
  return candidates.sort((left, right) => stamp(left.at) - stamp(right.at))[0]?.kind;
}
/** How long a notice stays up on its own before the panel takes it away (FR-114). */
export const NOTICE_AUTO_HIDE_MS = 8000;

/**
 * The one thing the panel says without asking anything (008 FR-114, US3 scenario 5).
 *
 * A chained accept cost the owner no decision - they approved the click a second ago - but it is
 * still something that happened to their page, so it is *told*. Everything about this card is the
 * opposite of the consent card above: it is not a `dialog` role and takes no focus, it carries no
 * choice, and it goes away on its own. Which is what "non-blocking" has to mean if the owner is
 * ever to trust a card that does block.
 */
export function NoticeCard(props: {
  notice: NonNullable<AgentPanelState["sessions"][number]["notice"]>;
  locale: string;
}): ReactElement | null {
  const t = (key: string): string => lookup(key, props.locale);
  // Keyed by the notice's own stamp, so a second notice re-shows after the first was dismissed.
  const [dismissed, setDismissed] = useState<number | undefined>(undefined);
  const [expired, setExpired] = useState<number | undefined>(undefined);
  const at = props.notice.at;
  useEffect(() => {
    const timer = setTimeout(() => setExpired(at), NOTICE_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [at]);
  if (dismissed === at || expired === at) return null;
  return (
    <section className="agent-notice" role="status" aria-live="polite">
      <p>{t("agent.notice.dialogAccepted")}</p>
      {/* The page's own words, quoted rather than woven into the sentence. */}
      <blockquote className="agent-prompt-quote">
        {t("agent.prompt.dialogQuote").replace("{text}", () => props.notice.dialogText)}
      </blockquote>
      <p>
        {t("agent.notice.dialogFollows").replace("{action}", () => t(TOOL_SUMMARY_KEYS[props.notice.action]))}
      </p>
      <div className="agent-prompt-actions">
        <button type="button" onClick={() => setDismissed(at)}>
          {t("agent.notice.dismiss")}
        </button>
      </div>
    </section>
  );
}

export function PromptCard(props: {
  state: AgentPanelState;
  locale: string;
  /** The name of the agent the consent is about: the waiting session's, or the paired agent's. */
  promptAgent: string;
  send: SendCommand;
}): ReactElement | null {
  const t = (key: string): string => lookup(key, props.locale);
  const { pending, prompt, plan } = props.state;
  /**
   * The steps of the plan on screen that the owner has struck out, by position. Panel-local because
   * striking a step out is not a decision until Approve is pressed, and keyed by the plan so a
   * second plan never inherits the exclusions of the one before it.
   */
  const [excluded, setExcluded] = useState<{ planId: string; steps: number[] }>({ planId: "", steps: [] });
  const onTop = questionOnTop(props.state);

  /**
   * R-130: when a question arrives, focus lands on its first control, so a keyboard owner answers
   * it without hunting for it. Keyed on which question is on top - a second question of the same
   * kind (another prompt id) moves focus again; a re-render of the same one does not.
   */
  const cardRef = useRef<HTMLElement | null>(null);
  const questionId =
    onTop === "pairing" ? pending?.agentId : onTop === "consent" ? prompt?.promptId : onTop === "plan" ? plan?.planId : undefined;
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>("button, input, select")?.focus();
  }, [onTop, questionId]);

  if (pending && onTop === "pairing") {
    const accept = (): void => {
      props.send({ type: "ui.agent.pair-decide", payload: { agentId: pending.agentId, accepted: true } });
    };
    // FR-084: ignore is not a decline. The request is left to expire at the host, never answered no.
    const ignore = (): void => {
      props.send({ type: "ui.agent.pair-ignore", payload: { agentId: pending.agentId } });
    };
    return (
      <section ref={cardRef} role="dialog" aria-modal="false" aria-labelledby="agent-prompt-title" className="agent-prompt" data-prompt="pairing">
        <h2 id="agent-prompt-title">{t("agent.pairingTitle")}</h2>
        {/* The agent's own stated name and origin, as inert text - it is remote input. */}
        <p>{t("agent.pairingBody").replace("{agent}", () => pending.displayName)}</p>
        <p>{t("agent.pairingOrigin").replace("{origin}", () => pending.origin)}</p>
        {/* FR-035: the one sentence that says the agent may forward what it reads onward. */}
        <p>{t("agent.forwardingDisclosure")}</p>
        <div className="agent-prompt-actions">
          <button type="button" className="agent-primary" onClick={accept}>
            {t("agent.accept")}
          </button>
          <button type="button" onClick={ignore}>
            {t("agent.ignore")}
          </button>
        </div>
      </section>
    );
  }

  /**
   * 014 FR-187, FR-188: the tab moved, and the next call on it is waiting on this.
   *
   * Its own card rather than a variant of the consent one below, because what is decided is not
   * the same thing: the consent card asks whether an *action* may happen, and this asks whether
   * the session may keep working where the *browser* has taken it - a question the tool's own
   * sentence would hide entirely. It is the same `dialog` with the same focus handling, so a
   * keyboard owner answers it exactly as they answer the other two.
   */
  if (prompt && onTop === "consent" && prompt.kind === "transition" && prompt.transition) {
    const moved = prompt.transition;
    const answer = (allow: boolean, remember = false): void => {
      props.send({
        type: "ui.agent.effect-decide",
        payload: {
          promptId: prompt.promptId,
          allow,
          // Only with a yes (FR-188): "always" is part of allowing this move, never of refusing it.
          ...(allow && remember ? { rememberTransition: true } : {}),
        },
      });
    };
    return (
      <section
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="agent-prompt-title"
        className="agent-prompt"
        data-prompt="transition"
      >
        <h2 id="agent-prompt-title">{t("agent.promptTitle")}</h2>
        {/* Both origins, as inert text: they are the question, and neither is a page's own word. */}
        <p>
          {t("agent.prompt.transition")
            .replace("{from}", () => moved.from)
            .replace("{to}", () => moved.to)}
        </p>
        <div className="agent-prompt-actions">
          <button type="button" className="agent-primary" onClick={() => answer(true)}>
            {t("agent.transitionContinue")}
          </button>
          <button type="button" onClick={() => answer(true, true)}>
            {t("agent.transitionAlways")}
          </button>
          <button type="button" onClick={() => answer(false)}>
            {t("agent.transitionDecline")}
          </button>
        </div>
      </section>
    );
  }

  /**
   * 014 FR-193, FR-194: a file outside the directories the owner allowed.
   *
   * The one card whose body is the owner's *own* data, shown in full and on purpose: a card saying
   * "a file outside your directories" is a card about nothing in particular, and a path they cannot
   * read is a decision they cannot make. Those paths are on this screen and nowhere else - the page
   * is never told a file name, and neither is the agent.
   *
   * Three answers again, and again not the same three: this call's files, their directories from
   * now on, and no. The middle one is the only thing in this product that widens what the local
   * host may read, which is why it is a button of its own rather than a checkbox beside a yes.
   */
  if (prompt && onTop === "consent" && prompt.kind === "upload-directory" && prompt.files) {
    const files = prompt.files;
    const answer = (allow: boolean, remember = false): void => {
      props.send({
        type: "ui.agent.effect-decide",
        payload: {
          promptId: prompt.promptId,
          allow,
          // Only with a yes: a refusal that carried "from now on" would be the owner saying no to
          // these files and yes to every file beside them.
          ...(allow && remember ? { rememberDirectory: true } : {}),
        },
      });
    };
    return (
      <section
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="agent-prompt-title"
        className="agent-prompt"
        data-prompt="upload-directory"
      >
        <h2 id="agent-prompt-title">{t("agent.promptTitle")}</h2>
        <p>{t("agent.prompt.uploadDirectory").replace("{agent}", () => props.promptAgent)}</p>
        {/* Inert text, each on its own line: a path is not a link and not something to interpret. */}
        <ul className="agent-prompt-files">
          {files.map((file) => (
            <li key={file.path} data-upload-file={file.path}>
              {file.path}
              {/* S3 review F7: the folder "these directories from now on" would remember, named under
                  the path rather than left for the owner to derive - the one they press about. */}
              <span className="agent-prompt-file-directory" data-upload-directory={file.directory}>
                {t("agent.uploadFileDirectory").replace("{directory}", () => file.directory)}
              </span>
            </li>
          ))}
        </ul>
        <div className="agent-prompt-actions">
          <button type="button" className="agent-primary" onClick={() => answer(true)}>
            {t("agent.uploadOnce")}
          </button>
          <button type="button" onClick={() => answer(true, true)}>
            {t("agent.uploadAlways")}
          </button>
          <button type="button" onClick={() => answer(false)}>
            {t("agent.uploadDecline")}
          </button>
        </div>
      </section>
    );
  }

  if (prompt && onTop === "consent") {
    const answer = (allow: boolean, always = false): void => {
      props.send({
        type: "ui.agent.effect-decide",
        payload: {
          promptId: prompt.promptId,
          allow,
          // "Always on this site" is an allow that also sets the site's mode (FR-085); it never
          // travels with a refusal, which would be saying no to one thing and yes to everything else.
          ...(allow && always ? { rememberMode: "skip-checks" as const } : {}),
        },
      });
    };
    return (
      <section ref={cardRef} role="dialog" aria-modal="false" aria-labelledby="agent-prompt-title" className="agent-prompt" data-prompt="consent">
        <h2 id="agent-prompt-title">{t("agent.promptTitle")}</h2>
        {/*
          What the call would do, in reviewed copy for the owner's locale (003/T068): the tool is a
          closed contract value, so the sentence comes from the same tables as everything else here.
          The worker's own English summary stays in the projection as its record of what was asked.
        */}
        {/*
          008 FR-114, FR-115: two of these questions are not about an element at all, and the
          tool's own sentence would hide what is being decided. `kind` is what the worker says
          about that, and the panel picks the sentence - never the worker's English.
        */}
        <p>
          {prompt.kind === "dialog-accept"
            ? t("agent.prompt.dialogAccept").replace("{agent}", () => props.promptAgent)
            : prompt.kind === "beforeunload-force"
              ? t("agent.prompt.beforeunloadForce").replace("{site}", () => prompt.site)
              : t("agent.consentBody")
                  .replace("{agent}", () => props.promptAgent)
                  .replace(
                    "{action}",
                    () =>
                      // 014 FR-196: the delivery when the question names one, the tool's own
                      // sentence when it does not. Still a key rather than the worker's English.
                      t(
                        prompt.delivery === undefined
                          ? TOOL_SUMMARY_KEYS[prompt.tool]
                          : UPLOAD_DELIVERY_SUMMARY_KEYS[prompt.delivery],
                      ),
                  )
                  .replace("{site}", () => prompt.site)}
        </p>
        {/*
          The page's own words, quoted (D-008-5): the one page-authored string this panel shows,
          because an owner cannot decide about a question they are not allowed to read. Rendered as
          text inside a quotation, so nothing the page wrote is ever part of the panel's sentence.
        */}
        {prompt.dialogText === undefined ? null : (
          <blockquote className="agent-prompt-quote">
            {t("agent.prompt.dialogQuote").replace("{text}", () => prompt.dialogText ?? "")}
          </blockquote>
        )}
        {prompt.targetLabel ? (
          <p>
            {t("agent.promptTarget")
              .replace("{role}", () => prompt.targetRole ?? "")
              .replace("{label}", () => prompt.targetLabel ?? "")}
          </p>
        ) : null}
        {/*
          004/T139a (FR-069): a position effect has no label, so the projection carries a picture of
          the place. The bytes are the worker's own PNG, never page markup.
        */}
        {prompt.targetCrop ? (
          <img
            src={`data:${prompt.targetCrop.mimeType};base64,${prompt.targetCrop.data}`}
            alt={t("agent.promptCropAlt")}
            width={prompt.targetCrop.width}
            height={prompt.targetCrop.height}
          />
        ) : null}
        <div className="agent-prompt-actions">
          <button type="button" className="agent-primary" onClick={() => answer(true)}>
            {t("agent.allowOnce")}
          </button>
          <button type="button" onClick={() => answer(true, true)}>
            {t("agent.allowAlways")}
          </button>
          <button type="button" onClick={() => answer(false)}>
            {t("agent.refuse")}
          </button>
        </div>
      </section>
    );
  }

  if (plan && onTop === "plan") {
    const excludedSteps = excluded.planId === plan.planId ? excluded.steps : [];
    const answer = (approve: boolean): void => {
      const struck = [...excludedSteps].sort((a, b) => a - b);
      props.send({
        type: "ui.agent.plan-decide",
        payload: {
          planId: plan.planId,
          approve,
          // Only with an approval: a refusal runs nothing, so which steps were struck out is not
          // part of that answer.
          ...(approve && struck.length > 0 ? { excludedIndexes: struck } : {}),
        },
      });
      setExcluded({ planId: "", steps: [] });
    };
    return (
      <section ref={cardRef} role="dialog" aria-modal="false" aria-labelledby="agent-prompt-title" className="agent-prompt" data-prompt="plan">
        <h2 id="agent-prompt-title">{t("agent.planTitle")}</h2>
        <p>{t("agent.planSite").replace("{site}", () => plan.site)}</p>
        <ol>
          {plan.steps.map((step, index) => (
            <li key={`${plan.planId}-${index}`}>
              <span>{t(TOOL_SUMMARY_KEYS[step.tool])}</span>
              <label>
                <input
                  type="checkbox"
                  checked={excludedSteps.includes(index)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...excludedSteps, index]
                      : excludedSteps.filter((position) => position !== index);
                    setExcluded({ planId: plan.planId, steps: next });
                  }}
                />
                {t("agent.planExclude").replace("{step}", String(index + 1))}
              </label>
            </li>
          ))}
        </ol>
        <div className="agent-prompt-actions">
          <button type="button" className="agent-primary" onClick={() => answer(true)}>
            {t("agent.approvePlan")}
          </button>
          <button type="button" onClick={() => answer(false)}>
            {t("agent.denyPlan")}
          </button>
        </div>
      </section>
    );
  }

  return null;
}

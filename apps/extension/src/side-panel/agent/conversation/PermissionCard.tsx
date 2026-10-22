import { useId, type ReactElement } from "react";
import { CONVERSATION_OWNER_ANSWERS, CONVERSATION_RULE_KINDS, type ConversationEvent } from "@hallpass/contracts";
import { actionWords } from "./action-words.js";

type PermissionEvent = Extract<ConversationEvent, { type: "permission" }>;
export type OwnerAnswer = (typeof CONVERSATION_OWNER_ANSWERS)[number];

/**
 * 019 T572: the answers a card offers. "Allow for this conversation" only where the broker can keep
 * a rule for the action (`permissionRuleKey`, R-317: the kinds in `CONVERSATION_RULE_KINDS`, `other`
 * included - its rule is keyed by the tool's name or title); for any other kind it would act as
 * allow-once, so it is not offered.
 *
 * 021 FR-353, D-021-10: a `rejectOnly` card - nobody described the action - offers Reject alone.
 *
 * T668: an `other` card with no title (DeepSeek announces every action so) has no name to key a rule
 * by - the broker keeps none, so "for this conversation" is not offered there either.
 */
export function permissionAnswers(kind: PermissionEvent["kind"], rejectOnly = false, title?: string): readonly OwnerAnswer[] {
  if (rejectOnly) return ["reject"];
  const ruled = (CONVERSATION_RULE_KINDS as readonly string[]).includes(kind) && !unnamedOther(kind, title);
  // T606 (C5): the card's order - allow once, allow for this conversation, reject.
  const ordered = [...CONVERSATION_OWNER_ANSWERS].sort((a, b) => ANSWER_ORDER.indexOf(a) - ANSWER_ORDER.indexOf(b));
  return ruled ? ordered : ordered.filter((answer) => answer !== "allow-conversation");
}

const ANSWER_ORDER: readonly OwnerAnswer[] = ["allow-once", "allow-conversation", "reject"];

/** T668: an `other` action without a title - nothing names the tool. */
const unnamedOther = (kind: PermissionEvent["kind"], title: string | undefined): boolean =>
  kind === "other" && title !== undefined && title.trim() === "";

/** T606 (C5): a detail that only repeats the title ("table.csv" under "Write table.csv") is not shown. */
const detailAdds = (title: string, detail: string): boolean => {
  const words = detail.trim();
  return words !== "" && !title.includes(words);
};

/**
 * 019 FR-290, FR-291, FR-294, US2 scenario 2: the agent asks before a change; the card names the
 * action and offers the contract's answers (without "for this conversation" where the broker keeps
 * no rule, `permissionAnswers`). It has no timer - the agent
 * waits until the owner answers - and it leaves when the broker says the request closed, which is
 * how a card answered in another panel document leaves this one too (FR-288).
 */
export function PermissionCard(props: {
  permission: PermissionEvent;
  agentName: string;
  t: (key: string) => string;
  onAnswer: (answer: OwnerAnswer) => void;
}): ReactElement {
  const { t, permission } = props;
  const titleId = useId();
  // A blank title would leave the heading ending in a colon: it names the action by its detail's first line.
  const words = actionWords(permission.title, t, permission.detail);
  return (
    <section role="group" aria-labelledby={titleId} className="agent-conversation-permission">
      <h3 id={titleId}>
        {t("conversation.permission.title")
          .replace("{agent}", () => props.agentName)
          .replace("{title}", () => words)}
      </h3>
      {!detailAdds(words, permission.detail) ? null : <pre className="agent-conversation-permission-detail">{permission.detail}</pre>}
      {permission.rejectOnly === true ? (
        <p>{t("conversation.permission.rejectOnly")}</p>
      ) : unnamedOther(permission.kind, permission.title) ? (
        <p>{t("conversation.permission.onceOnly")}</p>
      ) : null}
      <p>{t("conversation.permission.waiting")}</p>
      <div className="agent-prompt-actions">
        {permissionAnswers(permission.kind, permission.rejectOnly === true, permission.title).map((answer) => (
          // T605: allowing once is the answer the card leads with, filled in the accent.
          <button
            key={answer}
            type="button"
            className={answer === "allow-once" ? "agent-primary" : undefined}
            onClick={() => props.onAnswer(answer)}
          >
            {t(`conversation.permission.${answer}`)}
          </button>
        ))}
      </div>
    </section>
  );
}

import { useId, type ReactElement } from "react";
import { CONVERSATION_OWNER_ANSWERS, CONVERSATION_RULE_KINDS, type ConversationEvent } from "@hallpass/contracts";

type PermissionEvent = Extract<ConversationEvent, { type: "permission" }>;
export type OwnerAnswer = (typeof CONVERSATION_OWNER_ANSWERS)[number];

/**
 * 019 T572: the answers a card offers. "Allow for this conversation" only where the broker can keep
 * a rule for the action (`permissionRuleKey`, R-317: the kinds in `CONVERSATION_RULE_KINDS`, `other`
 * included - its rule is keyed by the tool's name or title); for any other kind it would act as
 * allow-once, so it is not offered.
 */
export function permissionAnswers(kind: PermissionEvent["kind"]): readonly OwnerAnswer[] {
  const ruled = (CONVERSATION_RULE_KINDS as readonly string[]).includes(kind);
  return ruled ? CONVERSATION_OWNER_ANSWERS : CONVERSATION_OWNER_ANSWERS.filter((answer) => answer !== "allow-conversation");
}

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
  return (
    <section role="group" aria-labelledby={titleId} className="agent-conversation-permission">
      <h3 id={titleId}>
        {t("conversation.permission.title")
          .replace("{agent}", () => props.agentName)
          .replace("{title}", () => permission.title)}
      </h3>
      {permission.detail === "" ? null : <pre className="agent-conversation-permission-detail">{permission.detail}</pre>}
      <p>{t("conversation.permission.waiting")}</p>
      <div className="agent-prompt-actions">
        {permissionAnswers(permission.kind).map((answer) => (
          <button key={answer} type="button" onClick={() => props.onAnswer(answer)}>
            {t(`conversation.permission.${answer}`)}
          </button>
        ))}
      </div>
    </section>
  );
}

import type { ReactElement } from "react";
import type { ConversationFolder, ConversationMode } from "@hallpass/contracts";

/**
 * 019 FR-286, US1 scenario 1, US5: the agent, the folder and the mode, on screen for as long as
 * the conversation is. The folder never changes (FR-303), so it is shown, never offered as a
 * choice; a project path is the owner's own and is shown as inert text.
 */
export function ConversationHeader(props: {
  agentName: string;
  folder: ConversationFolder;
  mode: ConversationMode;
  t: (key: string) => string;
}): ReactElement {
  const { t } = props;
  return (
    <section className="agent-conversation-header" aria-label={t("conversation.header.label")}>
      <dl>
        <div>
          <dt>{t("conversation.header.agent")}</dt>
          <dd>{props.agentName}</dd>
        </div>
        <div>
          <dt>{t("conversation.header.folder")}</dt>
          <dd className="agent-conversation-folder">
            {props.folder.kind === "scratch" ? t("conversation.folder.scratch") : props.folder.path}
          </dd>
        </div>
        <div>
          <dt>{t("conversation.header.mode")}</dt>
          <dd>{t(`conversation.mode.${props.mode}`)}</dd>
        </div>
      </dl>
    </section>
  );
}

import { useEffect, useId, useState, type FormEvent, type ReactElement } from "react";
import type {
  ConversationAgent,
  ConversationError,
  ConversationFolder,
  ConversationFolderEntry,
} from "@hallpass/contracts";
import type { SendCommand } from "../AgentShell.js";

/**
 * 019 US5, FR-303, T563: where a new conversation works - the scratch folder unless the owner picks
 * one of their own - and the owner's folder list.
 *
 * A conversation's folder never changes, so this only ever feeds a *new* conversation: choosing a
 * folder and pressing Start sends `ui.conversation.start { agent, folder }`. Adding a folder asks the
 * broker to open its folder dialog (no path); where the dialog cannot open on this desktop the broker
 * answers `path-entry`, and only then is a typed path offered - which the broker checks exactly like
 * a chosen one, so nothing is decided here. The field stays until a folder is added, so a path the
 * broker refuses (it is not a folder, it is gone) can be corrected without starting over; the reason
 * itself is the tab's error notice.
 *
 * Paths are the owner's own and are shown as inert text.
 */

type T = (key: string) => string;

export function FolderPicker(props: {
  folders: readonly ConversationFolderEntry[];
  /** The folder a new conversation would start in; the scratch folder unless the owner chose one. */
  selected: ConversationFolder;
  agents: readonly { agent: ConversationAgent; name: string }[];
  /** The last command's failure, when it is fresh: `path-entry` turns the typed field on. */
  error?: ConversationError;
  t: T;
  send: SendCommand;
  onSelect: (folder: ConversationFolder) => void;
  onStart: (agent: ConversationAgent, folder: ConversationFolder) => void;
}): ReactElement {
  const { t, send } = props;
  const name = useId();
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const errorCode = props.error?.code;
  const noError = props.error === undefined;
  useEffect(() => {
    // The dialog cannot open here: from now on a typed path is the way, until a folder is added
    // (the next success clears the failure and so ends it).
    if (errorCode === "path-entry") setTyping(true);
    else if (noError) {
      setTyping(false);
      setPath("");
    }
  }, [errorCode, noError]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const typed = path.trim();
    if (typed === "") return;
    send({ type: "ui.conversation.add-folder", payload: { path: typed } });
  };
  const isScratch = props.selected.kind === "scratch";

  return (
    <section className="agent-conversation-folders" aria-label={t("conversation.folders.label")}>
      <div role="radiogroup" aria-label={t("conversation.folders.label")} className="agent-conversation-folder-choices">
        <label>
          <input
            type="radio"
            name={name}
            checked={isScratch}
            onChange={() => props.onSelect({ kind: "scratch" })}
          />
          <span>{t("conversation.folders.scratch")}</span>
        </label>
        {props.folders.map((folder) => (
          <div key={folder.path} className="agent-conversation-folder-row">
            <label>
              <input
                type="radio"
                name={name}
                checked={props.selected.kind === "project" && props.selected.path === folder.path}
                onChange={() => props.onSelect({ kind: "project", path: folder.path })}
              />
              <span className="agent-conversation-folder">{folder.path}</span>
            </label>
            <button
              type="button"
              aria-label={t("conversation.folders.remove").replace("{path}", () => folder.path)}
              onClick={() => send({ type: "ui.conversation.remove-folder", payload: { path: folder.path } })}
            >
              {t("conversation.list.removeShort")}
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => send({ type: "ui.conversation.add-folder", payload: {} })}>
        {t("conversation.folders.add")}
      </button>
      {typing ? (
        <form className="agent-conversation-folder-path" onSubmit={submit}>
          <label>
            {t("conversation.folders.pathLabel")}
            <input
              type="text"
              value={path}
              maxLength={1024}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <button type="submit" disabled={path.trim() === ""}>
            {t("conversation.folders.addTyped")}
          </button>
        </form>
      ) : null}
      <div role="group" aria-label={t("conversation.folders.startLabel")} className="agent-conversation-agents">
        {props.agents.map((agent) => (
          <button
            key={agent.agent}
            type="button"
            className="agent-primary"
            onClick={() => props.onStart(agent.agent, props.selected)}
          >
            {t("conversation.folders.start").replace("{agent}", () => agent.name)}
          </button>
        ))}
      </div>
    </section>
  );
}

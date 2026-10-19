import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import {
  CONVERSATION_AGENTS,
  CONVERSATION_ERROR_CODES,
  CONVERSATION_MESSAGE_MAX_CHARS,
  type ConversationAgent,
  type ConversationError,
  type ConversationFolder,
  type ConversationPanelState,
  type ConversationView,
} from "@hallpass/contracts";
import { lookup } from "../../../locales/catalog.js";
import type { SendCommand } from "../AgentShell.js";
import { ConversationHeader } from "./ConversationHeader.js";
import { pictureOf, type ConversationLogs } from "./conversation-log.js";
import { ConversationList } from "./ConversationList.js";
import { AgentProblemCard, FirstUseCard, InstallProgress } from "./FirstUseCard.js";
import { FolderPicker } from "./FolderPicker.js";
import { MessageList } from "./MessageList.js";
import { ModeSwitch } from "./ModeSwitch.js";
import { PermissionCard } from "./PermissionCard.js";

type T = (key: string) => string;

const SCRATCH: ConversationFolder = { kind: "scratch" };

/**
 * 019 S5 (T546, T548): the Conversation tab - US1, US2, US3, FR-285 - FR-294, FR-299 - FR-301.
 *
 * Like the rest of the panel it holds no authority: what is on screen is the worker's `conversation`
 * projection plus the events it forwarded (kept in memory by the shell, D-019-6), and every press
 * leaves as one `ui.conversation.*` command. The only things it remembers itself are which agent
 * the owner is setting up, whether an install it asked for is under way, and (T563) whether they are
 * browsing the list / choosing a folder for a new conversation instead of looking at the open one -
 * view state, never a decision.
 */
export function ConversationTab(props: {
  conversation: ConversationPanelState;
  logs: ConversationLogs;
  locale: string;
  send: SendCommand;
  /**
   * The tab the owner is looking at (R-321), when the shell knows it; the message goes without one
   * otherwise and the worker picks the start tab (S6).
   */
  activeTabId?: number;
  /** The last command's failure, when the worker reports one to the panel (T547). */
  lastError?: ConversationError;
}): ReactElement {
  const t: T = (key) => lookup(key, props.locale);
  const { conversation, send } = props;
  const [chosen, setChosen] = useState<ConversationAgent | undefined>(undefined);
  const [installing, setInstalling] = useState<ConversationAgent | undefined>(undefined);
  /** An error the owner already acted on (Download, Retry), so an older failure does not reappear. */
  const [handledError, setHandledError] = useState<ConversationError | undefined>(undefined);
  /** T563: the list / folder chooser shown over the open conversation (which stays open behind it). */
  const [browsing, setBrowsing] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  /** The folder a new conversation would start in, as the owner last picked it (FR-303). */
  const [pickedFolder, setPickedFolder] = useState<ConversationFolder>(SCRATCH);
  /** The folder the owner asked for along with the agent they are setting up (scratch for the agent buttons). */
  const [chosenFolder, setChosenFolder] = useState<ConversationFolder>(SCRATCH);
  /**
   * T576: the conversation the owner asked for when they pressed Download. It starts once, when the
   * install they began finishes with the agent ready; Cancel (or a new press) drops it.
   */
  const pendingStart = useRef<{ agent: ConversationAgent; folder: ConversationFolder } | undefined>(undefined);

  const availabilityOf = (agent: ConversationAgent) => conversation.agents.find((entry) => entry.agent === agent);
  const agentName = (agent: ConversationAgent): string => t(`conversation.agent.${agent}`);
  const installingReady = installing !== undefined && availabilityOf(installing)?.availability === "ready";
  useEffect(() => {
    // The connector arrived: the install is over and the agent is offered as ready.
    if (!installingReady) return;
    setInstalling(undefined);
    const wanted = pendingStart.current;
    pendingStart.current = undefined;
    if (wanted !== undefined) send({ type: "ui.conversation.start", payload: wanted });
  }, [installingReady, send]);

  useEffect(() => {
    // Another conversation opened or started: that is what the owner wants to see now.
    setBrowsing(false);
  }, [conversation.active]);

  if (!conversation.available) {
    return (
      <section className="agent-page agent-conversation" data-conversation="unavailable">
        <p>{t(`conversation.unavailable.${conversation.reason ?? "broker-unavailable"}`)}</p>
      </section>
    );
  }

  const freshError = props.lastError !== undefined && props.lastError !== handledError ? props.lastError : undefined;
  const view =
    conversation.active === undefined
      ? undefined
      : conversation.conversations.find((entry) => entry.conversationId === conversation.active);
  if (view !== undefined && !browsing) {
    return (
      <OpenConversation
        view={view}
        onBrowse={() => setBrowsing(true)}
        onNewInFolder={() => {
          setFoldersOpen(true);
          setBrowsing(true);
        }}
        logs={props.logs}
        agentName={agentName(view.agent)}
        t={t}
        send={send}
        {...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId })}
        {...(freshError === undefined ? {} : { error: freshError })}
      />
    );
  }

  const consented = conversation.consent === "granted";
  const install = (agent: ConversationAgent, startIn: ConversationFolder): void => {
    // FR-299: the consent goes first, and only on the owner's press; the install follows it.
    pendingStart.current = { agent, folder: startIn };
    setHandledError(props.lastError);
    setInstalling(agent);
    setChosen(undefined);
    if (!consented) send({ type: "ui.conversation.consent", payload: { granted: true } });
    send({ type: "ui.conversation.install", payload: { agent } });
  };

  if (installing !== undefined && !installingReady) {
    // Any refusal of the install ends the wait (not only `install-failed`): consent-needed,
    // broker-unavailable after a relay restart, agent-missing... The broker's redacted detail says why.
    const failure = freshError?.detail;
    return (
      <InstallProgress
        // T547 (G2): the phase the broker names; "preparing" until it has named one.
        phase={availabilityOf(installing)?.installing ?? "preparing"}
        size={t(`conversation.size.${installing}`)}
        t={t}
        {...(failure === undefined ? {} : { failure })}
        onRetry={() => install(installing, pendingStart.current?.folder ?? SCRATCH)}
        onCancel={() => {
          pendingStart.current = undefined;
          setHandledError(props.lastError);
          setInstalling(undefined);
        }}
      />
    );
  }

  const chosenAvailability = chosen === undefined ? undefined : availabilityOf(chosen);
  if (chosen !== undefined && chosenAvailability !== undefined) {
    const { availability } = chosenAvailability;
    if (availability === "missing" || availability === "version-problem") {
      return (
        <AgentProblemCard agent={chosenAvailability} agentName={agentName(chosen)} t={t} onBack={() => setChosen(undefined)} />
      );
    }
    if (availability === "needs-install" || !consented) {
      return (
        <FirstUseCard
          agentName={agentName(chosen)}
          {...(availability === "needs-install" ? { size: t(`conversation.size.${chosen}`) } : {})}
          t={t}
          onAccept={() => {
            if (availability === "needs-install") {
              install(chosen, chosenFolder);
            } else {
              send({ type: "ui.conversation.consent", payload: { granted: true } });
              setChosen(undefined);
            }
          }}
          onCancel={() => setChosen(undefined)}
        />
      );
    }
  }

  const pick = (agent: ConversationAgent, startIn: ConversationFolder = SCRATCH): void => {
    if (availabilityOf(agent)?.availability === "ready" && consented) {
      // US5 scenario 1: a new conversation works in its own scratch folder unless the owner chose one.
      send({ type: "ui.conversation.start", payload: { agent, folder: startIn } });
      return;
    }
    setChosenFolder(startIn);
    setChosen(agent);
  };
  // A folder the owner removed from the list is no longer a choice; the scratch folder is.
  const folder =
    pickedFolder.kind === "project" && !conversation.folders.some((entry) => entry.path === pickedFolder.path)
      ? SCRATCH
      : pickedFolder;

  return (
    <section className="agent-page agent-conversation-picker">
      <h2>{t("conversation.picker.title")}</h2>
      <p>{t("conversation.picker.body")}</p>
      {view === undefined ? null : (
        <div className="agent-prompt-actions">
          <button type="button" onClick={() => setBrowsing(false)}>
            {t("conversation.back")}
          </button>
        </div>
      )}
      {freshError === undefined ? null : <ErrorNotice error={freshError} t={t} />}
      <div role="group" aria-label={t("conversation.picker.agentsLabel")} className="agent-conversation-agents">
        {CONVERSATION_AGENTS.map((agent) => {
          const availability = availabilityOf(agent)?.availability;
          return (
            <button key={agent} type="button" disabled={availability === undefined} onClick={() => pick(agent)}>
              <span className="agent-conversation-agent-name">{agentName(agent)}</span>
              {availability === undefined ? null : (
                <span className="agent-conversation-availability"> · {t(`conversation.availability.${availability}`)}</span>
              )}
            </button>
          );
        })}
      </div>
      {foldersOpen ? (
        <FolderPicker
          folders={conversation.folders}
          selected={folder}
          agents={CONVERSATION_AGENTS.filter((agent) => availabilityOf(agent) !== undefined).map((agent) => ({
            agent,
            name: agentName(agent),
          }))}
          {...(freshError === undefined ? {} : { error: freshError })}
          t={t}
          send={send}
          onSelect={setPickedFolder}
          onStart={pick}
        />
      ) : null}
      <ConversationList
        conversations={conversation.conversations}
        {...(conversation.notice === undefined ? {} : { notice: conversation.notice })}
        locale={props.locale}
        t={t}
        agentName={agentName}
        foldersOpen={foldersOpen}
        onNewInFolder={() => setFoldersOpen((open) => !open)}
        onOpen={(conversationId) => {
          // The open one is already there: going back to it needs no command (nothing replays).
          if (conversationId === conversation.active) setBrowsing(false);
          else send({ type: "ui.conversation.open", payload: { conversationId } });
        }}
        onRemove={(conversationId) => send({ type: "ui.conversation.remove", payload: { conversationId } })}
      />
    </section>
  );
}

/** A command's failure, in the panel's words, with the broker's redacted detail (R-326). */
function ErrorNotice(props: { error: ConversationError; t: T }): ReactElement {
  const known = (CONVERSATION_ERROR_CODES as readonly string[]).includes(props.error.code);
  return (
    <div className="agent-conversation-notice" role="status" data-notice-code={props.error.code}>
      {known ? <p>{props.t(`conversation.error.${props.error.code}`)}</p> : null}
      <p className="agent-conversation-detail">{props.error.detail}</p>
    </div>
  );
}

/** The states in which a turn is under way, so Stop is offered and a new message waits (FR-285). */
const BUSY_STATES = new Set(["starting", "running", "waiting-for-owner"]);
/** The states worth a sentence under the messages; `idle` says nothing. */
const SPOKEN_STATES = new Set(["starting", "running", "waiting-for-owner", "stopped", "crashed", "gone"]);

function OpenConversation(props: {
  view: ConversationView;
  logs: ConversationLogs;
  agentName: string;
  t: T;
  send: SendCommand;
  activeTabId?: number;
  error?: ConversationError;
  /** T563: show the list over this conversation, or the folder chooser for a new one. */
  onBrowse: () => void;
  onNewInFolder: () => void;
}): ReactElement {
  const { t, view, send } = props;
  const conversationId = view.conversationId;
  const [draft, setDraft] = useState("");
  const picture = pictureOf(props.logs[conversationId] ?? []);
  const mode = picture.mode ?? view.mode;
  const state = picture.state ?? view.state;
  const busy = BUSY_STATES.has(state);
  const sendable = draft.trim() !== "" && state !== "running" && state !== "waiting-for-owner";

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!sendable) return;
    send({
      type: "ui.conversation.send",
      payload: {
        conversationId,
        text: draft,
        ...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId }),
      },
    });
    setDraft("");
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter is a new line - the usual chat keys.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <section className="agent-conversation" data-conversation-id={conversationId}>
      <div className="agent-prompt-actions">
        <button type="button" onClick={props.onBrowse}>
          {t("conversation.list.show")}
        </button>
        <button type="button" onClick={props.onNewInFolder}>
          {t("conversation.list.newInFolder")}
        </button>
      </div>
      <ConversationHeader agentName={props.agentName} folder={view.folder} mode={mode} t={t} />
      <ModeSwitch
        agent={view.agent}
        mode={mode}
        t={t}
        onChange={(next) => send({ type: "ui.conversation.set-mode", payload: { conversationId, mode: next } })}
      />
      {/* The broker's own words about the mode it set, if it had any (inert text). */}
      {picture.modeNote === undefined ? null : <p className="agent-conversation-detail">{picture.modeNote}</p>}
      {props.error === undefined ? null : <ErrorNotice error={props.error} t={t} />}
      <MessageList timeline={picture.timeline} agentName={props.agentName} t={t} />
      {SPOKEN_STATES.has(state) ? (
        <p className="agent-conversation-state" aria-live="polite">
          {t(`conversation.state.${state}`)}
        </p>
      ) : null}
      {picture.permissions.map((permission) => (
        <PermissionCard
          key={permission.requestId}
          permission={permission}
          agentName={props.agentName}
          t={t}
          onAnswer={(answer) =>
            send({ type: "ui.conversation.answer", payload: { conversationId, requestId: permission.requestId, answer } })
          }
        />
      ))}
      <form className="agent-conversation-composer" onSubmit={submit}>
        <textarea
          aria-label={t("conversation.composer.label").replace("{agent}", () => props.agentName)}
          value={draft}
          maxLength={CONVERSATION_MESSAGE_MAX_CHARS}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKey}
        />
        <div className="agent-prompt-actions">
          <button type="submit" className="agent-primary" disabled={!sendable}>
            {t("conversation.composer.send")}
          </button>
          {busy ? (
            <button type="button" onClick={() => send({ type: "ui.conversation.stop", payload: { conversationId } })}>
              {t("conversation.stop")}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

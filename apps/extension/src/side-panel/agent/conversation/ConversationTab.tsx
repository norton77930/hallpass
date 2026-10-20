import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  CONVERSATION_ERROR_CODES,
  type ConversationAgent,
  type ConversationError,
  type ConversationFolder,
  type ConversationMode,
  type ConversationPanelState,
  type ConversationView,
} from "@hallpass/contracts";
import { lookup } from "../../../locales/catalog.js";
import type { SendCommand } from "../AgentShell.js";
import { AgentMenu } from "./AgentMenu.js";
import { Chip, Composer, FixedChip } from "./Composer.js";
import { ConversationDrawer, ConversationListNotice } from "./ConversationDrawer.js";
import { ConversationHeader } from "./ConversationHeader.js";
import { pictureOf, type ConversationLogs } from "./conversation-log.js";
import { AgentProblemCard, FirstUseCard, InstallProgress } from "./FirstUseCard.js";
import { FolderPicker } from "./FolderPicker.js";
import { errorDetailWords, notAFolderPath } from "./broker-words.js";
import { folderName } from "./folder-name.js";
import { PassIcon } from "./icons.js";
import { defaultAgent, useLastAgent } from "./last-agent.js";
import { MessageList } from "./MessageList.js";
import { ModeMenu } from "./ModeMenu.js";
import { PermissionCard } from "./PermissionCard.js";

type T = (key: string) => string;

const SCRATCH: ConversationFolder = { kind: "scratch" };

/**
 * The owner's first message for a conversation that is not open yet (020 FR-314). It is held - the
 * words stay in the box - until the conversation opens, then sent once. `known` is the list of
 * conversations at the moment the start left, so the one that opens afterwards is recognised as the
 * new one and never confused with an entry the owner opened from the list meanwhile.
 */
type HeldMessage = {
  text: string;
  mode: ConversationMode;
  known?: ReadonlySet<string>;
  /**
   * T606 (A2): held for a first use (the card, a download, the consent): the words leave the box and
   * are shown as a faded bubble instead, and come back to the box if the start is dropped.
   */
  bubble?: boolean;
};

/**
 * T606 (C1): the broker's title for a conversation that has no message yet (its `NEW_TITLE`). The
 * broker replaces it with words from the first message; until it does, the panel shows that message.
 */
const BROKER_NEW_TITLE = "New conversation";

/** T606 (P2, P3): the one press a refusal offers, when one helps. */
type NoticeAction = { label: string; onPress: () => void };

/**
 * 019 S5 (T546, T548), 020 S2 (T587 - T590): the Conversation tab - 019 US1 - US3, FR-285 - FR-294,
 * FR-299 - FR-301; 020 US1, FR-312 - FR-315.
 *
 * Like the rest of the panel it holds no authority: what is on screen is the worker's `conversation`
 * projection plus the events it forwarded (kept in memory by the shell, D-019-6), and every press
 * leaves as one `ui.conversation.*` command. With no conversation open it is an empty conversation
 * (D-020-1): the message box, focused, with the agent, folder and mode chips under it. What it
 * remembers itself is view state - the chips, a held first message, an install it asked for, whether
 * the drawer of conversations (FR-321) or a new conversation is shown over the open one - never a decision.
 *
 * Start, then send (FR-314): Send asks for `ui.conversation.start { agent, folder }` and holds the
 * words; once the projection names a newly opened conversation as active, a non-strict mode chip
 * choice goes as `ui.conversation.set-mode` and the words as `ui.conversation.send`. When the agent
 * still needs the one-time consent or its connector, the first-use card comes first; its one press
 * sends the consent (and the install), and the start waits until the projection reports the agent
 * ready and the consent given (T576).
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
  /** T606 (P2): shows the Connections & sites tab, where the helper's connection is checked. */
  onGoConnections?: () => void;
}): ReactElement {
  const t: T = (key) => lookup(key, props.locale);
  const { conversation, send } = props;
  const [lastAgent, rememberAgent] = useLastAgent();
  /** The agent the owner put on the chip; until then the FR-313 default. */
  const [ownerAgent, setOwnerAgent] = useState<ConversationAgent | undefined>(undefined);
  const [installing, setInstalling] = useState<ConversationAgent | undefined>(undefined);
  /** An error the owner already acted on (Download, Retry, Send), so an older failure does not reappear. */
  const [handledError, setHandledError] = useState<ConversationError | undefined>(undefined);
  /** 020 FR-321 (T598): the drawer of conversations, over whatever is shown (which stays behind it). */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Where the focus goes once the drawer has closed: the list button, or the message box after a choice. */
  const focusAfterDrawer = useRef<"list" | "box" | undefined>(undefined);
  const listButton = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drawerId = useId();
  /** FR-315: a new conversation being written while another is open. */
  const [composing, setComposing] = useState(false);
  /** The folder a new conversation would start in, as the owner last picked it (FR-303). */
  const [pickedFolder, setPickedFolder] = useState<ConversationFolder>(SCRATCH);
  const [newMode, setNewMode] = useState<ConversationMode>("strict");
  const [draft, setDraft] = useState("");
  /** FR-314: the first-use card is up, holding the message. */
  const [asking, setAsking] = useState(false);
  const [held, setHeld] = useState<HeldMessage | undefined>(undefined);
  /**
   * T576: the conversation the owner asked for on the first-use card. It starts once, when the agent
   * is ready and the consent given; Cancel (or a refusal) drops it.
   */
  const [pendingStart, setPendingStart] = useState<{ agent: ConversationAgent; folder: ConversationFolder } | undefined>(undefined);

  const availabilityOf = (agent: ConversationAgent) => conversation.agents.find((entry) => entry.agent === agent);
  const agentName = (agent: ConversationAgent): string => t(`conversation.agent.${agent}`);
  const consented = conversation.consent === "granted";
  const freshError = props.lastError !== undefined && props.lastError !== handledError ? props.lastError : undefined;

  const start = (agent: ConversationAgent, folder: ConversationFolder): void => {
    setHandledError(props.lastError);
    rememberAgent(agent);
    const known = new Set(conversation.conversations.map((entry) => entry.conversationId));
    setHeld((message) => (message === undefined ? undefined : { ...message, known }));
    send({ type: "ui.conversation.start", payload: { agent, folder } });
  };

  const installingReady = installing !== undefined && availabilityOf(installing)?.availability === "ready";
  useEffect(() => {
    // The connector arrived: the install is over and the agent is offered as ready.
    if (installingReady) setInstalling(undefined);
  }, [installingReady]);

  const startable = pendingStart !== undefined && availabilityOf(pendingStart.agent)?.availability === "ready" && consented;
  useEffect(() => {
    if (!startable || pendingStart === undefined) return;
    setPendingStart(undefined);
    start(pendingStart.agent, pendingStart.folder);
    // `start` reads this render's projection, which is the one that made the start possible.
  }, [startable, pendingStart]);

  const opened = conversation.active;
  const openedListed = opened !== undefined && conversation.conversations.some((entry) => entry.conversationId === opened);
  useEffect(() => {
    // The started conversation is open: its first message goes, once (FR-314).
    if (held?.known === undefined || opened === undefined || !openedListed || held.known.has(opened)) return;
    setHeld(undefined);
    setDraft("");
    if (held.mode !== "strict") {
      send({ type: "ui.conversation.set-mode", payload: { conversationId: opened, mode: held.mode } });
    }
    send({
      type: "ui.conversation.send",
      payload: {
        conversationId: opened,
        text: held.text,
        ...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId }),
      },
    });
  }, [held, opened, openedListed]);

  useEffect(() => {
    // A refused start or consent gives the words back; an install's refusal is the install view's,
    // and while the first-use card is up nothing has left yet.
    if (freshError === undefined || installing !== undefined || asking || held === undefined) return;
    giveBack();
    setPendingStart(undefined);
  }, [freshError, installing, asking, held]);

  /** The held words were not sent: they go back into the box (T606 A2) and the hold ends. */
  function giveBack(): void {
    if (held !== undefined) setDraft(held.text);
    setHeld(undefined);
  }

  const closeDrawer = (focus: "list" | "box"): void => {
    focusAfterDrawer.current = focus;
    setDrawerOpen(false);
  };

  useEffect(() => {
    // After the drawer left (and the view behind it is no longer inert), the focus goes where the
    // owner expects it (US5 scenario 1).
    if (drawerOpen || focusAfterDrawer.current === undefined) return;
    const target = focusAfterDrawer.current;
    focusAfterDrawer.current = undefined;
    if (target === "list") listButton.current?.focus();
    else frame.current?.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")?.focus();
  }, [drawerOpen]);

  useEffect(() => {
    // Another conversation opened or started: that is what the owner wants to see now.
    setComposing(false);
    if (drawerOpen) closeDrawer("box");
  }, [conversation.active]);

  const goConnections: NoticeAction | undefined =
    props.onGoConnections === undefined ? undefined : { label: t("conversation.error.goConnections"), onPress: props.onGoConnections };

  if (!conversation.available) {
    const reason = conversation.reason ?? "broker-unavailable";
    return (
      <section className="agent-page agent-conversation" data-conversation="unavailable">
        <p>{t(`conversation.unavailable.${reason}`)}</p>
        {reason === "broker-unavailable" && goConnections !== undefined ? <NoticeButton action={goConnections} /> : null}
      </section>
    );
  }

  /** T606 (P2, P3): what a refusal offers - the way to the connection, or the list to stop one from. */
  const errorAction = (error: ConversationError | undefined): NoticeAction | undefined =>
    error?.code === "broker-unavailable"
      ? goConnections
      : error?.code === "too-many-running"
        ? { label: t("conversation.error.openList"), onPress: () => setDrawerOpen(true) }
        : undefined;
  const actionFor = (error: ConversationError | undefined) => {
    const action = errorAction(error);
    return action === undefined ? {} : { errorAction: action };
  };

  const onChoose = (conversationId: string): void => {
    closeDrawer("box");
    // The open one is already there: going back to it needs no command (nothing replays).
    if (conversationId === conversation.active) setComposing(false);
    else {
      // T610: the worker shows the chosen one at once; a refusal on the one left does not follow it.
      setHandledError(props.lastError);
      send({ type: "ui.conversation.open", payload: { conversationId } });
    }
  };
  const header = {
    t,
    listRef: listButton,
    drawerOpen,
    drawerId,
    onList: () => (drawerOpen ? closeDrawer("list") : setDrawerOpen(true)),
  };
  const withDrawer = (shown: ReactElement): ReactElement => (
    <div ref={frame} className="agent-conversation-frame">
      {shown}
      {drawerOpen ? (
        <ConversationDrawer
          id={drawerId}
          conversations={conversation.conversations}
          {...(conversation.notice === undefined ? {} : { notice: conversation.notice })}
          locale={props.locale}
          t={t}
          agentName={agentName}
          current={composing ? undefined : conversation.active}
          onChoose={onChoose}
          onRemove={(conversationId) => send({ type: "ui.conversation.remove", payload: { conversationId } })}
          onClose={() => closeDrawer("list")}
        />
      ) : null}
    </div>
  );

  const view =
    conversation.active === undefined
      ? undefined
      : conversation.conversations.find((entry) => entry.conversationId === conversation.active);
  if (view !== undefined && !composing) {
    return withDrawer(
      <OpenConversation
        // T610: one per conversation, so an unsent draft and an open menu stay with the one they were made in.
        key={view.conversationId}
        view={view}
        header={{ ...header, onNew: () => setComposing(true) }}
        logs={props.logs}
        agentName={agentName(view.agent)}
        t={t}
        send={send}
        {...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId })}
        {...(freshError === undefined ? {} : { error: freshError })}
        {...actionFor(freshError)}
        // P1: same command as the drawer's Remove.
        onRemove={() => send({ type: "ui.conversation.remove", payload: { conversationId: view.conversationId } })}
      />,
    );
  }

  // A folder the owner removed from the list is no longer a choice; the scratch folder is.
  const folder =
    pickedFolder.kind === "project" && !conversation.folders.some((entry) => entry.path === pickedFolder.path)
      ? SCRATCH
      : pickedFolder;
  const agent = ownerAgent ?? defaultAgent(lastAgent, conversation.agents);

  const install = (target: ConversationAgent, startIn: ConversationFolder): void => {
    // FR-299: the consent goes first, and only on the owner's press; the install follows it.
    setPendingStart({ agent: target, folder: startIn });
    setHandledError(props.lastError);
    setInstalling(target);
    if (!consented) send({ type: "ui.conversation.consent", payload: { granted: true } });
    send({ type: "ui.conversation.install", payload: { agent: target } });
  };

  // T606 (A1): the new-conversation button is always there; here it only puts the focus in the box.
  const focusBox = (): void => frame.current?.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")?.focus();
  return withDrawer(
    <NewConversation
      header={view === undefined ? { ...header, onNew: focusBox } : { ...header, onNew: focusBox, onBack: () => setComposing(false) }}
      notice={<ConversationListNotice {...(conversation.notice === undefined ? {} : { notice: conversation.notice })} t={t} />}
      t={t}
      agent={agent}
      agentName={agentName}
      agents={conversation.agents}
      folder={folder}
      folders={conversation.folders}
      mode={newMode}
      lastUsed={lastAgent}
      draft={draft}
      held={held !== undefined}
      {...(held?.bubble === true ? { heldWords: held.text } : {})}
      asking={asking}
      installing={installing}
      {...(installing === undefined ? {} : { installPhase: availabilityOf(installing)?.installing ?? "preparing" })}
      {...(freshError === undefined ? {} : { error: freshError })}
      {...actionFor(freshError)}
      send={send}
      onAgent={setOwnerAgent}
      onFolder={setPickedFolder}
      onMode={setNewMode}
      onDraft={setDraft}
      onSend={() => {
        setHandledError(props.lastError);
        if (availabilityOf(agent)?.availability === "ready" && consented) {
          setHeld({ text: draft, mode: newMode });
          start(agent, folder);
        } else {
          // FR-314: the first-use card first. T606 (A2): the words wait as a faded bubble, the box empty.
          setHeld({ text: draft, mode: newMode, bubble: true });
          setDraft("");
          setAsking(true);
        }
      }}
      onAccept={() => {
        setAsking(false);
        if (availabilityOf(agent)?.availability === "needs-install") {
          install(agent, folder);
        } else {
          setHandledError(props.lastError);
          setPendingStart({ agent, folder });
          send({ type: "ui.conversation.consent", payload: { granted: true } });
        }
      }}
      onCancel={() => {
        setAsking(false);
        giveBack();
      }}
      onRetry={() => installing !== undefined && install(installing, pendingStart?.folder ?? folder)}
      onCancelInstall={() => {
        setPendingStart(undefined);
        setHandledError(props.lastError);
        setInstalling(undefined);
        giveBack();
      }}
    />,
  );
}

/** What the tab hands each view for its header: the list button and the drawer it opens. */
type HeaderControls = Omit<Parameters<typeof ConversationHeader>[0], "details">;

/**
 * 020 FR-312 - FR-314: the empty conversation - message box first, chips under it; the earlier
 * conversations are one press away in the header's drawer (FR-321). Anything that must be read
 * before the words can go sits above the box. T605: the box is pinned at the bottom here too, under
 * a welcome whose suggestions only fill it.
 */
function NewConversation(props: {
  /** The list button (and Back, while another conversation is open behind this one). */
  header: HeaderControls;
  /** Why the list may look short, if it may (non-blocking). */
  notice: ReactElement;
  t: T;
  agent: ConversationAgent;
  agentName: (agent: ConversationAgent) => string;
  agents: ConversationPanelState["agents"];
  folder: ConversationFolder;
  folders: ConversationPanelState["folders"];
  mode: ConversationMode;
  /** T606 (C8): the agent the panel remembers using last. */
  lastUsed?: ConversationAgent | undefined;
  draft: string;
  /** The words are held for a start under way (or a card's answer). */
  held: boolean;
  /** T606 (A2): the words held for a first use, shown as a faded bubble while the box is empty. */
  heldWords?: string;
  asking: boolean;
  installing: ConversationAgent | undefined;
  installPhase?: NonNullable<ConversationPanelState["agents"][number]["installing"]>;
  error?: ConversationError;
  errorAction?: NoticeAction;
  send: SendCommand;
  onAgent:(agent: ConversationAgent) => void;
  onFolder: (folder: ConversationFolder) => void;
  onMode: (mode: ConversationMode) => void;
  onDraft: (text: string) => void;
  onSend: () => void;
  onAccept: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onCancelInstall: () => void;
}): ReactElement {
  const { t, agent } = props;
  const [opened, setOpened] = useState<"agent" | "folder" | "mode" | undefined>(undefined);
  const section = useRef<HTMLElement>(null);
  const agentChip = useRef<HTMLButtonElement>(null);
  const modeChip = useRef<HTMLButtonElement>(null);
  const ids = { agent: useId(), folder: useId(), mode: useId() };
  const name = props.agentName(agent);
  const entry = props.agents.find((candidate) => candidate.agent === agent);
  const availability = entry?.availability;
  // A not-installed agent, or one whose version does not fit, cannot be sent to (FR-301, FR-313).
  const reachable = availability === "ready" || availability === "needs-install";
  const holding = props.held || props.asking || props.installing !== undefined;
  const sendable = props.draft.trim() !== "" && reachable;
  const toggle = (which: "agent" | "folder" | "mode") => setOpened((current) => (current === which ? undefined : which));
  const closeAgentMenu = (): void => {
    setOpened(undefined);
    agentChip.current?.focus();
  };
  // T607 (A1): a project folder is its name; the whole path is the hover (and the chooser's row).
  const folderText = props.folder.kind === "scratch" ? t("conversation.folder.scratch") : folderName(props.folder.path);
  const folderPath = props.folder.kind === "project" ? props.folder.path : undefined;

  let above: ReactElement | null = null;
  if (props.installing !== undefined) {
    // Any refusal of the install ends the wait (not only `install-failed`): consent-needed,
    // broker-unavailable after a relay restart, agent-missing... The broker's redacted detail says why.
    const failure = props.error?.detail;
    above = (
      <InstallProgress
        // T547 (G2): the phase the broker names; "preparing" until it has named one.
        phase={props.installPhase ?? "preparing"}
        size={t(`conversation.size.${props.installing}`)}
        t={t}
        {...(failure === undefined ? {} : { failure })}
        onRetry={props.onRetry}
        onCancel={props.onCancelInstall}
      />
    );
  } else if (props.asking) {
    above = (
      <FirstUseCard
        agentName={name}
        {...(availability === "needs-install" ? { size: t(`conversation.size.${agent}`) } : {})}
        t={t}
        onAccept={props.onAccept}
        onCancel={props.onCancel}
      />
    );
  } else if (entry !== undefined && !reachable) {
    above = <AgentProblemCard agent={entry} agentName={name} t={t} />;
  } else if (props.held) {
    above = (
      <p className="agent-conversation-state" aria-live="polite">
        {t("conversation.state.starting")}
      </p>
    );
  }

  const suggest = (text: string): void => {
    // T605: a suggestion only fills the box - nothing leaves the panel until the owner sends.
    props.onDraft(text);
    section.current?.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")?.focus();
  };

  return (
    <section ref={section} className="agent-page agent-conversation-new" data-conversation="new" inert={props.header.drawerOpen}>
      <ConversationHeader
        {...props.header}
        details={{ title: t("conversation.new"), agentName: name, folder: folderText, ...(folderPath === undefined ? {} : { folderPath }) }}
      />
      {props.notice}
      {props.error === undefined || props.installing !== undefined ? null : (
        <ErrorNotice error={props.error} t={t} {...(props.errorAction === undefined ? {} : { action: props.errorAction })} />
      )}
      {props.heldWords === undefined ? (
        <Welcome t={t} {...(holding ? {} : { onSuggest: suggest })} />
      ) : (
        // T606 (A2): the words wait where the conversation will be, faded until they are sent.
        <div className="agent-conversation-held">
          <div className="agent-conversation-message" data-message-role="owner" data-held="">
            <span className="agent-conversation-who agent-sr-only">{t("conversation.role.owner")}</span>
            <p>{props.heldWords}</p>
          </div>
          {props.asking ? <p className="agent-conversation-held-hint">{t("conversation.held.hint")}</p> : null}
        </div>
      )}
      <Composer
        t={t}
        label={t("conversation.composer.label").replace("{agent}", () => name)}
        draft={props.draft}
        onDraft={props.onDraft}
        sendable={sendable}
        readOnly={holding}
        autoFocus
        onSend={props.onSend}
        above={above}
        chips={
          <>
            <Chip
              kind="agent"
              ref={agentChip}
              label={t("conversation.chip.agent").replace("{agent}", () => name)}
              text={name}
              popup="menu"
              expanded={opened === "agent"}
              controls={ids.agent}
              disabled={holding}
              onToggle={() => toggle("agent")}
            />
            <Chip
              kind="folder"
              label={t("conversation.chip.folder").replace("{folder}", () => folderText)}
              {...(folderPath === undefined ? {} : { title: t("conversation.chip.folder").replace("{folder}", () => folderPath) })}
              text={folderText}
              expanded={opened === "folder"}
              controls={ids.folder}
              disabled={holding}
              onToggle={() => toggle("folder")}
            />
            <Chip
              kind="mode"
              ref={modeChip}
              label={t("conversation.chip.mode").replace("{mode}", () => t(`conversation.mode.${props.mode}`))}
              text={t(`conversation.mode.${props.mode}`)}
              short={t(`conversation.mode.short.${props.mode}`)}
              expanded={opened === "mode"}
              controls={ids.mode}
              warn={props.mode !== "strict"}
              disabled={holding}
              onToggle={() => toggle("mode")}
            />
          </>
        }
        popup={
          opened === "agent" && !holding ? (
            <AgentMenu
              id={ids.agent}
              agents={props.agents}
              selected={agent}
              lastUsed={props.lastUsed}
              agentName={props.agentName}
              t={t}
              onChoose={(next) => {
                props.onAgent(next);
                closeAgentMenu();
              }}
              onClose={closeAgentMenu}
              onDismiss={() => setOpened(undefined)}
            />
          ) : opened === "folder" && !holding ? (
            <FolderPicker
              id={ids.folder}
              folders={props.folders}
              selected={props.folder}
              {...(props.error === undefined ? {} : { error: props.error })}
              t={t}
              send={props.send}
              onSelect={props.onFolder}
            />
          ) : opened === "mode" && !holding ? (
            <ModeMenu
              id={ids.mode}
              agent={agent}
              mode={props.mode}
              t={t}
              onChange={props.onMode}
              onClose={() => {
                setOpened(undefined);
                modeChip.current?.focus();
              }}
              onDismiss={() => setOpened(undefined)}
            />
          ) : null
        }
      />
    </section>
  );
}

/**
 * T605: the middle of the empty conversation - a short welcome and two suggestions. A suggestion
 * only puts its words in the message box (`onSuggest`); while words are held for a start there are
 * no suggestions to press.
 */
function Welcome(props: { t: T; onSuggest?: (text: string) => void }): ReactElement {
  const { t, onSuggest } = props;
  const titleId = useId();
  const suggestions = [t("conversation.suggest.summarise"), t("conversation.suggest.csv")];
  return (
    <section className="agent-conversation-welcome" aria-labelledby={titleId}>
      <span className="agent-conversation-welcome-mark">
        <PassIcon />
      </span>
      <h2 id={titleId}>{t("conversation.welcome.title")}</h2>
      <p className="agent-conversation-welcome-lead">{t("conversation.welcome.lead")}</p>
      {onSuggest === undefined ? null : (
        <div role="group" aria-label={t("conversation.suggest.label")} className="agent-conversation-suggestions">
          {suggestions.map((text) => (
            <button key={text} type="button" onClick={() => onSuggest(text)}>
              {text}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A command's failure, in the panel's words, with the broker's redacted detail (R-326), and the one
 * press that helps, when one does (T606 P2, P3).
 */
function ErrorNotice(props: { error: ConversationError; t: T; action?: NoticeAction }): ReactElement {
  const known = (CONVERSATION_ERROR_CODES as readonly string[]).includes(props.error.code);
  const { code, detail } = props.error;
  // T608 (J5, J6): two refusals of the folder chooser are said whole in the panel's words. The
  // dialog that cannot open is its title alone (the broker's sentence only repeats it in English);
  // a typed path that is no folder names that path, not the conversation's own folder.
  const typed = code === "folder-missing" ? notAFolderPath(detail) : undefined;
  // T609: every other template of the broker's is said from the locale, or left out when it only repeats the title.
  const said = code === "path-entry" ? undefined : errorDetailWords(detail, props.t);
  return (
    <div className="agent-conversation-notice" role="status" data-notice-code={code}>
      {typed !== undefined ? (
        <p>{props.t("conversation.folders.notFound").replace("{path}", () => typed)}</p>
      ) : (
        <>
          {known ? <p>{props.t(`conversation.error.${code}`)}</p> : null}
          {said === undefined ? null : <p className="agent-conversation-detail">{said}</p>}
        </>
      )}
      {props.action === undefined ? null : <NoticeButton action={props.action} />}
    </div>
  );
}

function NoticeButton(props: { action: NoticeAction }): ReactElement {
  return (
    <button type="button" className="agent-conversation-notice-action" onClick={props.action.onPress}>
      {props.action.label}
    </button>
  );
}

/** T606 (C1): one line of the owner's words - whitespace and line breaks collapsed. */
const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** The states in which a turn is under way, so Stop is offered and a new message waits (FR-285). */
const BUSY_STATES = new Set(["starting", "running", "waiting-for-owner"]);
/** The states worth a sentence under the messages; `idle` says nothing. */
const SPOKEN_STATES = new Set(["starting", "running", "waiting-for-owner", "stopped", "crashed", "gone"]);
/**
 * T605: states the screen already shows - the live line while the turn runs, the card while one
 * waits - so their sentence is said to a screen reader and not drawn a second time.
 */
const QUIET_STATES = new Set(["running", "waiting-for-owner"]);

function OpenConversation(props: {
  view: ConversationView;
  logs: ConversationLogs;
  agentName: string;
  t: T;
  send: SendCommand;
  activeTabId?: number;
  error?: ConversationError;
  errorAction?: NoticeAction;
  /** FR-321: the list button and the new-conversation button (FR-315). */
  header: HeaderControls;
  /** T606 (P1): takes this conversation off the list (the drawer's Remove). */
  onRemove: () => void;
}): ReactElement {
  const { t, view, send } = props;
  const endedId = useId();
  const conversationId = view.conversationId;
  const [draft, setDraft] = useState("");
  const [modeOpen, setModeOpen] = useState(false);
  const modeChip = useRef<HTMLButtonElement>(null);
  const modeMenuId = useId();
  const picture = pictureOf(props.logs[conversationId] ?? []);
  const mode = picture.mode ?? view.mode;
  const state = picture.state ?? view.state;
  const busy = BUSY_STATES.has(state);
  const waiting = picture.permissions.length > 0;
  // T606 (P1): the agent cleared its record of this conversation; it can be looked at, not continued.
  const ended = !view.resumable;
  // T607 (K1): the crash notice in the log already says it; the line under the log does not repeat it.
  const crashSaid = picture.timeline.some((item) => item.kind === "notice" && item.notice.code === "agent-exited");
  const sendable = draft.trim() !== "" && !waiting && !ended && state !== "running" && state !== "waiting-for-owner";
  const fixedNote = t("conversation.chip.fixed");
  const firstOwner = picture.timeline.find((item) => item.kind === "text" && item.role === "owner");
  // T606 (C1): until the broker names the conversation, its first message does (or "New conversation").
  const title =
    view.title !== BROKER_NEW_TITLE
      ? view.title
      : firstOwner?.kind === "text" && oneLine(firstOwner.text) !== ""
        ? oneLine(firstOwner.text)
        : t("conversation.new");

  const submit = (): void => {
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

  return (
    <section className="agent-conversation" data-conversation-id={conversationId} inert={props.header.drawerOpen}>
      <ConversationHeader
        {...props.header}
        details={{
          title,
          agentName: props.agentName,
          folder: view.folder.kind === "scratch" ? t("conversation.folder.scratch") : folderName(view.folder.path),
          ...(view.folder.kind === "project" ? { folderPath: view.folder.path } : {}),
        }}
      />
      {/* The broker's own words about the mode it set, if it had any (inert text). */}
      {picture.modeNote === undefined ? null : <p className="agent-conversation-detail">{picture.modeNote}</p>}
      {props.error === undefined ? null : (
        <ErrorNotice error={props.error} t={t} {...(props.errorAction === undefined ? {} : { action: props.errorAction })} />
      )}
      {/* Keyed by conversation: another one opened shows its own end (T602). */}
      {ended && picture.timeline.length === 0 ? null : (
        <MessageList
          key={conversationId}
          timeline={picture.timeline}
          agentName={props.agentName}
          t={t}
          state={state}
          // T606 (C3): the live line says what waits for the owner.
          waitingFor={picture.permissions[0]?.title}
        />
      )}
      {ended ? (
        <section className="agent-conversation-ended" aria-labelledby={endedId} data-alone={picture.timeline.length === 0 ? "" : undefined}>
          <p id={endedId}>{t("conversation.cannotResume.body")}</p>
          <div className="agent-prompt-actions">
            {props.header.onNew === undefined ? null : (
              <button type="button" className="agent-primary" onClick={props.header.onNew}>
                {t("conversation.new")}
              </button>
            )}
            <button type="button" onClick={props.onRemove}>
              {t("conversation.cannotResume.remove")}
            </button>
          </div>
        </section>
      ) : null}
      {SPOKEN_STATES.has(state) && !ended && !(state === "crashed" && crashSaid) ? (
        <p className={QUIET_STATES.has(state) ? "agent-conversation-state agent-sr-only" : "agent-conversation-state"} aria-live="polite">
          {t(`conversation.state.${state}`)}
        </p>
      ) : null}
      <Composer
        t={t}
        label={t("conversation.composer.label").replace("{agent}", () => props.agentName)}
        draft={draft}
        onDraft={setDraft}
        sendable={sendable}
        onSend={submit}
        {...(ended ? { disabled: true, placeholder: t("conversation.cannotResume.placeholder") } : {})}
        // A conversation chosen in the drawer opens ready to type (US5 scenario 1).
        autoFocus={!ended}
        busy={busy}
        // 020 FR-319, SC-144: a waiting card sits directly above the box, which stays in view while
        // the log scrolls; while one waits the box sends nothing and offers Stop only.
        waiting={waiting}
        above={picture.permissions.map((permission) => (
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
        onStop={() => send({ type: "ui.conversation.stop", payload: { conversationId } })}
        chips={
          // FR-315: fixed for this conversation; another agent or folder is a new conversation.
          <>
            <FixedChip kind="agent" label={t("conversation.header.agent")} text={props.agentName} note={fixedNote} />
            <FixedChip
              kind="folder"
              label={t("conversation.header.folder")}
              text={view.folder.kind === "scratch" ? t("conversation.folder.scratch") : folderName(view.folder.path)}
              {...(view.folder.kind === "project" ? { full: view.folder.path } : {})}
              note={fixedNote}
            />
            {/* FR-292, FR-320: the mode stays switchable, from its chip. */}
            <Chip
              kind="mode"
              ref={modeChip}
              label={t("conversation.chip.mode").replace("{mode}", () => t(`conversation.mode.${mode}`))}
              text={t(`conversation.mode.${mode}`)}
              short={t(`conversation.mode.short.${mode}`)}
              expanded={modeOpen}
              controls={modeMenuId}
              warn={mode !== "strict"}
              disabled={ended}
              onToggle={() => setModeOpen((open) => !open)}
            />
          </>
        }
        popup={
          modeOpen ? (
            <ModeMenu
              id={modeMenuId}
              agent={view.agent}
              mode={mode}
              t={t}
              onChange={(next) => send({ type: "ui.conversation.set-mode", payload: { conversationId, mode: next } })}
              onClose={() => {
                setModeOpen(false);
                modeChip.current?.focus();
              }}
              onDismiss={() => setModeOpen(false)}
            />
          ) : null
        }
        below={
          !modeOpen && view.agent === "codex" && mode === "strict" ? (
            // FR-293: a disclosure stays on screen; with the menu open it sits under the strict choice.
            <p className="agent-conversation-note">{t("conversation.mode.codexStrictNote")}</p>
          ) : null
        }
      />
    </section>
  );
}

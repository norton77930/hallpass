import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  CONVERSATION_ERROR_CODES,
  CONVERSATION_MODE_FIXED_AGENTS,
  type ConversationAccepts,
  type ConversationAttachmentSummary,
  type ConversationAgent,
  type ConversationError,
  type ConversationFolder,
  type ConversationMode,
  type ConversationModelWant,
  type ConversationPanelState,
  type ConversationView,
} from "@hallpass/contracts";
import { lookup } from "../../../locales/catalog.js";
import type { CaptureTab, RequestCommand, SendCommand } from "../AgentShell.js";
import { actionWords } from "./action-words.js";
import { AgentMenu } from "./AgentMenu.js";
import { AttachMenu } from "./attachments/AttachMenu.js";
import { AttachRefusal, ComposerAttachments, SentAttachments } from "./attachments/AttachmentChips.js";
import {
  addCapture,
  addFiles,
  NEW_DRAFT_KEY,
  pruneDrafts,
  removeAttachment,
  useComposerMemory,
  type ComposerMemory,
  type DraftStore,
} from "./attachments/drafts.js";
import {
  acceptsImages,
  draftSendable,
  readyAttachments,
  type ComposerDraft,
  type DraftAttachment,
} from "./attachments/model.js";
import { transferMessage } from "./attachments/transfer.js";
import { Chip, Composer, FixedChip } from "./Composer.js";
import { ConversationDrawer, ConversationListNotice } from "./ConversationDrawer.js";
import { ConversationHeader } from "./ConversationHeader.js";
import { pictureOf, type ConversationLogs } from "./conversation-log.js";
import { FirstUseCard, NotReadyCard } from "./FirstUseCard.js";
import { FolderPicker } from "./FolderPicker.js";
import { errorDetailWords, keyEnvHintIn, modelUnreachableHint, notAFolderPath } from "./broker-words.js";
import { folderName } from "./folder-name.js";
import { PassIcon } from "./icons.js";
import { enabledAgents, startingAgent } from "./agent-choice.js";
import { MessageList } from "./MessageList.js";
import { ModeMenu } from "./ModeMenu.js";
import { ModelMenu } from "./ModelMenu.js";
import { modelChipText, type ModelOfferView } from "./model-words.js";
import { PermissionCard } from "./PermissionCard.js";

type T = (key: string) => string;

const SCRATCH: ConversationFolder = { kind: "scratch" };

/**
 * 025 R-407: the model chip before a conversation starts - the offer the worker remembers for the
 * agent (`undefined`: nothing remembered yet, the chip says Default), the model and effort shown
 * (the owner's pick, else the remembered choice, else the agent's default) and what a choice does.
 */
type ModelChipState = {
  offer: ModelOfferView | undefined;
  model: string | undefined;
  effort: string | undefined;
  onChange: (change: { model: string } | { effort: string }) => void;
};
/** What the owner picked on the chip for one agent, before the start; the rest comes from the remembered choice. */
type ModelPick = { model?: string; effort?: string };

/**
 * 021 D-021-16: the agent keeps the mode its conversation started with (DeepSeek), so the chosen mode
 * goes with the start and the open conversation's chip offers no switch.
 */
const modeFixedOnceStarted = (agent: ConversationAgent): boolean =>
  (CONVERSATION_MODE_FIXED_AGENTS as readonly ConversationAgent[]).includes(agent);

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
  /** 022 FR-337: the message's ready attachments, held with its words and sent (or given back) with them. */
  attachments?: readonly DraftAttachment[];
};

/**
 * 022 FR-325 - FR-339: what the composer needs to take attachments - the shell's request and
 * capture, the viewed tab, and what the agent takes. Absent (a tab rendered without the shell's
 * request), the composer offers no attachments.
 */
type AttachSupport = {
  store: DraftStore;
  captureTab: CaptureTab;
  activeTabId?: number;
  activeTabUrl?: string;
  /** Starts the transfer of a message with attachments into an open conversation. */
  sendWithAttachments: (conversationId: string, draft: ComposerDraft, attachments: readonly DraftAttachment[]) => void;
};
/** A view's attachment support: the tab's, plus what this view's agent takes (R-344; unknown = all). */
type AttachProps = AttachSupport & { accepts: ConversationAccepts | undefined };

/** 022 R-343: a held attachment drawn as the bubble will draw it once sent. */
const summaryOf = (attachment: DraftAttachment): ConversationAttachmentSummary => ({
  kind: attachment.kind,
  name: attachment.name,
  size: attachment.size,
  ...(attachment.thumbnail === undefined ? {} : { thumbnail: attachment.thumbnail }),
  ...(attachment.tab?.cut === true ? { cut: true } : {}),
});

/**
 * 022 FR-325 - FR-341: the composer's attachment slots for one view - the chips, the "+" menu and
 * its entries (each disabled with its reason when it cannot be used), the refusal line, and the
 * files pasted or dropped. Nothing when the tab has no attachment support.
 */
function attachmentSlots(options: {
  attach: AttachProps | undefined;
  draftKey: string;
  draft: ComposerDraft;
  /** Held or on its way: nothing can be added or removed. */
  locked: boolean;
  agentName: string;
  t: T;
  focusBox: () => void;
}): Pick<Parameters<typeof Composer>[0], "attachments" | "attach" | "refusal" | "onFiles"> {
  const { attach, draftKey, draft, t } = options;
  if (attach === undefined) return {};
  const { store, accepts } = attach;
  const context = { accepts, agentName: options.agentName };
  const tabId = attach.activeTabId;
  const noTab = tabId === undefined ? t("conversation.attach.noTab") : undefined;
  const capture = (what: "screenshot" | "page") => () => {
    if (tabId === undefined) return;
    void addCapture(store, draftKey, what, {
      ...context,
      captureTab: attach.captureTab,
      tabId,
      screenshotName: t("conversation.attachment.screenshotName"),
      tabName: t("conversation.attachment.tabName"),
    });
  };
  const screenshotReason =
    noTab ?? (acceptsImages(accepts) ? undefined : t("conversation.attach.noImages").replace("{agent}", () => options.agentName));
  // 023 D-023-3, FR-365: an agent without page context gets the tab as a text file the broker writes
  // (R-366), so the entry is off only with no tab to use; a page the worker cannot read is refused
  // at capture, as for every agent.
  const tabReason = noTab;
  return {
    attachments: (
      <ComposerAttachments
        attachments={draft.attachments}
        t={t}
        locked={options.locked || draft.sending === true}
        onRemove={(localId) => {
          removeAttachment(store, draftKey, localId);
          // US1 scenario 4: the focus goes to the words.
          options.focusBox();
        }}
      />
    ),
    attach: (
      <AttachMenu
        t={t}
        disabled={options.locked || draft.sending === true}
        onFiles={(files) => addFiles(store, draftKey, files, context)}
        screenshot={{ ...(screenshotReason === undefined ? {} : { disabledReason: screenshotReason }), onChoose: capture("screenshot") }}
        tab={{ ...(tabReason === undefined ? {} : { disabledReason: tabReason }), onChoose: capture("page") }}
      />
    ),
    refusal: <AttachRefusal refusal={draft.refusal} t={t} />,
    ...(options.locked || draft.sending === true ? {} : { onFiles: (files: File[]) => addFiles(store, draftKey, files, context) }),
  };
}

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
 * Start, then send (FR-314): Send asks for `ui.conversation.start { agent, folder, mode? }` (a
 * non-strict mode chip choice goes with the start, 021 FR-361) and holds the words; once the
 * projection names a newly opened conversation as active, they go as `ui.conversation.send`. When the agent
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
  /** 022 FR-334: the viewed tab's address. Since 023 (FR-365) nothing in the tab decides on it any more. */
  activeTabUrl?: string;
  /**
   * 023 R-367, T728: the last reply to "Agent output" per conversation (lines the agent printed
   * about itself, scrubbed by the broker). Memory only, kept by the shell; absent until one came.
   */
  diagnostics?: Readonly<Record<string, readonly string[]>>;
  /** The last command's failure, when the worker reports one to the panel (T547). */
  lastError?: ConversationError;
  /** T606 (P2): shows the Connections & sites tab, where the helper's connection is checked. */
  onGoConnections?: () => void;
  /** 022 R-337: a command whose own answer is awaited (attachment pieces). Without it, no attachments. */
  request?: RequestCommand;
  /** 022 R-342: the viewed tab for "Screenshot of this tab" / "Attach this tab". */
  captureTab?: CaptureTab;
  /**
   * T633: the drafts and transfers the shell keeps above the tab switch, so showing Connections &
   * sites loses nothing. Absent (the tab rendered on its own), the tab keeps its own, given up when
   * it goes.
   */
  composer?: ComposerMemory;
}): ReactElement {
  const t: T = (key) => lookup(key, props.locale);
  const { conversation, send } = props;
  const ownMemory = useComposerMemory();
  const memory = props.composer ?? ownMemory;
  /** 022 US5: every conversation's unsent words and attachments, and the empty conversation's. */
  const drafts = memory.drafts;
  /** 022: transfers under way, by conversation - given up when the owner leaves it or the panel closes. */
  const transfers = memory.transfers;
  /**
   * The agent the owner put on the chip for the conversation they are writing; until then, and again
   * after it started, the owner's default (024 FR-384, R-380).
   */
  const [ownerAgent, setOwnerAgent] = useState<ConversationAgent | undefined>(undefined);
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
  /** 025 FR-401: the model and effort the owner picked on the chip, per agent; view state until Send. */
  const [modelPicks, setModelPicks] = useState<Partial<Record<ConversationAgent, ModelPick>>>({});
  // 022 US5: the empty conversation's words live in the draft store with its attachments.
  const newDraft = drafts.get(NEW_DRAFT_KEY);
  const draft = newDraft.text;
  const setDraft = (text: string): void => drafts.update(NEW_DRAFT_KEY, (current) => ({ ...current, text }));
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

  /**
   * 025 FR-401: what the model chip chose for this agent, whole (model and effort), when the owner
   * chose anything; otherwise nothing goes with the start and the broker applies the remembered choice.
   * An effort alone when no model is known (no default, nothing remembered): the agent keeps its own.
   */
  const pickedModel = (agent: ConversationAgent): ConversationModelWant | undefined => {
    const pick = modelPicks[agent];
    if (pick === undefined) return undefined;
    const remembered = availabilityOf(agent)?.models;
    const model = pick.model ?? remembered?.choice?.model ?? remembered?.offer.defaultModel;
    const effort = pick.effort ?? remembered?.choice?.effort;
    if (model === undefined && effort === undefined) return undefined;
    return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
  };

  const start = (agent: ConversationAgent, folder: ConversationFolder, mode: ConversationMode): void => {
    setHandledError(props.lastError);
    const known = new Set(conversation.conversations.map((entry) => entry.conversationId));
    setHeld((message) => (message === undefined ? undefined : { ...message, known }));
    const model = pickedModel(agent);
    // 021 FR-361: the chip's mode goes with the start, for every agent - a switch sent beside the first
    // message raced it (Hermes' restart refused `busy`, Claude's reload refusing the message). 025:
    // the model chip's choice goes the same way (FR-401).
    send({
      type: "ui.conversation.start",
      payload: { agent, folder, ...(mode === "strict" ? {} : { mode }), ...(model === undefined ? {} : { model }) },
    });
  };

  const startable = pendingStart !== undefined && availabilityOf(pendingStart.agent)?.availability === "ready" && consented;
  useEffect(() => {
    if (!startable || pendingStart === undefined) return;
    setPendingStart(undefined);
    start(pendingStart.agent, pendingStart.folder, held?.mode ?? "strict");
    // `start` reads this render's projection, which is the one that made the start possible.
  }, [startable, pendingStart]);

  const opened = conversation.active;
  const openedView = opened === undefined ? undefined : conversation.conversations.find((entry) => entry.conversationId === opened);
  const openedListed = openedView !== undefined;
  // 021: the broker lists a new conversation from the moment its start begins; the log is newer than the projection.
  const openedPicture = opened === undefined ? undefined : pictureOf(props.logs[opened] ?? []);
  const openedState = openedPicture?.state ?? openedView?.state;
  const openedCancelled = openedPicture?.stateCode === "start-cancelled";
  useEffect(() => {
    // The started conversation is open: its first message goes, once (FR-314) - not while it is still starting.
    if (held?.known === undefined || opened === undefined || !openedListed || held.known.has(opened)) return;
    // A new conversation's run that is killed or fails while starting says `gone` before the start ends
    // (start-cancelled, or the start's refusal): nothing was started, so the words wait for that end.
    if (openedState === "starting" || openedState === "gone") return;
    if (openedCancelled) {
      // The owner stopped the start: nothing was started, the words go back to the new conversation's box.
      giveBack();
      setPendingStart(undefined);
      setComposing(true);
      return;
    }
    setHeld(undefined);
    setDraft("");
    // FR-361: the mode went with the start; nothing is switched beside the first message.
    // T701: the choice was that conversation's - the next new one starts strict (D-019 default).
    setNewMode("strict");
    // 025: the model chip's pick was that conversation's too; the next one shows the remembered choice.
    setModelPicks({});
    // 024: likewise the agent - the next new conversation starts on the owner's default again.
    setOwnerAgent(undefined);
    if (held.attachments !== undefined && held.attachments.length > 0 && attachSupport !== undefined) {
      // 022 FR-337, R-338: the attachments leave now that the conversation exists, then the words.
      drafts.update(NEW_DRAFT_KEY, (current) => ({ ...current, attachments: [] }));
      attachSupport.sendWithAttachments(opened, { text: held.text, attachments: held.attachments }, held.attachments);
      return;
    }
    send({
      type: "ui.conversation.send",
      payload: {
        conversationId: opened,
        text: held.text,
        ...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId }),
      },
    });
  }, [held, opened, openedListed, openedState, openedCancelled]);

  useEffect(() => {
    // A refused start or consent gives the words back; while the first-use card is up nothing has left yet.
    if (freshError === undefined || asking || held === undefined) return;
    giveBack();
    setPendingStart(undefined);
  }, [freshError, asking, held]);

  /** The held words were not sent: they go back into the box (T606 A2) and the hold ends. */
  function giveBack(): void {
    // 022 FR-337: the attachments come back with the words.
    if (held !== undefined) {
      drafts.update(NEW_DRAFT_KEY, (current) => ({
        ...current,
        text: held.text,
        attachments: held.bubble === true && held.attachments !== undefined ? [...held.attachments, ...current.attachments] : current.attachments,
      }));
    }
    setHeld(undefined);
  }

  /**
   * 022 R-337: a message with attachments, into an open conversation: the composer holds it while the
   * pieces leave; sent, the box is emptied; refused or given up, the words and chips stay with the
   * refusal under them (nothing was sent).
   */
  const sendWithAttachments = (conversationId: string, message: ComposerDraft, attachments: readonly DraftAttachment[]): void => {
    const request = props.request;
    if (request === undefined) return;
    transfers.get(conversationId)?.abort();
    const controller = new AbortController();
    transfers.set(conversationId, controller);
    drafts.update(conversationId, (current) => {
      const { refusal: _cleared, ...rest } = current;
      // The held first message arrives here with its own words and chips (the box was the new one's).
      const carried = current.attachments.some((attachment) => attachments.includes(attachment))
        ? current.attachments
        : [...attachments, ...current.attachments];
      return { ...rest, text: message.text, attachments: carried, sending: true };
    });
    void transferMessage({
      conversationId,
      text: message.text,
      attachments,
      ...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId }),
      request,
      signal: controller.signal,
    }).then((outcome) => {
      if (transfers.get(conversationId) === controller) transfers.delete(conversationId);
      drafts.update(conversationId, (current) => {
        const { refusal: _cleared, sending: _done, ...rest } = current;
        if (outcome.ok) {
          return { ...rest, text: "", attachments: current.attachments.filter((attachment) => !attachments.includes(attachment)) };
        }
        return { ...rest, refusal: outcome.refusal };
      });
    });
  };

  useEffect(() => {
    // 022 (S1 review): leaving a conversation gives up its transfer; what began is cancelled.
    for (const [conversationId, controller] of transfers) {
      if (conversationId !== conversation.active) controller.abort();
    }
  }, [conversation.active]);
  useEffect(() => {
    // Only the tab's own transfers (none when the shell keeps them): a tab switch gives up nothing.
    const running = ownMemory.transfers;
    return () => {
      for (const controller of running.values()) controller.abort();
    };
  }, []);
  // T633: a conversation removed (gone from the list) takes its draft with it.
  const listed = conversation.available
    ? [...conversation.conversations.map((entry) => entry.conversationId), ...(conversation.active === undefined ? [] : [conversation.active])].join(" ")
    : undefined;
  useEffect(() => {
    if (listed !== undefined) pruneDrafts(drafts, new Set(listed.split(" ")));
  }, [listed]);

  const attachSupport: AttachSupport | undefined =
    props.request === undefined || props.captureTab === undefined
      ? undefined
      : {
          store: drafts,
          captureTab: props.captureTab,
          ...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId }),
          ...(props.activeTabUrl === undefined ? {} : { activeTabUrl: props.activeTabUrl }),
          sendWithAttachments,
        };

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
        {...(availabilityOf(view.agent)?.models === undefined ? {} : { rememberedOffer: availabilityOf(view.agent)!.models!.offer })}
        t={t}
        send={send}
        {...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId })}
        {...(freshError === undefined ? {} : { error: freshError })}
        {...actionFor(freshError)}
        draft={drafts.get(view.conversationId)}
        onDraft={(text) => drafts.update(view.conversationId, (current) => ({ ...current, text }))}
        {...(props.diagnostics?.[view.conversationId] === undefined ? {} : { output: props.diagnostics[view.conversationId] })}
        {...(attachSupport === undefined
          ? {}
          : { attach: { ...attachSupport, accepts: view.accepts ?? availabilityOf(view.agent)?.accepts } })}
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
  // 024 FR-384, R-380: the agents the owner switched on, and the default a new conversation starts on.
  // What the owner put on the chip holds only while that agent stays enabled; the settings page
  // changing the choices arrives in the projection and is followed at once.
  const enabled = enabledAgents(conversation.choices);
  const agent = ownerAgent !== undefined && enabled.includes(ownerAgent) ? ownerAgent : startingAgent(conversation.choices, conversation.agents);
  /** FR-384: the settings page at one agent's card - the picker's reason link and the note above the box. */
  const openSettings = (target: ConversationAgent | undefined): void =>
    send({ type: "ui.agent.open-settings", payload: { route: target === undefined ? "#agents" : `#agents/${target}` } });

  // 025 FR-400, US4: the chip shows what the worker remembers for the agent on the chip - its offer and
  // last choice - and none when the agent is known to report no models; with nothing remembered it
  // says Default. A pick is kept per agent, so going back to an agent finds it as it was left.
  const rememberedModels = availabilityOf(agent)?.models;
  const modelPick = modelPicks[agent];
  const modelChip: ModelChipState | undefined =
    rememberedModels !== undefined && rememberedModels.offer.models.length === 0
      ? undefined
      : {
          offer: rememberedModels?.offer,
          model: modelPick?.model ?? rememberedModels?.choice?.model ?? rememberedModels?.offer.defaultModel,
          effort: modelPick?.effort ?? rememberedModels?.choice?.effort ?? rememberedModels?.offer.defaultEffort,
          onChange: (change) => setModelPicks((picks) => ({ ...picks, [agent]: { ...picks[agent], ...change } })),
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
      enabled={enabled}
      folder={folder}
      folders={conversation.folders}
      mode={newMode}
      {...(modelChip === undefined ? {} : { modelChip })}
      draft={draft}
      composerDraft={newDraft}
      {...(attachSupport === undefined ? {} : { attach: { ...attachSupport, accepts: availabilityOf(agent)?.accepts } })}
      held={held !== undefined}
      {...(held?.bubble === true ? { heldWords: held.text, heldAttachments: held.attachments ?? [] } : {})}
      asking={asking}
      {...(freshError === undefined ? {} : { error: freshError })}
      {...actionFor(freshError)}
      send={send}
      onAgent={setOwnerAgent}
      onOpenSettings={openSettings}
      onFolder={setPickedFolder}
      onMode={setNewMode}
      onDraft={setDraft}
      onSend={() => {
        setHandledError(props.lastError);
        // 022 FR-337: the ready attachments are held with the words.
        const attachments = readyAttachments(newDraft);
        const withAttachments = attachments.length === 0 ? {} : { attachments };
        if (availabilityOf(agent)?.availability === "ready" && consented) {
          setHeld({ text: draft, mode: newMode, ...withAttachments });
          start(agent, folder, newMode);
        } else {
          // FR-314: the first-use card first. T606 (A2): the words wait as a faded bubble, the box empty.
          setHeld({ text: draft, mode: newMode, bubble: true, ...withAttachments });
          drafts.update(NEW_DRAFT_KEY, (current) => ({
            ...current,
            text: "",
            attachments: current.attachments.filter((attachment) => !attachments.includes(attachment)),
          }));
          setAsking(true);
        }
      }}
      onAccept={() => {
        // FR-299: the one-time consent, on the owner's press; the start waits for the worker to report it.
        setAsking(false);
        setHandledError(props.lastError);
        setPendingStart({ agent, folder });
        send({ type: "ui.conversation.consent", payload: { granted: true } });
      }}
      onCancel={() => {
        setAsking(false);
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
  /** 024 R-380: the agents the owner switched on - the picker lists these. */
  enabled: readonly ConversationAgent[];
  folder: ConversationFolder;
  folders: ConversationPanelState["folders"];
  mode: ConversationMode;
  /** 025: the model chip's state; absent when the agent is known to report no models. */
  modelChip?: ModelChipState;
  draft: string;
  /** 022: the empty conversation's whole draft - the words and the attachments. */
  composerDraft: ComposerDraft;
  /** 022: attachments, when the shell supports them. */
  attach?: AttachProps;
  /** The words are held for a start under way (or a card's answer). */
  held: boolean;
  /** T606 (A2): the words held for a first use, shown as a faded bubble while the box is empty. */
  heldWords?: string;
  /** 022 FR-337: the attachments held with them. */
  heldAttachments?: readonly DraftAttachment[];
  asking: boolean;
  error?: ConversationError;
  errorAction?: NoticeAction;
  send: SendCommand;
  onAgent: (agent: ConversationAgent) => void;
  /** 024 FR-384: the settings page at an agent's card (`undefined`: at the agents section). */
  onOpenSettings: (agent: ConversationAgent | undefined) => void;
  onFolder: (folder: ConversationFolder) => void;
  onMode: (mode: ConversationMode) => void;
  onDraft: (text: string) => void;
  onSend: () => void;
  onAccept: () => void;
  onCancel: () => void;
}): ReactElement {
  const { t, agent } = props;
  const [opened, setOpened] = useState<"agent" | "folder" | "mode" | "model" | undefined>(undefined);
  const section = useRef<HTMLElement>(null);
  const agentChip = useRef<HTMLButtonElement>(null);
  const modeChip = useRef<HTMLButtonElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const ids = { agent: useId(), folder: useId(), mode: useId(), model: useId() };
  const modelState = props.modelChip;
  const modelText = modelState === undefined ? "" : modelChipText(modelState.offer, modelState, t);
  const name = props.agentName(agent);
  const entry = props.agents.find((candidate) => candidate.agent === agent);
  // 024 FR-384: an agent that is not ready - not installed, still to be downloaded, a version that does
  // not fit, not reported yet - or that the owner switched off cannot be sent to (FR-301, FR-313).
  const reachable = entry?.availability === "ready" && props.enabled.includes(agent);
  const holding = props.held || props.asking;
  // 022 FR-336: words or a ready attachment, and nothing still being prepared.
  const sendable = draftSendable(props.composerDraft) && reachable;
  const toggle = (which: "agent" | "folder" | "mode" | "model") => setOpened((current) => (current === which ? undefined : which));
  const closeAgentMenu = (): void => {
    setOpened(undefined);
    agentChip.current?.focus();
  };
  // T607 (A1): a project folder is its name; the whole path is the hover (and the chooser's row).
  const folderText = props.folder.kind === "scratch" ? t("conversation.folder.scratch") : folderName(props.folder.path);
  const folderPath = props.folder.kind === "project" ? props.folder.path : undefined;

  let above: ReactElement | null = null;
  if (props.asking) {
    above = (
      <FirstUseCard
        agentName={name}
        agent={agent}
        {...(entry?.notes === undefined ? {} : { notes: entry.notes })}
        t={t}
        onAccept={props.onAccept}
        onCancel={props.onCancel}
      />
    );
  } else if (!reachable) {
    // 024 FR-384: one line saying why, and the way to the agent's card; nothing is downloaded from here.
    above = (
      <NotReadyCard
        entry={entry}
        agentName={name}
        t={t}
        onOpenSettings={() => props.onOpenSettings(props.enabled.includes(agent) ? agent : undefined)}
      />
    );
  } else if (props.held) {
    // 021 FR-354: which agent is starting, and for DeepSeek that the first start is slow. Cancel comes
    // with the open conversation once the broker lists it (it does from the start); Stop names a conversation.
    above = <StartingLine agent={agent} agentName={name} t={t} />;
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
      {props.error === undefined ? null : (
        <ErrorNotice error={props.error} t={t} agent={agent} {...(props.errorAction === undefined ? {} : { action: props.errorAction })} />
      )}
      {props.heldWords === undefined ? (
        <Welcome t={t} {...(holding ? {} : { onSuggest: suggest })} />
      ) : (
        // T606 (A2): the words wait where the conversation will be, faded until they are sent.
        <div className="agent-conversation-held">
          <div className="agent-conversation-message" data-message-role="owner" data-held="">
            <span className="agent-conversation-who agent-sr-only">{t("conversation.role.owner")}</span>
            {props.heldWords === "" ? null : <p>{props.heldWords}</p>}
            {props.heldAttachments === undefined || props.heldAttachments.length === 0 ? null : (
              <SentAttachments attachments={props.heldAttachments.map(summaryOf)} t={t} />
            )}
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
        {...attachmentSlots({
          attach: props.attach,
          draftKey: NEW_DRAFT_KEY,
          draft: props.composerDraft,
          locked: holding,
          agentName: name,
          t,
          focusBox: () => section.current?.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")?.focus(),
        })}
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
            {modelState === undefined ? null : (
              <Chip
                kind="model"
                ref={modelChipRef}
                label={t("conversation.chip.model").replace("{model}", () => modelText)}
                text={modelText}
                expanded={opened === "model"}
                controls={ids.model}
                disabled={holding}
                onToggle={() => toggle("model")}
              />
            )}
          </>
        }
        popup={
          opened === "agent" && !holding ? (
            <AgentMenu
              id={ids.agent}
              agents={props.agents}
              enabled={props.enabled}
              selected={agent}
              agentName={props.agentName}
              t={t}
              onChoose={(next) => {
                props.onAgent(next);
                closeAgentMenu();
              }}
              onOpenSettings={(target) => {
                props.onOpenSettings(target);
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
              agentName={name}
              mode={props.mode}
              t={t}
              onChange={props.onMode}
              onClose={() => {
                setOpened(undefined);
                modeChip.current?.focus();
              }}
              onDismiss={() => setOpened(undefined)}
            />
          ) : opened === "model" && !holding && modelState !== undefined ? (
            <ModelMenu
              id={ids.model}
              t={t}
              offer={modelState.offer}
              model={modelState.model}
              effort={modelState.effort}
              onChange={modelState.onChange}
              onClose={() => {
                setOpened(undefined);
                modelChipRef.current?.focus();
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
function ErrorNotice(props: { error: ConversationError; t: T; action?: NoticeAction; agent?: ConversationAgent }): ReactElement {
  const known = (CONVERSATION_ERROR_CODES as readonly string[]).includes(props.error.code);
  const { code, detail } = props.error;
  // T608 (J5, J6): two refusals of the folder chooser are said whole in the panel's words. The
  // dialog that cannot open is its title alone (the broker's sentence only repeats it in English);
  // a typed path that is no folder names that path, not the conversation's own folder.
  const typed = code === "folder-missing" ? notAFolderPath(detail) : undefined;
  // T609: every other template of the broker's is said from the locale, or left out when it only repeats the title.
  // 023 FR-373: a failed first start's key hint is said in the panel's words, apart from the rest.
  const keyHint = code === "agent-model-unreachable" ? keyEnvHintIn(detail, props.t) : undefined;
  const rest = keyHint?.rest ?? detail;
  const said = code === "path-entry" || rest === "" ? undefined : errorDetailWords(rest, props.t);
  const hint = code === "agent-model-unreachable" ? modelUnreachableHint(props.agent, props.t) : undefined;
  return (
    <div className="agent-conversation-notice" role="status" data-notice-code={code}>
      {typed !== undefined ? (
        <p>{props.t("conversation.folders.notFound").replace("{path}", () => typed)}</p>
      ) : (
        <>
          {known ? <p>{props.t(`conversation.error.${code}`)}</p> : null}
          {said === undefined ? null : <p className="agent-conversation-detail">{said}</p>}
          {keyHint === undefined ? null : <p className="agent-conversation-detail">{keyHint.words}</p>}
          {/* 021 FR-355: where the agent's own setting lives - never a key field. */}
          {hint === undefined ? null : <p className="agent-conversation-detail">{hint}</p>}
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

/**
 * 021 FR-354, R-354: a conversation whose agent is starting says which one, adds that the first
 * start of DeepSeek can take a few minutes, and - where the conversation is known to the broker -
 * offers Cancel, which sends the same stop a running turn gets and ends the start.
 */
function StartingLine(props: { agent: ConversationAgent; agentName: string; t: T; onCancel?: () => void }): ReactElement {
  const { t } = props;
  const fill = (key: string): string => t(key).replace("{agent}", () => props.agentName);
  return (
    <div className="agent-conversation-state agent-conversation-starting" aria-live="polite">
      {/* 023 D-023-5, R-370: DeepSeek keeps its longer sentence; every other agent says its 30-60 s in the line itself. */}
      <p>{fill(props.agent === "deepseek" ? "conversation.state.starting" : "conversation.state.startingTimed")}</p>
      {props.agent === "deepseek" ? <p>{t("conversation.state.startingSlow")}</p> : null}
      {props.onCancel === undefined ? null : (
        <button type="button" aria-label={fill("conversation.state.cancelStartLabel")} onClick={props.onCancel}>
          {t("conversation.state.cancelStart")}
        </button>
      )}
    </div>
  );
}

function OpenConversation(props: {
  view: ConversationView;
  logs: ConversationLogs;
  agentName: string;
  /** 025 R-407: the agent's remembered offer, for the names of a stopped conversation's model. */
  rememberedOffer?: ModelOfferView;
  t: T;
  send: SendCommand;
  activeTabId?: number;
  error?: ConversationError;
  errorAction?: NoticeAction;
  /** FR-321: the list button and the new-conversation button (FR-315). */
  header: HeaderControls;
  /** T606 (P1): takes this conversation off the list (the drawer's Remove). */
  onRemove: () => void;
  /** 022 US5: this conversation's unsent words and attachments, kept by the tab per conversation. */
  draft: ComposerDraft;
  onDraft: (text: string) => void;
  /** 023 T728: the last reply to "Agent output" for this conversation, when one came. */
  output?: readonly string[];
  /** 022: attachments, when the shell supports them. */
  attach?: AttachProps;
}): ReactElement {
  const { t, view, send } = props;
  const endedId = useId();
  const section = useRef<HTMLElement>(null);
  const conversationId = view.conversationId;
  const draft = props.draft.text;
  const setDraft = props.onDraft;
  const [modeOpen, setModeOpen] = useState(false);
  const modeChip = useRef<HTMLButtonElement>(null);
  const modeMenuId = useId();
  const modeFixedId = useId();
  const [modelOpen, setModelOpen] = useState(false);
  const modelChip = useRef<HTMLButtonElement>(null);
  const modelMenuId = useId();
  const modelBusyId = useId();
  // 021 D-021-16: DeepSeek keeps the mode its conversation started with; the chip shows it, offers nothing.
  const modeFixed = modeFixedOnceStarted(view.agent);
  const picture = pictureOf(props.logs[conversationId] ?? []);
  const mode = picture.mode ?? view.mode;
  const state = picture.state ?? view.state;
  const busy = BUSY_STATES.has(state);
  const waiting = picture.permissions.length > 0;
  // 025 FR-403, FR-398: the running agent's offer and what it reports now, while it runs; a conversation
  // that is not running shows the model it was left on (the entry's), by the names the agent last offered.
  const liveModels = view.models !== undefined && view.models.models.length > 0 ? view.models : undefined;
  const modelBusy = busy || waiting;
  const modelText =
    liveModels !== undefined
      ? modelChipText(liveModels, liveModels.current, t)
      : view.model === undefined
        ? undefined
        : modelChipText(props.rememberedOffer, view.model, t);
  // The command's refusal of a change is the log's notice (FR-405): it is not said a second time here.
  const shownError = props.error?.code === "model-refused" ? undefined : props.error;
  // The live line names what waits: the card's title, or (blank title) its detail's first line.
  const first = picture.permissions[0];
  const waitingWords = first === undefined ? undefined : actionWords(first.title, t, first.detail);
  // T606 (P1): the agent cleared its record of this conversation; it can be looked at, not continued.
  // T692: a first start under way is listed not resumable too (it has no session yet) - it has not ended.
  const ended = !view.resumable && view.state !== "starting";
  // T607 (K1): the crash notice in the log already says it; the line under the log does not repeat it.
  const crashSaid = picture.timeline.some((item) => item.kind === "notice" && item.notice.code === "agent-exited");
  // 022 FR-336: words or a ready attachment, nothing still being prepared, nothing on its way.
  const sendable = draftSendable(props.draft) && !waiting && !ended && state !== "running" && state !== "waiting-for-owner";
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
    const attachments = readyAttachments(props.draft);
    if (attachments.length > 0 && props.attach !== undefined) {
      // 022 R-337: the attachments leave first, piece by piece; the words go with the send that names them.
      props.attach.sendWithAttachments(conversationId, props.draft, attachments);
      return;
    }
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
    <section ref={section} className="agent-conversation" data-conversation-id={conversationId} inert={props.header.drawerOpen}>
      <ConversationHeader
        {...props.header}
        // 023 T728 (FR-372): asked for only when the owner opens it.
        output={{
          lines: props.output,
          onRequest: () => send({ type: "ui.conversation.diagnostics", payload: { conversationId } }),
        }}
        details={{
          title,
          agentName: props.agentName,
          folder: view.folder.kind === "scratch" ? t("conversation.folder.scratch") : folderName(view.folder.path),
          ...(view.folder.kind === "project" ? { folderPath: view.folder.path } : {}),
        }}
      />
      {/* The broker's own words about the mode it set, if it had any (inert text). */}
      {picture.modeNote === undefined ? null : <p className="agent-conversation-detail">{picture.modeNote}</p>}
      {shownError === undefined ? null : (
        <ErrorNotice error={shownError} t={t} agent={view.agent} {...(props.errorAction === undefined ? {} : { action: props.errorAction })} />
      )}
      {/* 021 FR-357: the agent continues this conversation without replaying it. */}
      {view.replay === "none" && !ended ? (
        <p role="note" className="agent-conversation-detail agent-conversation-replay-note">
          {t("conversation.noReplay").replace("{agent}", () => props.agentName)}
        </p>
      ) : null}
      {/* Keyed by conversation: another one opened shows its own end (T602). */}
      {ended && picture.timeline.length === 0 ? null : (
        <MessageList
          key={conversationId}
          timeline={picture.timeline}
          agentName={props.agentName}
          agent={view.agent}
          t={t}
          state={state}
          // T606 (C3): the live line says what waits for the owner.
          waitingFor={waitingWords}
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
      {state === "starting" && !ended ? (
        // 021 FR-354: which agent, the slow first start, and Cancel - it stops the start.
        <StartingLine
          agent={view.agent}
          agentName={props.agentName}
          t={t}
          onCancel={() => send({ type: "ui.conversation.stop", payload: { conversationId } })}
        />
      ) : SPOKEN_STATES.has(state) && !ended && !(state === "crashed" && crashSaid) ? (
        <p className={QUIET_STATES.has(state) ? "agent-conversation-state agent-sr-only" : "agent-conversation-state"} aria-live="polite">
          {t(state === "stopped" && picture.stateCode === "start-cancelled" ? "conversation.state.start-cancelled" : `conversation.state.${state}`)}
        </p>
      ) : null}
      <Composer
        t={t}
        label={t("conversation.composer.label").replace("{agent}", () => props.agentName)}
        draft={draft}
        onDraft={setDraft}
        sendable={sendable}
        onSend={submit}
        {...(props.draft.sending === true ? { readOnly: true } : {})}
        {...(ended ? { disabled: true, placeholder: t("conversation.cannotResume.placeholder") } : {})}
        {...attachmentSlots({
          attach: ended ? undefined : props.attach,
          draftKey: conversationId,
          draft: props.draft,
          locked: false,
          agentName: props.agentName,
          t,
          focusBox: () => section.current?.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")?.focus(),
        })}
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
            {/* FR-292, FR-320: the mode stays switchable, from its chip - except D-021-16's. */}
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
              {...(modeFixed ? { unavailable: { describedBy: modeFixedId } } : {})}
              onToggle={() => {
                setModelOpen(false);
                setModeOpen((open) => !open);
              }}
            />
            {/* 025 FR-398, FR-403: the model chip - open between turns, shown but not open while one runs. */}
            {modelText === undefined ? null : (
              <Chip
                kind="model"
                ref={modelChip}
                label={t("conversation.chip.model").replace("{model}", () => modelText)}
                text={modelText}
                expanded={modelOpen && liveModels !== undefined && !modelBusy}
                controls={modelMenuId}
                // Not running: what the conversation was left on, not offered until it runs again.
                disabled={liveModels === undefined || ended}
                {...(liveModels !== undefined && modelBusy ? { unavailable: { describedBy: modelBusyId } } : {})}
                onToggle={() => {
                  setModeOpen(false);
                  setModelOpen((open) => !open);
                }}
              />
            )}
          </>
        }
        popup={
          modelOpen && liveModels !== undefined && !modelBusy && !modeOpen ? (
            <ModelMenu
              id={modelMenuId}
              t={t}
              offer={liveModels}
              model={liveModels.current.model}
              effort={liveModels.current.effort}
              onChange={(change) => send({ type: "ui.conversation.set-model", payload: { conversationId, ...change } })}
              onClose={() => {
                setModelOpen(false);
                modelChip.current?.focus();
              }}
              onDismiss={() => setModelOpen(false)}
            />
          ) : modeOpen && !modeFixed ? (
            <ModeMenu
              id={modeMenuId}
              agent={view.agent}
              agentName={props.agentName}
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
          <>
            {modeFixed ? (
              <p id={modeFixedId} className="agent-conversation-note">
                {t("conversation.mode.fixedNote").replace("{agent}", () => props.agentName)}
              </p>
            ) : !modeOpen && view.agent === "codex" && mode === "strict" ? (
              // FR-293: a disclosure stays on screen; with the menu open it sits under the strict choice.
              <p className="agent-conversation-note">{t("conversation.mode.codexStrictNote")}</p>
            ) : null}
            {/* 025 FR-403: why the model chip is not open, and when it will be (its accessible description). */}
            {liveModels !== undefined && modelBusy ? (
              <p id={modelBusyId} className="agent-conversation-note agent-conversation-model-note">
                {t("conversation.model.busy")}
              </p>
            ) : null}
          </>
        }
      />
    </section>
  );
}

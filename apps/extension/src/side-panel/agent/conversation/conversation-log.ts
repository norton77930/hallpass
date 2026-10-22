import type {
  ConversationAttachmentSummary,
  ConversationEvent,
  ConversationEventPayload,
  ConversationMode,
  ConversationState,
} from "@hallpass/contracts";

/**
 * 019 T546 - what the panel was told about each conversation, and the picture drawn from it.
 *
 * The panel keeps the events it was sent in this document's memory and nothing else (D-019-6): no
 * storage, no copy in the worker. The picture is recomputed from the events each render, so two
 * panel documents fed the same events show the same thing (FR-288).
 */

export type ConversationLogEntry = { seq: number; event: ConversationEvent };
export type ConversationLogs = Readonly<Record<string, readonly ConversationLogEntry[]>>;

/**
 * One forwarded event added to its conversation, in `seq` order. A seq already kept is a repeat (a
 * page re-sent after a reconnect) and is dropped. A seq below the last one kept is not: the page
 * the worker asked for after a gap (T547, R-318) arrives after the live events that showed the
 * gap, and its events go where their seq puts them.
 */
export function appendLogEntry(logs: ConversationLogs, payload: ConversationEventPayload): ConversationLogs {
  const current = logs[payload.conversationId] ?? [];
  const entry = { seq: payload.seq, event: payload.event };
  const last = current[current.length - 1];
  if (last === undefined || payload.seq > last.seq) {
    return { ...logs, [payload.conversationId]: [...current, entry] };
  }
  const at = current.findIndex((kept) => kept.seq >= payload.seq);
  if (current[at]!.seq === payload.seq) return logs;
  return { ...logs, [payload.conversationId]: [...current.slice(0, at), entry, ...current.slice(at)] };
}

type ToolEvent = Extract<ConversationEvent, { type: "tool" }>;
type PermissionEvent = Extract<ConversationEvent, { type: "permission" }>;
type NoticeEvent = Extract<ConversationEvent, { type: "notice" }>;
type PermissionClosedEvent = Extract<ConversationEvent, { type: "permission-closed" }>;

export type TimelineItem =
  /** 022 R-343: the owner's message may carry its attachments (as the broker summed them up). */
  | { kind: "text"; key: string; role: "agent" | "owner"; text: string; attachments?: ConversationAttachmentSummary[] }
  | { kind: "actions"; key: string; actions: ToolEvent[] }
  | { kind: "notice"; key: string; notice: NoticeEvent }
  /** 020 FR-319: how a card this panel showed was closed, as the broker reported it. */
  | { kind: "answer"; key: string; title: string; answer: PermissionClosedEvent["answer"] };

export type ConversationPicture = {
  timeline: TimelineItem[];
  /** Cards still waiting for the owner, oldest first (FR-290, FR-294: they wait, never expire). */
  permissions: PermissionEvent[];
  /** The latest the broker said, if it said anything yet. */
  mode?: ConversationMode;
  modeNote?: string;
  state?: ConversationState;
  /** 021 R-354: the stop was the owner ending a start that was still under way. */
  stateCode?: "start-cancelled";
};

/**
 * The events in order, folded into what is on screen: consecutive text from the same speaker is one
 * message that grows as it streams (FR-285); an action keeps its first place and takes its latest
 * status (FR-287); a card leaves when the broker says it closed, whoever answered it (FR-288), and
 * leaves one line saying how (020 FR-319).
 */
export function pictureOf(entries: readonly ConversationLogEntry[]): ConversationPicture {
  const timeline: TimelineItem[] = [];
  const actionSlots = new Map<string, { item: Extract<TimelineItem, { kind: "actions" }>; index: number }>();
  const permissions = new Map<string, PermissionEvent>();
  const picture: ConversationPicture = { timeline, permissions: [] };
  for (const { seq, event } of entries) {
    switch (event.type) {
      case "text": {
        const last = timeline[timeline.length - 1];
        if (last?.kind === "text" && last.role === event.role) {
          last.text += event.text;
          if (event.attachments !== undefined) last.attachments = [...(last.attachments ?? []), ...event.attachments];
        } else {
          timeline.push({
            kind: "text",
            key: `text-${seq}`,
            role: event.role,
            text: event.text,
            ...(event.attachments === undefined ? {} : { attachments: [...event.attachments] }),
          });
        }
        break;
      }
      case "tool": {
        const slot = actionSlots.get(event.toolCallId);
        if (slot !== undefined) {
          slot.item.actions[slot.index] = event;
          break;
        }
        let last = timeline[timeline.length - 1];
        if (last?.kind !== "actions") {
          last = { kind: "actions", key: `actions-${seq}`, actions: [] };
          timeline.push(last);
        }
        last.actions.push(event);
        actionSlots.set(event.toolCallId, { item: last, index: last.actions.length - 1 });
        break;
      }
      case "permission":
        permissions.set(event.requestId, event);
        break;
      case "permission-closed": {
        // 020 FR-319: the answer stays as one line where the conversation stood when it came -
        // the broker's own word for how the card ended, whichever panel document answered it.
        const closed = permissions.get(event.requestId);
        if (closed !== undefined) {
          timeline.push({ kind: "answer", key: `answer-${seq}`, title: closed.title, answer: event.answer });
        }
        permissions.delete(event.requestId);
        break;
      }
      case "mode":
        picture.mode = event.mode;
        if (event.note === undefined) delete picture.modeNote;
        else picture.modeNote = event.note;
        break;
      case "state":
        picture.state = event.state;
        if (event.code === undefined) delete picture.stateCode;
        else picture.stateCode = event.code;
        break;
      case "notice":
        timeline.push({ kind: "notice", key: `notice-${seq}`, notice: event });
        break;
    }
  }
  picture.permissions = [...permissions.values()];
  return picture;
}

/** 020 FR-318: one turn's actions, as the conversation shows them. */
export type TurnActionGroup = {
  kind: "turn-actions";
  key: string;
  /** The turn is the last one and the conversation says it is still under way. */
  running: boolean;
  /** What the turn did that did not go wrong, in order - the "N steps". */
  steps: ToolEvent[];
  /** Failed and refused actions, never folded away. */
  problems: ToolEvent[];
  /** While the turn runs: the newest running action, else the newest still waiting to start. */
  live?: ToolEvent;
};
export type TurnTimelineItem = Exclude<TimelineItem, { kind: "actions" }> | TurnActionGroup;

const isProblem = (action: ToolEvent): boolean => action.status === "failed" || action.status === "refused";

/**
 * 020 T594, R-334: a turn is everything between one owner message and the next. Every action of a
 * turn goes into one group, placed where the turn's last actions were, so the turn's closing words
 * follow it; the group keeps the key of the turn's first actions, so it does not remount as the turn
 * grows. Only the last turn can be running, and only while `turnUnderWay`.
 */
export function groupTurns(timeline: readonly TimelineItem[], turnUnderWay: boolean): TurnTimelineItem[] {
  const turns: TimelineItem[][] = [[]];
  for (const item of timeline) {
    if (item.kind === "text" && item.role === "owner") turns.push([]);
    turns[turns.length - 1]!.push(item);
  }
  const out: TurnTimelineItem[] = [];
  turns.forEach((turn, index) => {
    const batches = turn.filter((item): item is Extract<TimelineItem, { kind: "actions" }> => item.kind === "actions");
    const lastBatch = batches[batches.length - 1];
    const running = turnUnderWay && index === turns.length - 1;
    for (const item of turn) {
      if (item.kind !== "actions") {
        out.push(item);
        continue;
      }
      if (item !== lastBatch) continue;
      const actions = batches.flatMap((batch) => batch.actions);
      const group: TurnActionGroup = {
        kind: "turn-actions",
        key: batches[0]!.key,
        running,
        steps: actions.filter((action) => !isProblem(action)),
        problems: actions.filter(isProblem),
      };
      if (running) {
        const newest = (status: ToolEvent["status"]) => [...actions].reverse().find((action) => action.status === status);
        const live = newest("running") ?? newest("pending");
        if (live !== undefined) group.live = live;
      }
      out.push(group);
    }
  });
  return out;
}

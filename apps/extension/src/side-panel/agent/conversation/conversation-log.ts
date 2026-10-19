import type {
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

export type TimelineItem =
  | { kind: "text"; key: string; role: "agent" | "owner"; text: string }
  | { kind: "actions"; key: string; actions: ToolEvent[] }
  | { kind: "notice"; key: string; notice: NoticeEvent };

export type ConversationPicture = {
  timeline: TimelineItem[];
  /** Cards still waiting for the owner, oldest first (FR-290, FR-294: they wait, never expire). */
  permissions: PermissionEvent[];
  /** The latest the broker said, if it said anything yet. */
  mode?: ConversationMode;
  modeNote?: string;
  state?: ConversationState;
};

/**
 * The events in order, folded into what is on screen: consecutive text from the same speaker is one
 * message that grows as it streams (FR-285); an action keeps its first place and takes its latest
 * status (FR-287); a card leaves when the broker says it closed, whoever answered it (FR-288).
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
        } else {
          timeline.push({ kind: "text", key: `text-${seq}`, role: event.role, text: event.text });
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
      case "permission-closed":
        permissions.delete(event.requestId);
        break;
      case "mode":
        picture.mode = event.mode;
        if (event.note === undefined) delete picture.modeNote;
        else picture.modeNote = event.note;
        break;
      case "state":
        picture.state = event.state;
        break;
      case "notice":
        timeline.push({ kind: "notice", key: `notice-${seq}`, notice: event });
        break;
    }
  }
  picture.permissions = [...permissions.values()];
  return picture;
}
